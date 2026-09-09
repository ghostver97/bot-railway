const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

// Variable global para guardar la imagen del QR
let qrImage = '';

// --- SERVIDOR EXPRESS ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    if (qrImage) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>QR Bot WhatsApp</title>
                <meta http-equiv="refresh" content="10">
                <style>
                    body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; background: #f4f4f9; margin: 0; }
                    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); text-align: center; }
                    img { width: 280px; height: 280px; margin: 15px 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>Escanea el QR para vincular el Bot</h2>
                    <img src="${qrImage}" alt="QR Code"/>
                    <p>Bot Tienda Samantha Online 24/7 🚀</p>
                    <small style="color: gray;">La página se actualiza automáticamente cada 10s</small>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                <h2>Bot Tienda Samantha Online 24/7 🚀</h2>
                <p>El bot ya está <b>conectado</b> o se está generando el código QR... (Recarga en unos segundos)</p>
            </div>
        `);
    }
});

app.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));

// --- BASE DE DATOS LOCAL Y SESIÓN (Carpeta datos) ---
// Creamos la carpeta 'datos' si no existe
if (!fs.existsSync('./datos')) {
    fs.mkdirSync('./datos');
}
const DB_FILE = './datos/db.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = { saldos: {}, stock: {}, precios: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        return { saldos: {}, stock: {}, precios: {} };
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- LÓGICA PRINCIPAL DEL BOT ---
async function startBot() {
    // Cambiamos la ruta de la sesión a la carpeta 'datos'
    const { state, saveCreds } = await useMultiFileAuthState('./datos/auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Generar imagen base64 si Baileys entrega un nuevo QR
        if (qr) {
            qrImage = await QRCode.toDataURL(qr);
            console.log('⚡ Nuevo QR generado. Disponible en la ruta Web.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Intentando reconectar...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrImage = ''; // Limpia el QR al conectarse con éxito
            console.log('✅ Bot conectado exitosamente a WhatsApp.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? m.key.participant : from;

        const body = m.message.conversation ||
                     m.message.extendedTextMessage?.text || '';

        if (!body.startsWith('.')) return;

        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        const db = loadDB();

        async function isAdmin() {
            if (!isGroup) return false;
            try {
                const metadata = await sock.groupMetadata(from);
                const participant = metadata.participants.find(p => p.id === sender);
                return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
            } catch (e) {
                return false;
            }
        }

        // === COMANDOS CLIENTES ===

        if (command === 'menu' || command === 'tienda') {
            let text = `🛒 *MENÚ DE TIENDA SAMANTHA*\n\n`;
            text += `👤 *Tu Saldo:* $${db.saldos[sender] || 0} MXN\n\n`;
            text += `📦 *Productos disponibles:*\n`;

            const productos = Object.keys(db.precios);
            if (productos.length === 0) {
                text += `_No hay productos registrados aún._\n`;
            } else {
                productos.forEach(p => {
                    const precio = db.precios[p];
                    const cantStock = (db.stock[p] || []).length;
                    text += `• *${p.toUpperCase()}* - $${precio} MXN (Stock: ${cantStock})\n`;
                });
            }
            text += `\n💡 *Comandos disponibles:*\n`;
            text += `• .comprar <producto> - Comprar cuenta\n`;
            text += `• .saldo - Ver tu saldo\n`;
            text += `• .stock - Ver inventario\n`;
            await sock.sendMessage(from, { text }, { quoted: m });
        }

        else if (command === 'saldo') {
            const saldo = db.saldos[sender] || 0;
            await sock.sendMessage(from, { text: `💰 Tu saldo actual es: *$${saldo} MXN*` }, { quoted: m });
        }

        else if (command === 'stock') {
            let text = `📦 *INVENTARIO DISPONIBLE:*\n\n`;
            for (const p in db.precios) {
                const cant = (db.stock[p] || []).length;
                text += `• *${p.toUpperCase()}*: ${cant} disponibles\n`;
            }
            await sock.sendMessage(from, { text }, { quoted: m });
        }

        else if (command === 'comprar') {
            const producto = args[0]?.toLowerCase();
            if (!producto) {
                return sock.sendMessage(from, { text: `❌ Usa: .comprar <producto>` }, { quoted: m });
            }

            if (!db.precios[producto]) {
                return sock.sendMessage(from, { text: `❌ El producto *${producto}* no existe en el catálogo.` }, { quoted: m });
            }

            const precio = db.precios[producto];
            const userSaldo = db.saldos[sender] || 0;

            if (userSaldo < precio) {
                return sock.sendMessage(from, { text: `❌ Saldo insuficiente. Cuesta $${precio} MXN y tu saldo es de $${userSaldo} MXN.` }, { quoted: m });
            }

            if (!db.stock[producto] || db.stock[producto].length === 0) {
                return sock.sendMessage(from, { text: `❌ Agotado. No hay stock disponible para *${producto}*.` }, { quoted: m });
            }

            db.saldos[sender] -= precio;
            const cuentaEntregada = db.stock[producto].shift();
            saveDB(db);

            await sock.sendMessage(sender, {
                text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${producto.toUpperCase()}\n🔑 *Credenciales:*\n${cuentaEntregada}\n\nGracias por comprar en Samantha Store.`
            });

            await sock.sendMessage(from, {
                text: `✅ *Compra realizada.* Te hemos enviado las credenciales por mensaje privado. Saldo restante: *$${db.saldos[sender]} MXN*.`
            }, { quoted: m });
        }

        // === COMANDOS ADMINS ===

        else if (command === 'addsaldo') {
            if (!(await isAdmin())) {
                return sock.sendMessage(from, { text: `❌ Solo los administradores del grupo pueden usar este comando.` }, { quoted: m });
            }

            const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            const monto = parseInt(args[1] || args[0]);

            if (!mentioned || isNaN(monto)) {
                return sock.sendMessage(from, { text: `❌ Usa: .addsaldo @usuario <monto>` }, { quoted: m });
            }

            db.saldos[mentioned] = (db.saldos[mentioned] || 0) + monto;
            saveDB(db);

            await sock.sendMessage(from, { 
                text: `✅ Se agregaron *$${monto} MXN* al saldo de @${mentioned.split('@')[0]}`, 
                mentions: [mentioned] 
            }, { quoted: m });
        }

        else if (command === 'addstock') {
            if (!(await isAdmin())) {
                return sock.sendMessage(from, { text: `❌ Comando exclusivo para administradores.` }, { quoted: m });
            }

            const producto = args[0]?.toLowerCase();
            const cuenta = args.slice(1).join(' ');

            if (!producto || !cuenta) {
                return sock.sendMessage(from, { text: `❌ Usa: .addstock <producto> <correo:contraseña>` }, { quoted: m });
            }

            if (!db.stock[producto]) db.stock[producto] = [];
            db.stock[producto].push(cuenta);
            saveDB(db);

            await sock.sendMessage(from, { text: `✅ Stock actualizado en *${producto.toUpperCase()}*. Total en stock: ${db.stock[producto].length}` }, { quoted: m });
        }

        else if (command === 'setprecio') {
            if (!(await isAdmin())) {
                return sock.sendMessage(from, { text: `❌ Comando exclusivo para administradores.` }, { quoted: m });
            }

            const producto = args[0]?.toLowerCase();
            const precio = parseInt(args[1]);

            if (!producto || isNaN(precio)) {
                return sock.sendMessage(from, { text: `❌ Usa: .setprecio <producto> <precio>` }, { quoted: m });
            }

            db.precios[producto] = precio;
            if (!db.stock[producto]) db.stock[producto] = [];
            saveDB(db);

            await sock.sendMessage(from, { text: `✅ Precio de *${producto.toUpperCase()}* ajustado a *$${precio} MXN*.` }, { quoted: m });
        }
    });
}

startBot();