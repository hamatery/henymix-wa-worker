import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/yumilo-assistant`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const activeSockets = new Map();

function extractMessageText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  ).trim();
}

async function startSessionForUser(row) {
  const cleanPhone = String(row.phone_number || "").replace(/\D/g, "");
  if (!cleanPhone || cleanPhone.length < 9) return;

  const existing = activeSockets.get(row.user_id);
  if (existing && existing.phone === cleanPhone) {
    existing.config = row;
    return;
  }
  if (existing?.sock) {
    try {
      existing.sock.end(undefined);
    } catch {}
  }

  const authDir = `./auth_sessions/user_${row.user_id}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Henymix OS", "Chrome", "1.0.0"]
  });

  activeSockets.set(row.user_id, { phone: cleanPhone, sock, config: row });
  sock.ev.on("creds.update", saveCreds);

  let pairingRequested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "connecting" && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          const formatted = code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
          if (formatted) {
            await supabase
              .from("whatsapp_sessions")
              .update({
                pairing_code: formatted,
                status: "pending",
                updated_at: new Date().toISOString()
              })
              .eq("user_id", row.user_id);
            console.log(`Generated pairing code ${formatted} for ${cleanPhone}`);
          }
        } catch (err) {
          console.error(`Failed to request pairing code for ${cleanPhone}:`, err?.message || err);
        }
      }, 2500);
    }

    if (connection === "open") {
      pairingRequested = false;
      await supabase
        .from("whatsapp_sessions")
        .update({
          status: "connected",
          pairing_code: null,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", row.user_id);
      console.log(`WhatsApp connected for user ${row.user_id} (${cleanPhone})`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      activeSockets.delete(row.user_id);

      if (loggedOut) {
        await supabase
          .from("whatsapp_sessions")
          .update({
            status: "disconnected",
            pairing_code: null,
            updated_at: new Date().toISOString()
          })
          .eq("user_id", row.user_id);
      } else {
        setTimeout(() => {
          startSessionForUser(activeSockets.get(row.user_id)?.config || row);
        }, 4000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const currentRow = activeSockets.get(row.user_id)?.config || row;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") continue;

      const isGroup = remoteJid.endsWith("@g.us");
      if (isGroup && currentRow.reply_in_groups === false) continue;
      if (!isGroup && currentRow.reply_in_dms === false) continue;

      const text = extractMessageText(msg.message);
      if (!text) continue;

      const triggers = String(currentRow.trigger_keywords || "@henymix, henymix")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      const botNumber = sock.user?.id?.split(":")[0];
      const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const isTagged = Boolean(botNumber && mentionedJids.some((jid) => jid.startsWith(botNumber)));
      const lowerText = text.toLowerCase();
      const isCalledByKeyword = triggers.some((kw) => lowerText.includes(kw));

      if (!isTagged && !isCalledByKeyword) continue;

      try {
        const res = await fetch(FUNCTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: `wa_${currentRow.user_id}_${remoteJid}`,
            message: `WhatsApp incoming message (${isGroup ? "Group" : "Direct"}): ${text}`,
            history: []
          })
        });
        const data = await res.json();
        if (data?.reply) {
          await sock.sendMessage(remoteJid, { text: data.reply }, { quoted: msg });
        }
      } catch (err) {
        console.error("Error replying to WhatsApp message:", err?.message || err);
      }
    }
  });
}

async function pollSessions() {
  try {
    const { data, error } = await supabase.from("whatsapp_sessions").select("*");
    if (error) {
      console.error("Error reading whatsapp_sessions:", error.message);
      return;
    }

    const rows = data || [];
    const activeIds = new Set(rows.map((r) => r.user_id));

    for (const [uid, entry] of activeSockets.entries()) {
      if (!activeIds.has(uid)) {
        try {
          entry.sock.end(undefined);
        } catch {}
        activeSockets.delete(uid);
      }
    }

    for (const row of rows) {
      await startSessionForUser(row);
    }
  } catch (err) {
    console.error("Poll loop error:", err?.message || err);
  }
}

console.log("Henymix WhatsApp Worker started...");
pollSessions();
setInterval(pollSessions, 5000);