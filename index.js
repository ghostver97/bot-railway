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

function defaultDB() {
  return {
    saldos: {},
    stock: {},
    precios: {},
    pagos: {
      transferencia: "No configurado",
      oxxo: "No configurado"
    }
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const db = defaultDB();
      saveDB(db);
      return db;
    }
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...defaultDB(),
      ...raw,
      saldos: raw.saldos || {},
      stock: raw.stock || {},
      precios: raw.precios || {},
      pagos: { ...defaultDB().pagos, ...(raw.pagos || {}) }
    };
  } catch (e) {
    return defaultDB();
  }
}

function saveDB(db) {
  try {
    const temp = `${DB_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(temp, DB_FILE);
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

function getAdminNumbers() {
  return (process.env.ADMIN_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean);
}

function isConfiguredAdmin(number) {
  return getAdminNumbers().includes(normalizeNumber(number));
}

async function isGroupAdmin(groupJid, number) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const wanted = normalizeNumber(number);
    const participant = metadata.participants.find(p => normalizeNumber(p.id) === wanted);
    return !!participant && (participant.admin === "admin" || participant.admin === "superadmin");
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
  if (!sock) throw new Error("WhatsApp no está conectado");
  return await sock.sendMessage(to, { text });
}

function menuText(db, sender) {
  const products = Object.keys(db.precios);
  let text = `🛒 *TIENDA SAMANTHA*\n\n💰 Saldo: *$${db.saldos[sender.jid] || 0} MXN*\n\n📦 *PRODUCTOS*\n`;
  if (!products.length) {
    text += "\n_No hay productos configurados._\n";
  } else {
    for (const product of products) {
      const stock = Array.isArray(db.stock[product]) ? db.stock[product].length : 0;
      text += `\n• *${product.toUpperCase()}* — $${db.precios[product]} MXN — Stock: ${stock}`;
    }
  }
  text += `\n\n📋 *COMANDOS*\n.menu — Ver tienda\n.saldo — Ver saldo\n.pagos — Ver métodos de pago\n.comprar producto — Comprar\n.stock — Ver inventario\n`;
  return text;
}

function paymentsText(db) {
  return `💳 *MÉTODOS DE PAGO*\n\n🏦 *TRANSFERENCIA*\n${db.pagos.transferencia || "No configurado"}\n\n🏪 *OXXO*\n${db.pagos.oxxo || "No configurado"}\n\n📩 Después de pagar, envía tu comprobante al administrador.`;
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
    const text = menuText(db, sender);
    if (fs.existsSync(MENU_IMAGE)) {
      await sock.sendMessage(sender.remote, { image: fs.readFileSync(MENU_IMAGE), caption: text });
    } else {
      await sendText(sender.remote, text);
    }
    return;
  }

  if (command === "saldo") {
    await sendText(sender.remote, `💰 Tu saldo actual es: *$${db.saldos[sender.jid] || 0} MXN*`);
    return;
  }

  if (command === "pagos" || command === "metodos") {
    const text = paymentsText(db);
    const pagosImagePath = path.join(process.cwd(), "pagos.png");
    if (fs.existsSync(pagosImagePath)) {
      await sock.sendMessage(sender.remote, { image: fs.readFileSync(pagosImagePath), caption: text });
    } else {
      await sendText(sender.remote, text);
    }
    return;
  }

  if (command === "stock") {
    let text = "📦 *INVENTARIO*\n";
    for (const product of Object.keys(db.precios)) {
      const count = Array.isArray(db.stock[product]) ? db.stock[product].length : 0;
      text += `\n• *${product.toUpperCase()}*: ${count} disponibles`;
    }
    await sendText(sender.remote, text);
    return;
  }

  if (command === "comprar") {
    const product = String(args[0] || "").toLowerCase();
    if (!product || db.precios[product] == null) {
      await sendText(sender.remote, "❌ Producto no válido. Usa *.menu* para ver la tienda.");
      return;
    }
    const price = Number(db.precios[product]);
    const stock = Array.isArray(db.stock[product]) ? db.stock[product] : [];
    const balance = Number(db.saldos[sender.jid] || 0);

    if (!stock.length) {
      await sendText(sender.remote, "❌ Ese producto está agotado.");
      return;
    }
    if (balance < price) {
      await sendText(sender.remote, `❌ Saldo insuficiente.\n\nPrecio: $${price} MXN\nTu saldo: $${balance} MXN`);
      return;
    }

    const account = stock[0];
    try {
      await sendText(sender.jid, `🎉 *¡COMPRA EXITOSA!*\n\n📦 Producto: *${product.toUpperCase()}*\n💵 Precio: *$${price} MXN*\n\n🔐 *TUS DATOS*\n${account}\n\n💰 Saldo restante: *$${balance - price} MXN*\n\nGracias por tu compra.`);
    } catch (deliveryError) {
      await sendText(sender.remote, "⚠️ La compra no pudo entregarse por privado. No se descontó tu saldo.");
      return;
    }

    db.saldos[sender.jid] = balance - price;
    db.stock[product].shift();
    saveDB(db);

    if (sender.isGroup) {
      await sendText(sender.remote, `✅ Compra de *${product.toUpperCase()}* realizada.\n🔐 Revisa tu chat privado.`);
    }
    return;
  }

  if (command === "addsaldo") {
    if (!(await canAdmin(sender))) return sendText(sender.remote, "❌ Solo un administrador.");
    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const targetJid = mentioned || jidFromNumber(args[0]);
    const amount = Number(args[mentioned ? 0 : 1]);
    if (!targetJid || !Number.isFinite(amount) || amount <= 0) return sendText(sender.remote, "Uso: .addsaldo NUMERO CANTIDAD");
    db.saldos[targetJid] = Number(db.saldos[targetJid] || 0) + amount;
    saveDB(db);
    await sendText(sender.remote, `✅ Saldo agregado: *$${amount} MXN*`);
    return;
  }

  if (command === "addstock") {
    if (!(await canAdmin(sender))) return sendText(sender.remote, "❌ Solo un administrador.");
    const product = String(args.shift() || "").toLowerCase();
    const account = args.join(" ").trim();
    if (!product || !account) return sendText(sender.remote, "Uso: .addstock netflix cuenta");
    if (!db.stock[product]) db.stock[product] = [];
    db.stock[product].push(account);
    saveDB(db);
    await sendText(sender.remote, `✅ Stock agregado a *${product}*. Total: *${db.stock[product].length}*`);
    return;
  }

  if (command === "setprecio") {
    if (!(await canAdmin(sender))) return sendText(sender.remote, "❌ Solo un administrador.");
    const product = String(args[0] || "").toLowerCase();
    const price = Number(args[1]);
    if (!product || !Number.isFinite(price) || price < 0) return sendText(sender.remote, "Uso: .setprecio netflix 65");
    db.precios[product] = price;
    if (!db.stock[product]) db.stock[product] = [];
    saveDB(db);
    await sendText(sender.remote, `✅ Precio de *${product}* establecido en *$${price} MXN*.`);
    return;
  }

  if (command === "abrir" || command === "cerrar") {
    if (!sender.isGroup || !(await canAdmin(sender))) return;
    try {
      await sock.groupSettingUpdate(sender.remote, command === "abrir" ? "not_announcement" : "announcement");
      await sendText(sender.remote, command === "abrir" ? "🔓 Grupo abierto." : "🔒 Grupo cerrado.");
    } catch (e) {}
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
        console.log("📱 QR generado con éxito.");
      }

      if (connection === "open") {
        qrImage = "";
        console.log("✅ Conectado a WhatsApp con éxito.");
      }

      if (connection === "close") {
        qrImage = "";
        sock = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Desconectado. Código: ${statusCode}`);
        
        // Si hay error de sesión, limpiamos automáticamente para forzar nuevo QR limpio
        if (statusCode === DisconnectReason.loggedOut || !statusCode) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
        }
        setTimeout(startBot, 4000);
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
    setTimeout(startBot, 6000);
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
        <title>Bot WhatsApp - QR</title>
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
          <p>Escanea el código QR:</p>
          <img src="${qrImage}" alt="QR Code">
          <p style="font-size:12px; color:#888;">Se actualiza automáticamente</p>
        </div>
      </body>
      </html>
    `);
  }
  res.send("<h2>✅ Bot de WhatsApp activo y conectado.</h2>");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, connected: !!sock });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP activo en puerto ${PORT}`);
  
  // Limpiamos la sesión corrupta anterior antes de iniciar para forzar QR fresco
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}

  setTimeout(startBot, 2000);
});

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});