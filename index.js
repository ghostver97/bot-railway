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
const AUTH_DIR = path.join(DATA_DIR, "auth_info_baileys");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

let qrDataURL = "";
let sock = null;

function loadDB() {
  const defaultDB = {
    saldos: {},
    stock: {},
    precios: {},
    pagos: {
      transferencia: "No configurado",
      oxxo: "No configurado"
    }
  };
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
  return {
    remote,
    isGroup,
    number,
    jid: number ? `${number}@s.whatsapp.net` : null
  };
}

function isAdmin(num) {
  const admins = (process.env.ADMIN_NUMBERS || "").split(",").map(cleanNum).filter(Boolean);
  return admins.includes(cleanNum(num));
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
      markOnlineOnConnect: false,
      browser: ["TiendaBot", "Chrome", "120.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataURL = await QRCode.toDataURL(qr);
        console.log("📱 Nuevo QR generado para escanear en la web.");
      }

      if (connection === "open") {
        qrDataURL = "";
        console.log("✅ ¡Bot conectado a WhatsApp con éxito!");
      }

      if (connection === "close") {
        qrDataURL = "";
        sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Conexión cerrada. Código: ${code}`);

        if (code === DisconnectReason.loggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
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

          const text =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            "";

          if (!text.trim().startsWith(".")) continue;

          const args = text.trim().slice(1).split(/\s+/);
          const cmd = (args.shift() || "").toLowerCase();
          const db = loadDB();

          // Menú
          if (cmd === "menu" || cmd === "tienda") {
            let msg = `🛒 *TIENDA SAMANTHA*\n\n💰 Tu Saldo: *$${db.saldos[sender.jid] || 0} MXN*\n\n📦 *PLATAFORMAS DISPONIBLES*\n`;
            const keys = Object.keys(db.precios);
            if (!keys.length) {
              msg += "\n_No hay productos configurados._\n";
            } else {
              keys.forEach(p => {
                const stockCount = (db.stock[p] || []).length;
                msg += `\n• *${p.toUpperCase()}* — $${db.precios[p]} MXN (Stock: ${stockCount})`;
              });
            }
            msg += `\n\n📋 *Comandos:*\n.menu\n.saldo\n.comprar [producto]\n.pagos`;
            await sock.sendMessage(sender.remote, { text: msg });
            continue;
          }

          // Saldo
          if (cmd === "saldo") {
            await sock.sendMessage(sender.remote, { text: `💰 Tu saldo actual es: *$${db.saldos[sender.jid] || 0} MXN*` });
            continue;
          }

          // Pagos
          if (cmd === "pagos") {
            await sock.sendMessage(sender.remote, {
              text: `💳 *MÉTODOS DE PAGO*\n\n🏦 Transferencia:\n${db.pagos.transferencia}\n\n🏪 OXXO:\n${db.pagos.oxxo}\n\n📩 Envía tu comprobante al admin.`
            });
            continue;
          }

          // Comprar
          if (cmd === "comprar") {
            const prod = (args[0] || "").toLowerCase();
            if (!prod || db.precios[prod] == null) {
              await sock.sendMessage(sender.remote, { text: "❌ Producto inválido. Usa .menu" });
              continue;
            }

            const price = Number(db.precios[prod]);
            const stockList = Array.isArray(db.stock[prod]) ? db.stock[prod] : [];
            const userBal = Number(db.saldos[sender.jid] || 0);

            if (!stockList.length) {
              await sock.sendMessage(sender.remote, { text: "❌ Producto agotado temporalmente." });
              continue;
            }
            if (userBal < price) {
              await sock.sendMessage(sender.remote, { text: `❌ Saldo insuficiente.\nPrecio: $${price} MXN\nTu saldo: $${userBal} MXN` });
              continue;
            }

            const credential = stockList[0];
            try {
              // Entrega privada al DM del usuario
              await sock.sendMessage(sender.jid, {
                text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 Producto: *${prod.toUpperCase()}*\n🔐 *Tus datos de acceso:*\n${credential}\n\n💰 Saldo restante: *$${userBal - price} MXN*`
              });
            } catch (err) {
              await sock.sendMessage(sender.remote, { text: "⚠️ No pude enviarte mensaje privado. Inícianos chat privado primero." });
              continue;
            }

            db.saldos[sender.jid] = userBal - price;
            db.stock[prod].shift();
            saveDB(db);

            if (sender.isGroup) {
              await sock.sendMessage(sender.remote, { text: `✅ Compra de *${prod.toUpperCase()}* procesada con éxito. Revisa tu chat privado 🔐.` });
            }
            continue;
          }

          // --- COMANDOS DE ADMIN ---
          if (!isAdmin(sender.number)) continue;

          if (cmd === "addsaldo") {
            const target = cleanNum(args[0]);
            const amount = Number(args[1]);
            if (!target || !Number.isFinite(amount)) {
              await sock.sendMessage(sender.remote, { text: "Uso: .addsaldo NUMERO MONTO" });
              continue;
            }
            const jid = `${target}@s.whatsapp.net`;
            db.saldos[jid] = Number(db.saldos[jid] || 0) + amount;
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Saldo actualizado a ${target}: +$${amount} MXN` });
            continue;
          }

          if (cmd === "addstock") {
            const prod = (args.shift() || "").toLowerCase();
            const accountData = args.join(" ").trim();
            if (!prod || !accountData) {
              await sock.sendMessage(sender.remote, { text: "Uso: .addstock netflix correo:pass" });
              continue;
            }
            if (!db.stock[prod]) db.stock[prod] = [];
            db.stock[prod].push(accountData);
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Stock agregado a *${prod}*. Total: ${db.stock[prod].length}` });
            continue;
          }

          if (cmd === "setprecio") {
            const prod = (args[0] || "").toLowerCase();
            const price = Number(args[1]);
            if (!prod || !Number.isFinite(price)) {
              await sock.sendMessage(sender.remote, { text: "Uso: .setprecio netflix 50" });
              continue;
            }
            db.precios[prod] = price;
            if (!db.stock[prod]) db.stock[prod] = [];
            saveDB(db);
            await sock.sendMessage(sender.remote, { text: `✅ Precio de *${prod}* fijado en $${price} MXN.` });
            continue;
          }

        } catch (err) {}
      }
    });

  } catch (e) {
    sock = null;
    setTimeout(startBot, 10000);
  }
}

app.get("/", (req, res) => {
  if (qrDataURL) {
    return res.send(`
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>Vincular Bot - Tienda Samantha</title>
        <meta http-equiv="refresh" content="4">
        <style>
          body{font-family:Arial,sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding:50px}
          .box{max-width:420px;margin:auto;background:#161b22;padding:30px;border-radius:16px;border:1px solid #30363d}
          img{background:#fff;padding:10px;border-radius:10px;max-width:100%}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🤖 Vincular Tienda Samantha</h2>
          <p>Escanea el código QR con tu WhatsApp:</p>
          <img src="${qrDataURL}" alt="QR Code">
          <p style="font-size:12px;color:#8b949e;margin-top:15px">La página se recarga automáticamente</p>
        </div>
      </body>
      </html>
    `);
  }
  res.send(`
    <!doctype html>
    <html lang="es">
    <body style="font-family:Arial;background:#111;color:#fff;text-align:center;padding:50px">
      <h1>✅ ¡Tienda Samantha Bot en Línea y Conectado!</h1>
      <p>El bot está vinculado correctamente a WhatsApp y operando con el volumen persistente.</p>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, connected: !!sock });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor web iniciado en puerto ${PORT}`);
  setTimeout(startBot, 2000);
});

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});