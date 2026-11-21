import express from "express";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import fs from "fs";
import path from "path";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err?.message || err);
});

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

const DEFAULT_SUPABASE_URL = "https://syxibiyrbgwsgghwwgej.supabase.co";
const PORT = Number(process.env.PORT) || 10000;

function resolveSupabaseUrl() {
  const candidates = [
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
    DEFAULT_SUPABASE_URL
  ];

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().replace(/^["']+|["']+$/g, "").trim();
    if (/^https?:\/\/.+/i.test(cleaned)) {
      return cleaned.replace(/\/+$/, "");
    }
  }

  return DEFAULT_SUPABASE_URL;
}

function resolveSupabaseKey() {
  const candidates = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_KEY,
    process.env.SUPABASE_ANON_KEY
  ];

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().replace(/^["']+|["']+$/g, "").trim();
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  return "";
}

const SUPABASE_URL = resolveSupabaseUrl();
const SUPABASE_SERVICE_ROLE_KEY = resolveSupabaseKey();
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/yumilo-assistant`;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase API key in Render Environment Variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: "silent" });

const activeSockets = new Map();
const startingUsers = new Set();
const pairingAttempted = new Map();

function normalizeDigits(jidOrPhone) {
  return String(jidOrPhone || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function cleanOutboundText(text) {
  return String(text || "")
    .replace(/\*\*\*/g, "")
    .replace(/\*\*/g, "*")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

function extractMessageText(msg) {
  const m = msg?.message;
  if (!m) return "";
  if (m.audioMessage) {
    return "[Voice Note received]";
  }
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ""
  ).trim();
}

function shouldReplyToMessage({ msg, sessionRow, text }) {
  const remoteJid = msg.key?.remoteJid || "";
  if (!remoteJid || remoteJid === "status@broadcast") return false;
  if (msg.key?.fromMe) return false;
  if (!text) return false;

  const isGroup = remoteJid.endsWith("@g.us");
  if (isGroup && sessionRow.reply_in_groups === false) return false;
  if (!isGroup && sessionRow.reply_in_dms === false) return false;

  // Respond automatically without requiring a tag or keyword
  return true;
}

async function logWhatsAppMessage({ userId, chatJid, senderPhone, senderName, direction, body }) {
  try {
    await supabase.from("whatsapp_messages").insert({
      user_id: userId,
      chat_jid: chatJid,
      sender_phone: senderPhone || "",
      sender_name: senderName || "",
      direction,
      body: String(body || "").slice(0, 4000)
    });
  } catch (err) {
    console.error("Failed to log whatsapp_messages:", err.message);
  }
}

async function restoreAuthFolderFromSupabase(userId, authDir) {
  try {
    fs.mkdirSync(authDir, { recursive: true });
    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .select("auth_creds")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Auth restore query error:", error.message);
      return;
    }

    if (data?.auth_creds && typeof data.auth_creds === "object") {
      for (const [fileName, content] of Object.entries(data.auth_creds)) {
        if (!fileName || content === undefined || content === null) continue;
        const safeName = path.basename(fileName);
        fs.writeFileSync(path.join(authDir, safeName), JSON.stringify(content));
      }
    }
  } catch (err) {
    console.error("Auth restore error:", err.message);
  }
}

async function backupAuthFolderToSupabase(userId, authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir);
    const bundle = {};
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const fullPath = path.join(authDir, f);
      if (!fs.existsSync(fullPath)) continue;
      const raw = fs.readFileSync(fullPath, "utf8");
      if (raw) bundle[f] = JSON.parse(raw);
    }
    if (Object.keys(bundle).length > 0) {
      await supabase
        .from("whatsapp_sessions")
        .update({ auth_creds: bundle, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    }
  } catch (err) {
    console.error("Auth backup error:", err.message);
  }
}

async function startSessionForUser(sessionRow) {
  const userId = sessionRow.user_id;
  if (!userId || activeSockets.has(userId) || startingUsers.has(userId)) return;

  startingUsers.add(userId);
  const authDir = path.join("/tmp", `wa_auth_${userId}`);

  try {
    await restoreAuthFolderFromSupabase(userId, authDir);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome")
    });

    activeSockets.set(userId, sock);

    // Reject incoming voice/video calls automatically
    sock.ev.on("call", async (calls) => {
      for (const call of calls) {
        if (call.status === "offer") {
          try {
            await sock.rejectCall(call.id, call.from);
            console.log(`[WA CALL DECLINED] from=${call.from}`);
          } catch (err) {
            console.error("Call reject error:", err.message);
          }
        }
      }
    });

    sock.ev.on("creds.update", async () => {
      try {
        fs.mkdirSync(authDir, { recursive: true });
        await saveCreds();
        await backupAuthFolderToSupabase(userId, authDir);
      } catch (err) {
        console.error("creds.update error:", err.message);
      }
    });

    const cleanPhone = normalizeDigits(sessionRow.phone_number);
    const existingCode = typeof sessionRow.pairing_code === "string" ? sessionRow.pairing_code.trim() : "";
    const prevAttempt = pairingAttempted.get(userId);
    const cooldownMs = 120000;

    const canRequestNewCode =
      !sock.authState.creds.registered &&
      cleanPhone &&
      (!existingCode || existingCode.toUpperCase() === "PENDING") &&
      (!prevAttempt ||
        prevAttempt.phone !== cleanPhone ||
        Date.now() - prevAttempt.time > cooldownMs);

    if (canRequestNewCode) {
      pairingAttempted.set(userId, { phone: cleanPhone, time: Date.now() });
      setTimeout(async () => {
        try {
          if (sock.authState.creds.registered) return;
          const code = await sock.requestPairingCode(cleanPhone);
          const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
          await supabase
            .from("whatsapp_sessions")
            .update({
              pairing_code: formattedCode,
              status: "code_ready",
              updated_at: new Date().toISOString()
            })
            .eq("user_id", userId);
          console.log(`Pairing code issued for ${cleanPhone}: ${formattedCode}`);
        } catch (err) {
          console.error("Failed to request pairing code:", err.message);
        }
      }, 3000);
    }

    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          pairingAttempted.delete(userId);
          await backupAuthFolderToSupabase(userId, authDir);
          await supabase
            .from("whatsapp_sessions")
            .update({
              status: "connected",
              pairing_code: null,
              updated_at: new Date().toISOString()
            })
            .eq("user_id", userId);
          console.log(`WhatsApp connected for user ${userId}`);
        } else if (connection === "close") {
          activeSockets.delete(userId);
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            pairingAttempted.delete(userId);
            fs.rmSync(authDir, { recursive: true, force: true });
            await supabase
              .from("whatsapp_sessions")
              .update({
                status: "logged_out",
                pairing_code: null,
                auth_creds: null,
                updated_at: new Date().toISOString()
              })
              .eq("user_id", userId);
          } else {
            setTimeout(() => syncSessionsFromSupabase(), 5000);
          }
        }
      } catch (err) {
        console.error("connection.update error:", err.message);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          const rawText = extractMessageText(msg);
          if (!rawText) continue;

          const remoteJid = msg.key?.remoteJid || "";
          const participantJid = msg.key?.participant || remoteJid;
          const senderPhone = normalizeDigits(participantJid);
          const senderName = String(msg.pushName || "").trim();

          if (!msg.key?.fromMe && remoteJid && remoteJid !== "status@broadcast") {
            await logWhatsAppMessage({
              userId,
              chatJid: remoteJid,
              senderPhone,
              senderName,
              direction: "inbound",
              body: rawText
            });
          }

          const { data: latestSession } = await supabase
            .from("whatsapp_sessions")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();

          const activeCfg = latestSession || sessionRow;
          if (!shouldReplyToMessage({ msg, sessionRow: activeCfg, text: rawText })) {
            continue;
          }

          await sock.sendPresenceUpdate("composing", remoteJid);

          const fnRes = await fetch(FUNCTION_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify({
              sessionId: `wa_${remoteJid}`,
              user_id: userId,
              platform: "whatsapp",
              sender_phone: senderPhone,
              sender_name: senderName,
              message: rawText
            })
          });

          const data = await fnRes.json().catch(() => ({}));
          const replyText = cleanOutboundText(data?.reply || "");
          const audioUrl = typeof data?.audio_url === "string" ? data.audio_url : "";
          const imageUrls = Array.isArray(data?.images)
            ? data.images
            : data?.image_url
              ? [data.image_url]
              : [];

          if (replyText) {
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            await logWhatsAppMessage({
              userId,
              chatJid: remoteJid,
              senderPhone,
              senderName,
              direction: "outbound",
              body: replyText
            });
          }

          if (audioUrl && audioUrl.startsWith("http")) {
            await sock.sendMessage(remoteJid, {
              audio: { url: audioUrl },
              mimetype: "audio/mp4",
              ptt: true
            });
          }

          for (const imgUrl of imageUrls) {
            if (typeof imgUrl === "string" && imgUrl.startsWith("http")) {
              await sock.sendMessage(remoteJid, { image: { url: imgUrl } });
            }
          }

          await sock.sendPresenceUpdate("paused", remoteJid);
        } catch (err) {
          console.error("Message handling error:", err.message);
        }
      }
    });
  } catch (err) {
    console.error("startSessionForUser error:", err.message);
  } finally {
    startingUsers.delete(userId);
  }
}

async function syncSessionsFromSupabase() {
  try {
    const { data: sessions, error } = await supabase
      .from("whatsapp_sessions")
      .select("*");

    if (error || !Array.isArray(sessions)) return;

    const validUserIds = new Set(sessions.map((s) => s.user_id));

    for (const [uid, sock] of activeSockets.entries()) {
      if (!validUserIds.has(uid)) {
        try { sock.end(); } catch {}
        activeSockets.delete(uid);
      }
    }

    for (const row of sessions) {
      if (row.phone_number && row.status !== "logged_out") {
        await startSessionForUser(row);
      }
    }
  } catch (err) {
    console.error("Session sync error:", err.message);
  }
}

app.post("/api/send-whatsapp", async (req, res) => {
  try {
    const { user_id, to, message } = req.body || {};
    if (!to || !message) {
      return res.status(400).json({ error: "Missing 'to' or 'message'" });
    }

    const targetUserId = user_id || [...activeSockets.keys()][0];
    const sock = activeSockets.get(targetUserId);
    if (!sock) {
      return res.status(409).json({ error: "WhatsApp worker not connected" });
    }

    const cleanedMessage = cleanOutboundText(message);
    const digits = normalizeDigits(to);
    const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: cleanedMessage });
    await logWhatsAppMessage({
      userId: targetUserId,
      chatJid: jid,
      senderPhone: digits,
      senderName: "",
      direction: "outbound",
      body: cleanedMessage
    });

    return res.json({ ok: true, to: jid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "henymix-wa-worker",
    activeSockets: activeSockets.size
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "henymix-wa-worker",
    activeSockets: activeSockets.size
  });
});

app.listen(PORT, () => {
  console.log(`henymix-wa-worker listening on port ${PORT}`);
  syncSessionsFromSupabase();
  setInterval(syncSessionsFromSupabase, 15000);
});
