// index.js — Badlands Bot + keep-alive web server for Render.
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const Pino = require("pino");
const express = require("express");

const PREFIX = "!";
const OWNER_NUMBER = "2348144550593";
const OWNER_LID = "101014040526896";
const EGG_PTERODACTYL = "2348144550593@s.whatsapp.net";
const AUTH_FOLDER = "./auth_info_baileys";
const PORT = process.env.PORT || 3000;

let pairingRequested = false;
let connected = false;
let sock = null;

// ── keep-alive web server ──────────────────────────────────────────────
const app = express();
app.get("/", (_req, res) => res.status(200).send("badlands up"));
app.get("/health", (_req, res) => res.status(200).json({
  ok: true,
  connected,
  uptime: process.uptime(),
}));
app.listen(PORT, () => console.log(`[BADLANDS] http on :${PORT}`));

// ── owner resolution: match PN or LID, with alt fallback ───────────────
function bareJid(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

function isOwner(msg) {
  const key = msg.key || {};
  // try every identifier WhatsApp might attach
  const candidates = new Set();
  const add = (j) => { if (j) { candidates.add(bareJid(j)); candidates.add(j); } };

  add(key.participant);
  add(key.participantAlt);
  add(key.remoteJid);
  add(key.remoteJidAlt);

  for (const c of candidates) {
    const b = bareJid(c);
    if (b === OWNER_NUMBER || b === OWNER_LID) return true;
  }

  // self-chat: if fromMe and remoteJid is the bot's own JID, treat as owner
  if (key.fromMe) return true;

  return false;
}

function isGroup(jid) { return jid && jid.endsWith("@g.us"); }

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  const logger = Pino({ level: "silent" });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 250,
  });

  sock.ev.on("creds.update", saveCreds);

  if (!state.creds.registered && !pairingRequested) {
    pairingRequested = true;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log(`\n=== PAIRING CODE: ${code} ===`);
        console.log("WhatsApp → Linked Devices → Link with phone number → enter code\n");
      } catch (err) {
        console.error("Pairing request failed:", err.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      connected = true;
      pairingRequested = true;
      console.log("[BADLANDS] connected:", sock.user?.id);
    }
    if (connection === "close") {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[BADLANDS] closed (${statusCode})`);
      if (loggedOut) {
        console.log("Logged out — wipe auth folder and re-pair.");
        process.exit(1);
      }
      if (sock.authState.creds.registered) {
        setTimeout(startBot, 3000);
      } else {
        console.log("Unpaired socket closed — rerun and enter code fast.");
      }
    }
  });

  // ── RAW LOGGER: confirms whether messages.upsert fires at all ─────────
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    console.log(`[UPSERT] type=${type} count=${messages.length}`);
    for (const m of messages) {
      const k = m.key || {};
      console.log(`[UPSERT] fromMe=${k.fromMe} remoteJid=${k.remoteJid} participant=${k.participant || "-"} alt=${k.remoteJidAlt || k.participantAlt || "-"}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const key = msg.key || {};
      const remoteJid = key.remoteJid;
      if (!remoteJid) continue;

      if (!isOwner(msg)) continue;

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || "";
      if (!text.startsWith(PREFIX)) continue;

      const [cmd] = text.slice(PREFIX.length).trim().split(/\s+/);
      const command = cmd.toLowerCase();

      // ── !ping ──
      if (command === "ping") {
        const start = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
        await sock.sendMessage(remoteJid, { text: `Pong! ${Date.now() - start}ms` }, { quoted: msg });
        continue;
      }

      // ── !badlands ──
      if (command === "badlands") {
        if (!isGroup(remoteJid)) {
          await sock.sendMessage(remoteJid, { text: "!badlands works only in groups." }, { quoted: msg });
          continue;
        }
        try {
          const metadata = await sock.groupMetadata(remoteJid);
          const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
          const me = metadata.participants.find(p => p.id === botJid);
          if (!me || (me.admin !== "admin" && me.admin !== "superadmin")) {
            await sock.sendMessage(remoteJid, { text: "Bot is not admin." }, { quoted: msg });
            continue;
          }
          const toDemote = metadata.participants
            .filter(p => (p.admin === "admin" || p.admin === "superadmin")
              && p.id !== botJid
              && bareJid(p.id) !== OWNER_NUMBER
              && bareJid(p.id) !== OWNER_LID
              && p.id !== EGG_PTERODACTYL)
            .map(p => p.id);
          if (toDemote.length === 0) {
            await sock.sendMessage(remoteJid, { text: "No admins to demote." }, { quoted: msg });
            continue;
          }
          await sock.groupParticipantsUpdate(remoteJid, toDemote, "demote");
          await sock.sendMessage(remoteJid, { text: `Demoted ${toDemote.length} admin(s).` }, { quoted: msg });
        } catch (e) {
          console.error("[BADLANDS] error:", e.message);
          await sock.sendMessage(remoteJid, { text: "Badlands failed: " + e.message }, { quoted: msg });
        }
      }
    }
  });
}

startBot().catch(err => console.error("Fatal:", err));
