import express from "express";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const rawUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://syxibiyrbgwsgghwwgej.supabase.co";

const SUPABASE_URL = rawUrl.trim().replace(/^["']|["']$/g, "");

const rawKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

const SUPABASE_SERVICE_ROLE_KEY = rawKey.trim().replace(/^["']|["']$/g, "");
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/yumilo-assistant`;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY in Render Environment Variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: "silent" });

const activeSockets = new Map();
const startingUsers = new Set();

function normalizeDigits(jidOrPhone) {
  return String(jidOrPhone || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function extractMessageText(msg) {
  const m = msg?.message;
  if (!m) return "";
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

function extractMentionedJids(msg) {
  const m = msg?.message;
  if (!m) return [];
  return (
    m.extendedTextMessage?.contextInfo?.mentionedJid ||
    m.imageMessage?.contextInfo?.mentionedJid ||
    m.videoMessage?.contextInfo?.mentionedJid ||
    []
  );
}

function shouldReplyToMessage({ msg, sock, sessionRow, text }) {
  const remoteJid = msg.key?.remoteJid || "";
  if (!remoteJid || remoteJid === "status@broadcast") return false;
  if (msg.key?.fromMe) return false;

  const isGroup = remoteJid.endsWith("@g.us");
  if (isGroup && sessionRow.reply_in_groups === false) return false;
  if (!isGroup && sessionRow.reply_in_dms === false) return false;

  if (!isGroup) return true;

  const botDigits = normalizeDigits(sock.user?.id || sessionRow.phone_number);
  const botLidDigits = normalizeDigits(sock.user?.lid || "");
  const mentionedJids = extractMentionedJids(msg);

  const isTaggedDirectly = mentionedJids.some((jid) => {
    const d = normalizeDigits(jid);
    return (botDigits && d === botDigits) || (botLidDigits && d === botLidDigits);
  });

  if (isTaggedDirectly) return true;

  const keywords = String(sessionRow.trigger_keywords || "@henymix, henymix")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const lowerText = text.toLowerCase();
  return keywords.some((kw) => lowerText.includes(kw));
}

async function restoreAuthFolderFromSupabase(userId, authDir) {
  fs.mkdirSync(authDir, { recursive: true });
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("auth_creds")
    .eq("user_id", userId)
    .maybeSingle();

  if (data?.auth_creds && typeof data.auth_creds === "object") {
    for (const [fileName, content] of Object.entries(data.auth_creds)) {
      fs.writeFileSync(path.join(authDir, fileName), JSON.stringify(content));
    }
  }
}

async function backupAuthFolderToSupabase(userId, authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir);
    const bundle = {};
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = fs.readFileSync(path.join(authDir, f), "utf8");
      bundle[f] = JSON.parse(raw);
    }
    await supabase
      .from("whatsapp_sessions")
      .update({ auth_creds: bundle, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
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
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["Henymix", "Chrome", "124.0.0"]
    });

    activeSockets.set(userId, sock);

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      await backupAuthFolderToSupabase(userId, authDir);
    });

    if (!sock.authState.creds.registered && sessionRow.phone_number) {
      setTimeout(async () => {
        try {
          const cleanPhone = normalizeDigits(sessionRow.phone_number);
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
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
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
          setTimeout(() => syncSessionsFromSupabase(), 4000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          const rawText = extractMessageText(msg);
          if (!rawText) continue;

          const { data: latestSession } = await supabase
            .from("whatsapp_sessions")
            .select("*")
            .eq("user_id", userId)
            .maybeSingle();

          const activeCfg = latestSession || sessionRow;
          if (!shouldReplyToMessage({ msg, sock, sessionRow: activeCfg, text: rawText })) {
            continue;
          }

          const remoteJid = msg.key.remoteJid;
          const participantJid = msg.key.participant || remoteJid;
          const senderPhone = normalizeDigits(participantJid);
          const cleanPrompt = rawText.replace(/@\d{6,16}/g, "").trim() || "Hello";

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
              message: cleanPrompt
            })
          });

          const data = await fnRes.json();
          const replyText = data?.reply;
          const imageUrls = Array.isArray(data?.images)
            ? data.images
            : data?.image_url
              ? [data.image_url]
              : [];

          if (replyText) {
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
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
