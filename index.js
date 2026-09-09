const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const QRCode = require("qrcode");

const app = express();
const PORT = Number(process.env.PORT || 8080);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "datos");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MENU_IMAGE = path.join(process.cwd(), "menu.jpg");
const AUTH_DIR = path.join(DATA_DIR, "auth_info_baileys");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

let qrImage = "";
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

function normalizeNumber(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function jidFromNumber(number) {
  const clean = normalizeNumber(number);
  return clean ? `${clean}@s.whatsapp.net` : null;
}

function getSender(m) {
  const remote = m.key.remoteJid || "";
  const isGroup = remote.endsWith("@g.us");
  const raw = isGroup ? (m.key.participant || m.participant || "") : remote;
  const number = normalizeNumber(raw);
  return { remote, isGroup, number, jid: jidFromNumber(number) };
}

function isConfiguredAdmin(number) {
  const admins = (process.env.ADMIN_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean);
  return admins.includes(normalizeNumber(number));
}

async function isGroupAdmin(groupJid, number) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const wanted = normalizeNumber(number);
    const p = metadata.participants.find(item => normalizeNumber(item.id) === wanted);
    return !!p && (p.admin === "admin" || p.admin === "superadmin");
  } catch (e) {
    return false;
  }
}

async function canAdmin(sender) {
  if (isConfiguredAdmin(sender.number)) return true;
  if (sender.isGroup) return await isGroupAdmin(sender.remote, sender.number);
  return false;
}

async function sendText(to, text) {
  if (!sock) throw new Error("No conectado");
  return await sock.sendMessage(to, { text });
}

async function handleCommand(m) {
  if (!m.message || m.key.fromMe) return;
  const sender = getSender(m);
  if (!sender.number || !sender.jid) return;

  const body = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "";
  if (!body.trim().startsWith(".")) return;

  const parts = body.trim().slice(1).split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  const args = parts;
  const db = loadDB();

  if (command === "menu" || command === "tienda") {
    let text = `🛒 *TIENDA SAMANTHA*\n\n💰 Saldo: *$${db.saldos[sender.jid] || 0} MXN*\n\n📦 *PRODUCTOS*\n`;
    const products = Object.keys(db.precios);
    if (!products.length) text += "\n_No hay productos._\n";
    else {
      products.forEach(p => {
        text += `\n• *${p.toUpperCase()}* — $${db.precios[p]} MXN — Stock: ${(db.stock[p] || []).length}`;
      });
    }
    if (fs.existsSync(MENU_IMAGE)) {
      await sock.sendMessage(sender.remote, { image: fs.readFileSync(MENU_IMAGE), caption: text });
    } else {
      await sendText(sender.remote, text);
    }
    return;
  }

  if (command === "saldo") {
    await sendText(sender.remote, `💰 Tu saldo: *$${db.saldos[sender.jid] || 0} MXN*`);
    return;
  }

  if (command === "comprar") {
    const product = String(args[0] || "").toLowerCase();
    if (!product || db.precios[product] == null) {
      await sendText(sender.remote, "❌ Producto no válido.");
      return;
    }
    const price = Number(db.precios[product]);
    const stock = Array.isArray(db.stock[product]) ? db.stock[product] : [];
    const balance = Number(db.saldos[sender.jid] || 0);

    if (!stock.length) {
      await sendText(sender.remote, "❌ Producto agotado.");
      return;
    }
    if (balance < price) {
      await sendText(sender.remote, `❌ Saldo insuficiente ($${balance} MXN / Requerido: $${price} MXN).`);
      return;
    }

    const account = stock[0];
    try {
      await sendText(sender.jid, `🎉 *¡COMPRA EXITOSA!*\n\n📦 ${product.toUpperCase()}\n🔐 Datos:\n${account}\n\n💰 Saldo restante: *$${balance - price} MXN*`);
    } catch (e) {
      await sendText(sender.remote, "⚠️ No se pudo enviar por privado. Intenta de nuevo.");
      return;
    }

    db.saldos[sender.jid] = balance - price;
    db.stock[product].shift();
    saveDB(db);

    if (sender.isGroup) {
      await sendText(sender.remote, `✅ Compra de *${product.toUpperCase()}* realizada. Revisa tu chat privado.`);
    }
    return;
  }

  if (command === "addsaldo") {
    if (!(await canAdmin(sender))) return;
    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const targetJid = mentioned || jidFromNumber(args[0]);
    const amount = Number(args[mentioned ? 0 : 1]);
    if (!targetJid || !Number.isFinite(amount)) return;
    db.saldos[targetJid] = Number(db.saldos[targetJid] || 0) + amount;
    saveDB(db);
    await sendText(sender.remote, `✅ Agregados $${amount} MXN al usuario.`);
    return;
  }

  if (command === "addstock") {
    if (!(await canAdmin(sender))) return;
    const product = String(args.shift() || "").toLowerCase();
    const account = args.join(" ").trim();
    if (!product || !account) return;
    if (!db.stock[product]) db.stock[product] = [];
    db.stock[product].push(account);
    saveDB(db);
    await sendText(sender.remote, `✅ Stock agregado a *${product}*. Total: ${db.stock[product].length}`);
    return;
  }

  if (command === "setprecio") {
    if (!(await canAdmin(sender))) return;
    const product = String(args[0] || "").toLowerCase();
    const price = Number(args[1]);
    if (!product || !Number.isFinite(price)) return;
    db.precios[product] = price;
    if (!db.stock[product]) db.stock[product] = [];
    saveDB(db);
    await sendText(sender.remote, `✅ Precio de *${product}* fijado en $${price} MXN.`);
    return;
  }
}

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
      }

      if (connection === "open") {
        qrImage = "";
        console.log("✅ Conectado a WhatsApp correctamente.");
      }

      if (connection === "close") {
        qrImage = "";
        sock = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Desconectado. Código: ${statusCode}`);
        if (statusCode === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        }
        setTimeout(startBot, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        try { await handleCommand(message); } catch (e) {}
      }
    });
  } catch (e) {
    sock = null;
    setTimeout(startBot, 8000);
  }
}

app.get("/", (req, res) => {
  if (qrImage) {
    return res.send(`
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Vincular Bot WhatsApp</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body{font-family:Arial,sans-serif;background:#111;color:#fff;text-align:center;padding:40px}
          .card{max-width:400px;margin:auto;background:#1d1d1d;padding:30px;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.5)}
          img{max-width:100%;background:#fff;padding:10px;border-radius:10px}
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📱 Vincular Bot</h2>
          <p>Escanea este código QR:</p>
          <img src="${qrImage}" alt="QR Code">
          <p style="font-size:12px; color:#888;">La página se actualiza sola</p>
        </div>
      </body>
      </html>
    `);
  }
  res.send("<h2>✅ Bot de WhatsApp activo y conectado.</h2>");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP en puerto ${PORT}`);
  setTimeout(startBot, 3000);
});

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});