import http from 'http';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Henymix WhatsApp Worker is running\n');
  })
  .listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}`);
  });

const rawUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = rawUrl.startsWith('http')
  ? rawUrl
  : 'https://syxibiyrbgwsgghwwgej.supabase.co';
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!SUPABASE_SERVICE_KEY) {
  console.error('CRITICAL: SUPABASE_SERVICE_ROLE_KEY is missing.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const logger = pino({ level: 'silent' });
const activeSessions = new Map();

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function formatForWhatsApp(text) {
  return String(text || '')
    // Convert ### Heading to WhatsApp *Heading*
    .replace(/^#{1,6}\s+(.+)$/gm, (_, title) => `*${title.replace(/\*/g, '').trim()}*`)
    // Convert **bold** to WhatsApp *bold*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Convert Markdown "* " or "- " bullets to clean "• " bullets
    .replace(/^\s*[\*\-]\s+/gm, '• ')
    .trim();
}

async function updateSessionRow(userId, fields) {
  const { error } = await supabase
    .from('whatsapp_sessions')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (error) {
    console.error(`[${userId}] Failed updating whatsapp_sessions:`, error.message);
  }
}

// Store Baileys auth state directly in whatsapp_sessions.auth_state (jsonb)
async function useRowAuthState(userId, reset = false) {
  let store = { creds: initAuthCreds(), keys: {} };

  if (!reset) {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('auth_state')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error(`[${userId}] Error reading auth_state:`, error.message);
    } else if (data?.auth_state) {
      try {
        const raw =
          typeof data.auth_state === 'string'
            ? data.auth_state
            : JSON.stringify(data.auth_state);
        const parsed = JSON.parse(raw, BufferJSON.reviver);
        if (parsed?.creds) {
          store = { creds: parsed.creds, keys: parsed.keys || {} };
        }
      } catch (e) {
        console.warn(`[${userId}] Could not parse auth_state, starting fresh.`);
      }
    }
  }

  let saveTimer = null;
  const persistNow = async () => {
    try {
      const serialized = JSON.parse(JSON.stringify(store, BufferJSON.replacer));
      const { error } = await supabase
        .from('whatsapp_sessions')
        .update({
          auth_state: serialized,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) {
        console.error(`[${userId}] Failed saving auth_state:`, error.message);
      }
    } catch (err) {
      console.error(`[${userId}] Exception saving auth_state:`, err.message);
    }
  };

  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  };

  if (reset) {
    await persistNow();
  }

  return {
    state: {
      creds: store.creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            let value = store.keys[`${type}-${id}`] || null;
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const k = `${category}-${id}`;
              if (value) {
                store.keys[k] = value;
              } else {
                delete store.keys[k];
              }
            }
          }
          schedulePersist();
        },
      },
    },
    saveCreds: async () => {
      await persistNow();
    },
    clearState: async () => {
      store = { creds: initAuthCreds(), keys: {} };
      await updateSessionRow(userId, { auth_state: null });
    },
  };
}

async function startSession(sessionRow, forceFreshPair = false) {
  const userId = sessionRow.user_id;
  const cleanPhone = sanitizePhone(sessionRow.phone_number);

  if (!cleanPhone || cleanPhone.length < 9) return;

  for (const [otherUid, otherEntry] of activeSessions.entries()) {
    if (otherUid !== userId && otherEntry.phone === cleanPhone) {
      console.warn(`[${userId}] Skipping ${cleanPhone}: already active under user ${otherUid}`);
      await updateSessionRow(userId, {
        status: 'duplicate_number',
        pairing_code: null,
      });
      return;
    }
  }

  const prev = activeSessions.get(userId);
  if (prev?.reconnectTimer) clearTimeout(prev.reconnectTimer);
  if (prev?.sock) {
    try {
      prev.sock.ev.removeAllListeners('connection.update');
      prev.sock.ev.removeAllListeners('creds.update');
      prev.sock.ev.removeAllListeners('messages.upsert');
      prev.sock.end(undefined);
    } catch (_) {}
  }

  const phoneChanged = Boolean(prev && prev.phone && prev.phone !== cleanPhone);
  const { state, saveCreds, clearState } = await useRowAuthState(
    userId,
    phoneChanged || forceFreshPair
  );
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

    if (qr && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      try {
        const rawCode = await sock.requestPairingCode(cleanPhone);
        const formattedCode =
          rawCode?.length === 8
            ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
            : rawCode;

        console.log(`[${userId}] Generated real WhatsApp pairing code ${formattedCode} for ${cleanPhone}`);
        sessionEntry.status = 'awaiting_code';

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
      await saveCreds();

      await updateSessionRow(userId, {
        status: 'connected',
        pairing_code: null,
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

      console.log(`[${userId}] Connection closed (code: ${statusCode || 'unknown'})`);

      await saveCreds();

      if (isLoggedOut) {
        await clearState();
        sessionEntry.status = 'disconnected';
        activeSessions.delete(userId);

        await updateSessionRow(userId, {
          status: 'disconnected',
          pairing_code: null,
        });
        return;
      }

      const wasConnected =
        sessionEntry.status === 'connected' || Boolean(sock.authState.creds.registered);
      sessionEntry.status = wasConnected ? 'connected' : 'awaiting_code';

      const delayMs = statusCode === DisconnectReason.restartRequired ? 300 : 3000;
      sessionEntry.reconnectTimer = setTimeout(() => {
        startSession({ ...sessionRow, phone_number: cleanPhone }, false);
      }, delayMs);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid || '';
      if (!remoteJid || remoteJid === 'status@broadcast') continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const myNumber = sanitizePhone(sock.user?.id?.split(':')[0] || cleanPhone);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      if (!text.trim()) continue;

      const mentionedJids =
        msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const isBotTagged = mentionedJids.some(
        (jid) => sanitizePhone(jid.split('@')[0]) === myNumber
      );

      const lowerText = text.toLowerCase();
      if (msg.key.fromMe && !isBotTagged && !lowerText.includes('henymix')) {
        continue;
      }

      const { data: latestRow } = await supabase
        .from('whatsapp_sessions')
        .select('trigger_keywords, reply_in_groups, reply_in_dms')
        .eq('user_id', userId)
        .single();

      if (!latestRow) continue;
      if (isGroup && latestRow.reply_in_groups === false) continue;
      if (!isGroup && latestRow.reply_in_dms === false) continue;

      const keywords = (latestRow.trigger_keywords || '@henymix, henymix')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      const keywordMatched =
        keywords.length === 0 ||
        keywords.some((kw) => lowerText.includes(kw)) ||
        lowerText.includes(`@${myNumber}`);

      if (!isBotTagged && !keywordMatched) continue;

      const cleanedPrompt =
        text.replace(new RegExp(`@${myNumber}\\b`, 'g'), '').trim() || text;

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;

        const { data: fnData, error: fnError } = await supabase.functions.invoke(
          'yumilo-assistant',
          {
            body: {
              message: cleanedPrompt,
              user_id: userId,
              sender: senderJid,
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
          await sock.sendMessage(
            remoteJid,
            { text: formatForWhatsApp(replyText) },
            { quoted: msg }
          );
        }
      } catch (err) {
        console.error(`[${userId}] Auto-reply failed:`, err);
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid);
      }
    }
  });
}

async function pollSessions() {
  try {
    const { data: rows, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Error reading whatsapp_sessions:', error.message);
      return;
    }

    const activeUserIds = new Set((rows || []).map((r) => r.user_id));

    for (const [uid, entry] of activeSessions.entries()) {
      if (!activeUserIds.has(uid)) {
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        try { entry.sock?.end(undefined); } catch (_) {}
        activeSessions.delete(uid);
      }
    }

    for (const row of rows || []) {
      const cleanPhone = sanitizePhone(row.phone_number);
      if (!cleanPhone) continue;

      const status = (row.status || '').toLowerCase();
      if (status === 'disconnected' || status === 'duplicate_number') continue;

      const existing = activeSessions.get(row.user_id);
      const wantsFreshCode = status === 'pending' && !row.pairing_code;

      if (!existing || existing.phone !== cleanPhone) {
        console.log(`[${row.user_id}] Starting WhatsApp session for ${cleanPhone}...`);
        await startSession(row, wantsFreshCode);
      } else if (
        wantsFreshCode &&
        existing.status !== 'connected' &&
        existing.status !== 'awaiting_code'
      ) {
        console.log(`[${row.user_id}] Fresh pairing code requested for ${cleanPhone}...`);
        await startSession(row, true);
      }
    }
  } catch (err) {
    console.error('Polling loop error:', err);
  }
}

console.log('Henymix WhatsApp Worker started...');
pollSessions();
setInterval(pollSessions, 5000);
