const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const QRCode = require("qrcode");

const app = express();
const PORT = Number(process.env.PORT || 8080);

// En Railway crea un Volume montado en /app/datos.
// Si no existe DATA_DIR, usa ./datos.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "datos");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MENU_IMAGE = path.join(process.cwd(), "menu.png");
const AUTH_DIR = path.join(DATA_DIR, "auth_info_baileys");

fs.mkdirSync(DATA_DIR, { recursive: true });

let qrImage = "";
let sock = null;
let starting = false;

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
    const db = {
      ...defaultDB(),
      ...raw,
      saldos: raw.saldos || {},
      stock: raw.stock || {},
      precios: raw.precios || {},
      pagos: { ...defaultDB().pagos, ...(raw.pagos || {}) }
    };
    return db;
  } catch (e) {
    console.error("❌ Error leyendo DB:", e);
    return defaultDB();
  }
}

function saveDB(db) {
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(temp, DB_FILE);
}

function normalizeNumber(value) {
  return String(value || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function jidFromNumber(number) {
  const clean = normalizeNumber(number);
  return clean ? `${clean}@s.whatsapp.net` : null;
}

function getSender(m) {
  const remote = m.key.remoteJid || "";
  const isGroup = remote.endsWith("@g.us");
  const raw = isGroup
    ? (m.key.participant || m.participant || "")
    : remote;

  const number = normalizeNumber(raw);
  return {
    remote,
    isGroup,
    number,
    jid: jidFromNumber(number)
  };
}

function getAdminNumbers() {
  return (process.env.ADMIN_NUMBERS || "")
    .split(",")
    .map(normalizeNumber)
    .filter(Boolean);
}

function isConfiguredAdmin(number) {
  return getAdminNumbers().includes(normalizeNumber(number));
}

async function isGroupAdmin(groupJid, number) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const wanted = normalizeNumber(number);

    const participant = metadata.participants.find(
      p => normalizeNumber(p.id) === wanted
    );

    return !!participant &&
      (participant.admin === "admin" || participant.admin === "superadmin");
  } catch (e) {
    console.error("❌ No se pudo comprobar admin del grupo:", e);
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

  let text =
`🛒 *TIENDA SAMANTHA*

💰 Saldo: *$${db.saldos[sender.jid] || 0} MXN*

📦 *PRODUCTOS*
`;

  if (!products.length) {
    text += "\n_No hay productos configurados._\n";
  } else {
    for (const product of products) {
      const stock = Array.isArray(db.stock[product]) ? db.stock[product].length : 0;
      text += `\n• *${product.toUpperCase()}* — $${db.precios[product]} MXN — Stock: ${stock}`;
    }
  }

  text +=
`

📋 *COMANDOS*
.menu — Ver tienda
.saldo — Ver saldo
.pagos — Ver métodos de pago
.comprar producto — Comprar
.stock — Ver inventario
`;

  return text;
}

function paymentsText(db) {
  return `💳 *MÉTODOS DE PAGO*

🏦 *TRANSFERENCIA*
${db.pagos.transferencia || "No configurado"}

🏪 *OXXO*
${db.pagos.oxxo || "No configurado"}

📩 Después de pagar, envía tu comprobante al administrador.`;
}

async function handleCommand(m) {
  if (!m.message || m.key.fromMe) return;

  const sender = getSender(m);
  if (!sender.number || !sender.jid) return;

  const body =
    m.message.conversation ||
    m.message.extendedTextMessage?.text ||
    m.message.imageMessage?.caption ||
    m.message.videoMessage?.caption ||
    "";

  if (!body.trim().startsWith(".")) return;

  const parts = body.trim().slice(1).split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  const args = parts;
  const db = loadDB();

  console.log(`📩 .${command} de ${sender.number} ${sender.isGroup ? "(grupo)" : "(privado)"}`);

  if (command === "menu" || command === "tienda") {
    const text = menuText(db, sender);

    if (fs.existsSync(MENU_IMAGE)) {
      await sock.sendMessage(sender.remote, {
        image: fs.readFileSync(MENU_IMAGE),
        caption: text
      });
    } else {
      await sendText(sender.remote, text);
    }
    return;
  }

  if (command === "saldo") {
    await sendText(
      sender.remote,
      `💰 Tu saldo actual es: *$${db.saldos[sender.jid] || 0} MXN*`
    );
    return;
  }

  if (command === "pagos" || command === "metodos") {
    const text = paymentsText(db);

    if (fs.existsSync(path.join(process.cwd(), "pagos.png"))) {
      await sock.sendMessage(sender.remote, {
        image: fs.readFileSync(path.join(process.cwd(), "pagos.png")),
        caption: text
      });
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
      await sendText(
        sender.remote,
        `❌ Saldo insuficiente.\n\nPrecio: $${price} MXN\nTu saldo: $${balance} MXN`
      );
      return;
    }

    const account = stock[0];

    // Primero intentamos entregar por privado.
    // Si WhatsApp rechaza el envío, NO se descuenta el saldo ni se elimina el stock.
    try {
      await sendText(
        sender.jid,
`🎉 *¡COMPRA EXITOSA!*

📦 Producto: *${product.toUpperCase()}*
💵 Precio: *$${price} MXN*

🔐 *TUS DATOS*
${account}

💰 Saldo restante: *$${balance - price} MXN*

Gracias por tu compra.`
      );
    } catch (deliveryError) {
      console.error("❌ FALLÓ LA ENTREGA PRIVADA:", deliveryError);
      await sendText(
        sender.remote,
        "⚠️ La compra no pudo entregarse por privado. No se descontó tu saldo. Intenta nuevamente o contacta al administrador."
      );
      return;
    }

    // Solo después de entregar correctamente se confirma la venta.
    db.saldos[sender.jid] = balance - price;
    db.stock[product].shift();
    saveDB(db);

    if (sender.isGroup) {
      await sendText(
        sender.remote,
        `✅ Compra de *${product.toUpperCase()}* realizada.\n🔐 Revisa tu chat privado.`
      );
    }

    console.log(`✅ VENTA: ${sender.number} compró ${product} por $${price}`);
    return;
  }

  // ----- ADMIN -----

  if (command === "addsaldo") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador puede usar este comando.");
      return;
    }

    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const targetJid = mentioned || jidFromNumber(args[0]);
    const amount = Number(args[mentioned ? 0 : 1]);

    if (!targetJid || !Number.isFinite(amount) || amount <= 0) {
      await sendText(
        sender.remote,
        "Uso:\n.addsaldo NUMERO CANTIDAD\n\nO menciona al usuario y usa:\n.addsaldo CANTIDAD"
      );
      return;
    }

    db.saldos[targetJid] = Number(db.saldos[targetJid] || 0) + amount;
    saveDB(db);

    await sendText(
      sender.remote,
      `✅ Saldo agregado: *$${amount} MXN*\n💰 Nuevo saldo: *$${db.saldos[targetJid]} MXN*`
    );
    return;
  }

  if (command === "addstock") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador puede usar este comando.");
      return;
    }

    const product = String(args.shift() || "").toLowerCase();
    const account = args.join(" ").trim();

    if (!product || !account) {
      await sendText(
        sender.remote,
        "Uso:\n.addstock netflix correo@ejemplo.com:contraseña"
      );
      return;
    }

    if (!db.stock[product]) db.stock[product] = [];
    db.stock[product].push(account);

    saveDB(db);

    await sendText(
      sender.remote,
      `✅ Stock agregado a *${product}*.\n📦 Total: *${db.stock[product].length}*`
    );
    return;
  }

  if (command === "setprecio") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador puede usar este comando.");
      return;
    }

    const product = String(args[0] || "").toLowerCase();
    const price = Number(args[1]);

    if (!product || !Number.isFinite(price) || price < 0) {
      await sendText(sender.remote, "Uso:\n.setprecio netflix 65");
      return;
    }

    db.precios[product] = price;
    if (!db.stock[product]) db.stock[product] = [];
    saveDB(db);

    await sendText(
      sender.remote,
      `✅ Precio de *${product}* establecido en *$${price} MXN*.`
    );
    return;
  }

  if (command === "addpago") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador puede usar este comando.");
      return;
    }

    const method = String(args.shift() || "").toLowerCase();
    const details = args.join(" ").trim();

    if (!["transferencia", "oxxo"].includes(method) || !details) {
      await sendText(
        sender.remote,
        "Uso:\n.addpago transferencia BBVA CLABE XXXXX\n.addpago oxxo Número XXXXX"
      );
      return;
    }

    db.pagos[method] = details;
    saveDB(db);

    await sendText(sender.remote, `✅ Método de pago *${method}* actualizado.`);
    return;
  }

  if (command === "delpago") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador puede usar este comando.");
      return;
    }

    const method = String(args[0] || "").toLowerCase();

    if (!["transferencia", "oxxo"].includes(method)) {
      await sendText(sender.remote, "Uso:\n.delpago transferencia\n.delpago oxxo");
      return;
    }

    db.pagos[method] = "No configurado";
    saveDB(db);

    await sendText(sender.remote, `✅ Método *${method}* eliminado.`);
    return;
  }

  if (command === "abrir" || command === "cerrar") {
    if (!sender.isGroup) {
      await sendText(sender.remote, "❌ Este comando solo funciona dentro de un grupo.");
      return;
    }

    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ Solo un administrador del grupo puede usarlo.");
      return;
    }

    try {
      const setting = command === "abrir" ? "not_announcement" : "announcement";
      await sock.groupSettingUpdate(sender.remote, setting);

      await sendText(
        sender.remote,
        command === "abrir"
          ? "🔓 *GRUPO ABIERTO*\nTodos pueden enviar mensajes."
          : "🔒 *GRUPO CERRADO*\nSolo los administradores pueden enviar mensajes."
      );
    } catch (e) {
      console.error("❌ Error cambiando configuración del grupo:", e);
      await sendText(
        sender.remote,
        "❌ No pude cambiar la configuración. Asegúrate de que el bot sea administrador del grupo."
      );
    }
    return;
  }

  if (command === "admin") {
    if (!(await canAdmin(sender))) {
      await sendText(sender.remote, "❌ No tienes permisos de administrador.");
      return;
    }

    await sendText(
      sender.remote,
`🛠️ *COMANDOS DE ADMIN*

.addsaldo NUMERO CANTIDAD
.addsaldo CANTIDAD (mencionando al usuario)

.addstock producto cuenta
.setprecio producto precio

.addpago transferencia datos
.addpago oxxo datos
.delpago transferencia
.delpago oxxo

.abrir
.cerrar

.pagos
.stock`
    );
    return;
  }

  await sendText(
    sender.remote,
    "❓ Comando no reconocido. Usa *.menu* para ver las opciones."
  );
}

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const newSock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock = newSock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrImage = await QRCode.toDataURL(qr);
          console.log("📱 QR generado. Abre la URL de Railway para escanearlo.");
        } catch (e) {
          console.error("❌ Error generando QR:", e);
        }
      }

      if (connection === "open") {
        qrImage = "";
        console.log("✅ WhatsApp conectado correctamente.");
      }

      if (connection === "close") {
        qrImage = "";

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `⚠️ WhatsApp desconectado. Código: ${statusCode}. Reconectar: ${shouldReconnect}`
        );

        sock = null;

        if (shouldReconnect) {
          setTimeout(() => {
            starting = false;
            startBot();
          }, 5000);
        } else {
          console.log("🔐 Sesión cerrada. Borra la sesión del volumen y vuelve a vincular.");
          starting = false;
        }
      }
    });

    newSock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        try {
          await handleCommand(message);
        } catch (e) {
          console.error("❌ ERROR PROCESANDO MENSAJE:", e);

          try {
            const sender = getSender(message);
            if (sender.remote) {
              await sendText(
                sender.remote,
                "⚠️ Ocurrió un error procesando el comando. Revisa los logs de Railway."
              );
            }
          } catch (_) {}
        }
      }
    });

  } catch (e) {
    console.error("❌ ERROR INICIANDO BOT:", e);
    sock = null;
    setTimeout(() => {
      starting = false;
      startBot();
    }, 10000);
    return;
  }

  starting = false;
}

// Web server para Railway y página del QR.
app.get("/", (req, res) => {
  if (qrImage) {
    return res.send(`
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Bot WhatsApp</title>
        <style>
          body{font-family:Arial,sans-serif;background:#111;color:#fff;text-align:center;padding:30px}
          .card{max-width:430px;margin:auto;background:#1d1d1d;padding:25px;border-radius:18px}
          img{max-width:100%;background:#fff;padding:10px;border-radius:12px}
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📱 Vincular Bot WhatsApp</h2>
          <p>Escanea este QR desde WhatsApp → Dispositivos vinculados.</p>
          <img src="${qrImage}" alt="QR">
          <p>La página se actualiza automáticamente.</p>
        </div>
      </body>
      </html>
    `);
  }

  res.send("✅ Bot de WhatsApp activo.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    whatsapp: !!sock,
    qr: !!qrImage
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP activo en puerto ${PORT}`);
  console.log(`📁 Datos: ${DATA_DIR}`);
  console.log(`👑 Administradores configurados: ${getAdminNumbers().length}`);
});

startBot();

process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("💥 unhandledRejection:", err);
});
