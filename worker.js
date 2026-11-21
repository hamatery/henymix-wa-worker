import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_FUNCTION_URL =
  process.env.SUPABASE_FUNCTION_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/yumilo-assistant` : '');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 4000);
const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || './auth_sessions';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_FUNCTION_URL) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_FUNCTION_URL.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: 'silent' });

// Map<userId, { sock, phoneNumber, pairingRequestedFor, pairingRequestedAt, isConnecting }>
const activeSockets = new Map();
// Map<chatJid, Array<{ role: 'user' | 'model', text: string }>>
const chatHistories = new Map();
// Track recently processed message IDs to prevent duplicate replies
const processedMsgIds = new Set();

function sanitizePhone(val) {
  return String(val || '').replace(/\D/g, '');
}

function getMessageText(msg) {
  const m = msg?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function isBotMentionedOrCalled(msg, text, sessionConfig, botJid) {
  const isGroup = Boolean(msg?.key?.remoteJid?.endsWith('@g.us'));
  if (!isGroup) {
    return sessionConfig?.reply_in_dms !== false;
  }

  if (sessionConfig?.reply_in_groups === false) {
    return false;
  }

  const mentionedJids =
    msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const botNumber = sanitizePhone(botJid?.split('@')[0]);

  if (
    botNumber &&
    mentionedJids.some((jid) => sanitizePhone(jid?.split('@')[0]) === botNumber)
  ) {
    return true;
  }

  const rawKeywords = String(sessionConfig?.trigger_keywords || '@henymix, henymix');
  const keywords = rawKeywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const lowerText = String(text || '').toLowerCase();
  return keywords.some((kw) => lowerText.includes(kw));
}

function recordHistory(chatJid, role, text) {
  if (!text) return;
  const arr = chatHistories.get(chatJid) || [];
  arr.push({ role, text });
  if (arr.length > 10) arr.splice(0, arr.length - 10);
  chatHistories.set(chatJid, arr);
}

async function handleIncomingWhatsAppMessage(userId, sessionConfig, sock, msg) {
  try {
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;

    const msgId = msg.key?.id;
    if (msgId) {
      if (processedMsgIds.has(msgId)) return;
      processedMsgIds.add(msgId);
      if (processedMsgIds.size > 2000) {
        const first = processedMsgIds.values().next().value;
        processedMsgIds.delete(first);
      }
    }

    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;

    const isGroup = remoteJid.endsWith('@g.us');
    const text = getMessageText(msg);
    if (!text) return;

    if (!isBotMentionedOrCalled(msg, text, sessionConfig, sock.user?.id)) {
      return;
    }

    const senderJid = isGroup ? msg.key?.participant || remoteJid : remoteJid;
    const history = chatHistories.get(remoteJid) || [];

    const aiResponse = await fetch(SUPABASE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        user_id: userId,
        sender: senderJid,
        is_group: isGroup,
        platform: 'whatsapp',
        message: text,
        history,
      }),
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.text();
      console.error(`yumilo-assistant error for ${userId}:`, aiResponse.status, errBody);
      return;
    }

    const data = await aiResponse.json();
    const replyText = String(data?.reply || '').trim();
    const images = Array.isArray(data?.images) ? data.images : [];

    if (replyText) {
      await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
      recordHistory(remoteJid, 'user', text);
      recordHistory(remoteJid, 'model', replyText);
    }

    // Send actual product photos with captions on WhatsApp
    for (const img of images) {
      if (img?.url) {
        await sock.sendMessage(remoteJid, {
          image: { url: img.url },
          caption: img.caption || '',
        });
      }
    }
  } catch (err) {
    console.error(`Error handling WhatsApp message for ${userId}:`, err);
  }
}

async function stopUserSocket(userId) {
  const entry = activeSockets.get(userId);
  if (!entry) return;
  try {
    entry.sock?.end?.();
  } catch {}
  activeSockets.delete(userId);
}

async function startUserSocket(sessionRow) {
  const userId = sessionRow.user_id;
  const phoneNumber = sanitizePhone(sessionRow.phone_number);
  if (!userId || !phoneNumber) return;

  const existing = activeSockets.get(userId);
  if (existing && (existing.isConnecting || existing.phoneNumber === phoneNumber)) {
    existing.sessionConfig = sessionRow;
    return;
  }

  await stopUserSocket(userId);

  const authDir = path.join(AUTH_BASE_DIR, userId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Henymix', 'Chrome', '1.0.0'],
  });

  const entry = {
    sock,
    phoneNumber,
    sessionConfig: sessionRow,
    isConnecting: true,
    pairingRequested: false,
  };
  activeSockets.set(userId, entry);

  sock.ev.on('creds.update', saveCreds);

  // Request real WhatsApp pairing code if not yet registered/paired
  if (!state.creds.registered) {
    const currentStatus = String(sessionRow.status || '').toLowerCase();
    const hasExistingCode = Boolean(
      sessionRow.pairing_code && String(sessionRow.pairing_code).trim()
    );

    if (currentStatus === 'pending' && !hasExistingCode && !entry.pairingRequested) {
      entry.pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = String(code || '').trim();
          if (formatted) {
            await supabase
              .from('whatsapp_sessions')
              .update({
                pairing_code: formatted,
                status: 'code_ready',
                updated_at: new Date().toISOString(),
              })
              .eq('user_id', userId);
          }
        } catch (err) {
          console.error(`Failed requesting pairing code for ${phoneNumber}:`, err);
          entry.pairingRequested = false;
        }
      }, 2000);
    }
  } else {
    entry.isConnecting = false;
    await supabase
      .from('whatsapp_sessions')
      .update({
        status: 'connected',
        pairing_code: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    const latestEntry = activeSockets.get(userId);

    if (connection === 'open') {
      if (latestEntry) latestEntry.isConnecting = false;
      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          pairing_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      await stopUserSocket(userId);

      if (loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        await supabase
          .from('whatsapp_sessions')
          .update({
            status: 'disconnected',
            pairing_code: null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId);
      } else {
        setTimeout(() => {
          syncSessions().catch(() => {});
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const currentEntry = activeSockets.get(userId);
    const cfg = currentEntry?.sessionConfig || sessionRow;

    for (const msg of messages || []) {
      await handleIncomingWhatsAppMessage(userId, cfg, sock, msg);
    }
  });
}

async function syncSessions() {
  const { data: sessions, error } = await supabase
    .from('whatsapp_sessions')
    .select('*');

  if (error) {
    console.error('Error fetching whatsapp_sessions:', error.message);
    return;
  }

  const activeRows = (sessions || []).filter((s) => sanitizePhone(s.phone_number).length >= 9);
  const activeUserIds = new Set(activeRows.map((s) => s.user_id));

  for (const [uid] of activeSockets.entries()) {
    if (!activeUserIds.has(uid)) {
      await stopUserSocket(uid);
      const authDir = path.join(AUTH_BASE_DIR, uid);
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  }

  for (const row of activeRows) {
    await startUserSocket(row);
  }
}

async function main() {
  console.log('Henymix WhatsApp Worker started.');
  await syncSessions();
  setInterval(() => {
    syncSessions().catch((err) => console.error('Poll error:', err));
  }, POLL_INTERVAL_MS);
}

main();
