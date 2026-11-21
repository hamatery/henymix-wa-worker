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

// 1. Health server for Render
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Henymix WhatsApp Worker is running\n');
  })
  .listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

// 2. Supabase setup
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

// Track active sessions by user_id
const activeSessions = new Map();

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function updateSessionRow(userId, fields) {
  const { error } = await supabase
    .from('whatsapp_sessions')
    .update(fields)
    .eq('user_id', userId);

  if (error) {
    console.error(`[${userId}] Failed updating whatsapp_sessions:`, error.message);
  }
}

async function startSession(sessionRow) {
  const userId = sessionRow.user_id;
  const cleanPhone = sanitizePhone(sessionRow.phone_number);

  if (!cleanPhone || cleanPhone.length < 9) {
    console.warn(`[${userId}] Invalid phone number: ${sessionRow.phone_number}`);
    return;
  }

  const prev = activeSessions.get(userId);
  if (prev?.reconnectTimer) {
    clearTimeout(prev.reconnectTimer);
  }
  if (prev?.sock) {
    try {
      prev.sock.ev.removeAllListeners('connection.update');
      prev.sock.ev.removeAllListeners('creds.update');
      prev.sock.ev.removeAllListeners('messages.upsert');
      prev.sock.end(undefined);
    } catch (_) {}
  }

  const sessionDir = path.join(AUTH_BASE_DIR, userId);
  const phoneChanged = Boolean(prev && prev.phone && prev.phone !== cleanPhone);

  if (phoneChanged && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let pairingCodeRequested = false;

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const sessionEntry = {
    sock,
    phone: cleanPhone,
    status: state.creds.registered ? 'connecting' : 'pending',
    reconnectTimer: null,
  };
  activeSessions.set(userId, sessionEntry);

  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code once socket is ready and account is not yet registered
    if (qr && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const rawCode = await sock.requestPairingCode(cleanPhone);
        const formattedCode =
          rawCode?.length === 8
            ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
            : rawCode;

        console.log(`[${userId}] Generated pairing code ${formattedCode} for ${cleanPhone}`);
        sessionEntry.status = 'pending';

        await updateSessionRow(userId, {
          pairing_code: formattedCode,
          status: 'pending',
        });
      } catch (err) {
        pairingCodeRequested = false;
        console.error(`[${userId}] Failed requesting pairing code:`, err);
      }
    }

    if (connection === 'open') {
      console.log(`[${userId}] Connected to WhatsApp (${cleanPhone})`);
      sessionEntry.status = 'connected';
      pairingCodeRequested = false;

      await updateSessionRow(userId, {
        status: 'connected',
        pairing_code: null,
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[${userId}] Connection closed (code: ${statusCode || 'unknown'})`);

      if (isLoggedOut) {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        sessionEntry.status = 'disconnected';
        activeSessions.delete(userId);

        await updateSessionRow(userId, {
          status: 'disconnected',
          pairing_code: null,
        });
        return;
      }

      // Temporary disconnect or 515 restartRequired: keep 'connected' if already paired, reconnect cleanly
      const wasConnected = sessionEntry.status === 'connected' || Boolean(sock.authState.creds.registered);
      sessionEntry.status = wasConnected ? 'connected' : 'pending';

      await updateSessionRow(userId, {
        status: wasConnected ? 'connected' : 'pending',
        ...(wasConnected ? { pairing_code: null } : {}),
      });

      const delayMs = statusCode === DisconnectReason.restartRequired ? 500 : 3000;
      sessionEntry.reconnectTimer = setTimeout(() => {
        startSession({ ...sessionRow, phone_number: cleanPhone });
      }, delayMs);
    }
  });

  // Handle incoming messages and auto-reply via yumilo-assistant
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid || '';
      if (!remoteJid || remoteJid === 'status@broadcast') continue;

      const isGroup = remoteJid.endsWith('@g.us');

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

// 3. Poll whatsapp_sessions every 5 seconds without killing active sockets
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

      // Only start a new socket if none exists yet or phone_number changed
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
