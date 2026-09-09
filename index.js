const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const app = express();
const PORT = Number(process.env.PORT || 8080);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "datos");
const DB_FILE = path.join(DATA_DIR, "db.json");
const AUTH_DIR = path.join(DATA_DIR, "auth_info_baileys");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

let sock = null;

function loadDB() {
  const defaultDB = { saldos: {}, stock: {}, precios: {}, pagos: { transferencia: "No configurado", oxxo: "No configurado" } };
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2), "utf8");
      return defaultDB;
    }
    return { ...defaultDB, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch (e) {
    return defaultDB;
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(DB_FILE + ".tmp", DB_FILE);
  } catch (e) {}
}

function cleanNum(val) {
  return String(val || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function getSender(m) {
  const remote = m.key.remoteJid || "";
  const isGroup = remote.endsWith("@g.us");
  const raw = isGroup ? (m.key.participant || m.participant || "") : remote;
  const number = cleanNum(raw);
  return { remote, isGroup, number, jid: number ? `${number}@s.whatsapp.net` : null };
}

function isAdmin(num) {
  const admins = (process.env.ADMIN_NUMBERS || "").split(",").map(cleanNum).filter(Boolean);
  return admins.includes(cleanNum(num));
}

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      logger: pino({ level: "silent" }),
      auth: state,
      printQRInTerminal: true,
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        console.log("✅ Conectado a WhatsApp correctamente.");
      }

      if (connection === "close") {
        sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Desconectado. Código: ${code}`);

        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        }
        setTimeout(startBot, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue;
          const sender = getSender(m);
          if (!sender.number || !sender.jid) continue;

          const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "";
          if (!text.trim().startsWith(".")) continue;

          const args = text.trim().slice(1).split(/\s+/);
          const cmd = (args.shift() || "").toLowerCase();
          const db = loadDB();

          if (cmd === "menu" || cmd === "tienda") {
            let msg = `🛒 *TIENDA SAMANTHA*\n\n💰 Saldo: *$${db.saldos[sender.jid] || 0} MXN*\n\n📦 *PRODUCTOS*\n`;
            const keys = Object.keys(db.precios);
            if (!keys.length) msg += "\n_No hay productos configurados._\n";
            else {
              keys.forEach(p => {
                msg += `\n• *${p.toUpperCase()}* — $${db.precios[p]} MXN (Stock: ${(db.stock[p] || []).length})`;
              });
            }
            await sock.sendMessage(sender.remote, { text: msg });
            continue;
          }

          if (cmd === "saldo") {
            await sock.sendMessage(sender.remote, { text: `💰 Tu saldo: *$${db.saldos[sender.jid] || 0} MXN*` });
            continue;
          }

          if (cmd === "comprar") {
            const prod = (args[0] || "").toLowerCase();
            if (!prod || db.precios[prod] == null) {
              await sock.sendMessage(sender.remote, { text: "❌ Producto inválido." });
              continue;
            }
            const price = Number(db.precios[prod]);
            const stockList = Array.isArray(db.stock[prod]) ? db.stock[prod] : [];
            const userBal = Number(db.saldos[sender.jid] || 0);

            if (!stockList.length) {
              await sock.sendMessage(sender.remote, { text: "❌ Producto agotado." });
              continue;
            }
            if (userBal < price) {
              await sock.sendMessage(sender.remote, { text: `❌ Saldo insuficiente.` });
              continue;
            }

            const credential = stockList[0];
            await sock.sendMessage(sender.jid, { text: `🎉 *COMPRA EXITOSA*\n\n📦 ${prod.toUpperCase()}\n🔐 Datos:\n${credential}` });

            db.saldos[sender.jid] = userBal - price;
            db.stock[prod].shift();
            saveDB(db);
            continue;
          }

          if (!isAdmin(sender.number)) continue;

          if (cmd === "addsaldo") {
            const target = cleanNum(args[0]);
            const amount = Number(args[1]);
            if (!target || !Number.isFinite(amount)) continue;
            const jid = `${target}@s.whatsapp.net`;
            db.saldos[jid] = Number(db.saldos[jid] || 0) + amount;
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Saldo agregado.` });
            continue;
          }

          if (cmd === "addstock") {
            const prod = (args.shift() || "").toLowerCase();
            const acc = args.join(" ").trim();
            if (!prod || !acc) continue;
            if (!db.stock[prod]) db.stock[prod] = [];
            db.stock[prod].push(acc);
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Stock agregado a ${prod}.` });
            continue;
          }

          if (cmd === "setprecio") {
            const prod = (args[0] || "").toLowerCase();
            const price = Number(args[1]);
            if (!prod || !Number.isFinite(price)) continue;
            db.precios[prod] = price;
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Precio fijado.` });
            continue;
          }

        } catch (e) {}
      }
    });

  } catch (e) {
    sock = null;
    setTimeout(startBot, 8000);
  }
}

app.get("/", (req, res) => {
  res.send("<h2>✅ Bot activo. Revisa los Deploy Logs de Railway para escanear el QR.</h2>");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
  setTimeout(startBot, 2000);
});

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});