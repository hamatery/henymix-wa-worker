import http from 'http';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

// 1. Keep-alive HTTP health server for Render
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Henymix WhatsApp Worker is running\n');
  })
  .listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

// 2. Supabase client setup
const rawUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = rawUrl.startsWith('http')
  ? rawUrl
  : 'https://syxibiyrbgwsgghwwgej.supabase.co';
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!SUPABASE_SERVICE_KEY) {
  console.error('CRITICAL: SUPABASE_SERVICE_ROLE_KEY is missing in environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const logger = pino({ level: 'silent' });
const AUTH_BASE_DIR = path.join(process.cwd(), 'auth_sessions');

if (!fs.existsSync(AUTH_BASE_DIR)) {
  fs.mkdirSync(AUTH_BASE_DIR, { recursive: true });
}

// Track active sockets per user_id
const activeSessions = new Map();

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function startSession(sessionRow) {
  const userId = sessionRow.user_id;
  const cleanPhone = sanitizePhone(sessionRow.phone_number);

  if (!cleanPhone || cleanPhone.length < 9) {
    console.warn(`[${userId}] Invalid phone number: ${sessionRow.phone_number}`);
    return;
  }

  // Stop any existing socket for this user
  const existing = activeSessions.get(userId);
  if (existing?.sock) {
    try {
      existing.sock.end(undefined);
    } catch (_) {}
  }

  const sessionDir = path.join(AUTH_BASE_DIR, userId);

  // Wipe old auth folder if phone number changed
  if (existing && existing.phone !== cleanPhone && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let pairingCodeRequested = false;

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    // Canonical Linux Chrome identity required by WhatsApp pairing-code validation
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  activeSessions.set(userId, {
    sock,
    phone: cleanPhone,
    status: 'connecting',
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code once socket is ready (qr event fires) and not yet registered
    if (qr && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const rawCode = await sock.requestPairingCode(cleanPhone);
        const formattedCode =
          rawCode?.length === 8
            ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
            : rawCode;

        console.log(`[${userId}] Generated pairing code ${formattedCode} for ${cleanPhone}`);

        await supabase
          .from('whatsapp_sessions')
          .update({
            pairing_code: formattedCode,
            status: 'pending',
          })
          .eq('user_id', userId);
      } catch (err) {
        pairingCodeRequested = false;
        console.error(`[${userId}] Failed to request pairing code for ${cleanPhone}:`, err);
      }
    }

    if (connection === 'open') {
      console.log(`[${userId}] Connected to WhatsApp (${cleanPhone})`);
      const current = activeSessions.get(userId);
      if (current) current.status = 'connected';

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          pairing_code: null,
        })
        .eq('user_id', userId);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[${userId}] Connection closed (code: ${statusCode || 'unknown'})`);

      if (isLoggedOut) {
        // Clear stale credentials and remove active tracking so a fresh link can happen
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        activeSessions.delete(userId);

        await supabase
          .from('whatsapp_sessions')
          .update({
            status: 'disconnected',
            pairing_code: null,
          })
          .eq('user_id', userId);
      } else {
        // Reconnect immediately for 515 (restartRequired) after pairing, or brief delay otherwise
        const delayMs = statusCode === DisconnectReason.restartRequired ? 500 : 3000;
        setTimeout(() => {
          startSession({ ...sessionRow, phone_number: cleanPhone });
        }, delayMs);
      }
    }
  });

  // Handle incoming messages & trigger auto-reply
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');

      // Re-fetch latest toggles and trigger keywords from Supabase
      const { data: latestRow } = await supabase
        .from('whatsapp_sessions')
        .select('trigger_keywords, reply_in_groups, reply_in_dms')
        .eq('user_id', userId)
        .single();

      if (!latestRow) continue;
      if (isGroup && latestRow.reply_in_groups === false) continue;
      if (!isGroup && latestRow.reply_in_dms === false) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      if (!text.trim()) continue;

      const keywords = (latestRow.trigger_keywords || '@henymix, henymix')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      const lowerText = text.toLowerCase();
      const matched =
        keywords.length === 0 || keywords.some((kw) => lowerText.includes(kw));

      if (!matched) continue;

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        const { data: fnData, error: fnError } = await supabase.functions.invoke(
          'yumilo-assistant',
          {
            body: {
              message: text,
              user_id: userId,
              sender: remoteJid,
              is_group: isGroup,
              platform: 'whatsapp',
            },
          }
        );

        if (fnError) {
          console.error(`[${userId}] yumilo-assistant error:`, fnError);
          continue;
        }

        const replyText =
          fnData?.reply || fnData?.response || fnData?.message || fnData?.text;

        if (replyText) {
          await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
        }
      } catch (err) {
        console.error(`[${userId}] Auto-reply failed:`, err);
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid);
      }
    }
  });
}

// 3. Poll whatsapp_sessions table every 5 seconds
async function pollSessions() {
  try {
    const { data: rows, error } = await supabase
      .from('whatsapp_sessions')
      .select('*');

    if (error) {
      console.error('Error reading whatsapp_sessions:', error.message);
      return;
    }

    for (const row of rows || []) {
      const cleanPhone = sanitizePhone(row.phone_number);
      if (!cleanPhone) continue;

      const existing = activeSessions.get(row.user_id);

      // Start a session if not running yet, or if the phone number changed
      if (!existing || existing.phone !== cleanPhone) {
        console.log(`[${row.user_id}] Starting WhatsApp session for ${cleanPhone}...`);
        await startSession(row);
      }
    }
  } catch (err) {
    console.error('Polling loop error:', err);
  }
}

console.log('Henymix WhatsApp Worker started...');
pollSessions();
setInterval(pollSessions, 5000);
