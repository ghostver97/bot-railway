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

let qrImage = '';

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
                <p>El bot ya está <b>conectado</b> y operando en la nube 24/7.</p>
            </div>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP corriendo y escuchando en el puerto ${PORT}`);
});

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

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./datos/auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrImage = await QRCode.toDataURL(qr);
                console.log('⚡ Nuevo QR generado. Disponible en la ruta Web.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('⚠️ Conexión cerrada. Intentando reconectar en 3 segundos...');
                    setTimeout(() => startBot(), 3000);
                } else {
                    console.log('❌ Sesión cerrada permanentemente. Borrando sesión...');
                    qrImage = '';
                    try { fs.rmSync('./datos/auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                    setTimeout(() => startBot(), 3000);
                }
            } else if (connection === 'open') {
                qrImage = ''; 
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

            const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
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

            if (command === 'menu' || command === 'tienda') {
                let text = `🛒 *MENÚ DE TIENDA SAMANTHA*\n\n👤 *Tu Saldo:* $${db.saldos[sender] || 0} MXN\n\n📦 *Productos:*\n`;
                const productos = Object.keys(db.precios);
                if (productos.length === 0) {
                    text += `_No hay productos registrados._\n`;
                } else {
                    productos.forEach(p => {
                        text += `• *${p.toUpperCase()}* - $${db.precios[p]} MXN (Stock: ${(db.stock[p] || []).length})\n`;
                    });
                }
                await sock.sendMessage(from, { text }, { quoted: m });
            }
            else if (command === 'saldo') {
                await sock.sendMessage(from, { text: `💰 Tu saldo actual es: *$${db.saldos[sender] || 0} MXN*` }, { quoted: m });
            }
            else if (command === 'stock') {
                let text = `📦 *INVENTARIO DISPONIBLE:*\n\n`;
                for (const p in db.precios) text += `• *${p.toUpperCase()}*: ${(db.stock[p] || []).length} disponibles\n`;
                await sock.sendMessage(from, { text }, { quoted: m });
            }
            else if (command === 'comprar') {
                const producto = args[0]?.toLowerCase();
                if (!producto || !db.precios[producto]) return sock.sendMessage(from, { text: `❌ Producto no válido.` }, { quoted: m });
                const precio = db.precios[producto];
                const userSaldo = db.saldos[sender] || 0;
                if (userSaldo < precio) return sock.sendMessage(from, { text: `❌ Saldo insuficiente.` }, { quoted: m });
                if (!db.stock[producto] || db.stock[producto].length === 0) return sock.sendMessage(from, { text: `❌ Agotado.` }, { quoted: m });
                
                db.saldos[sender] -= precio;
                const cuentaEntregada = db.stock[producto].shift();
                saveDB(db);

                const rawNumber = sender.split('@')[0];
                const targetJid = rawNumber + '@s.whatsapp.net';

                await sock.sendMessage(targetJid, { text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${producto.toUpperCase()}\n🔑 *Credenciales:*\n${cuentaEntregada}` });
                
                await sock.sendMessage(from, { text: `✅ Compra realizada. Te enviamos las credenciales por privado.` }, { quoted: m });
            }
            else if (command === 'addsaldo' && await isAdmin()) {
                const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const monto = parseInt(args[1] || args[0]);
                if (mentioned && !isNaN(monto)) {
                    db.saldos[mentioned] = (db.saldos[mentioned] || 0) + monto;
                    saveDB(db);
                    await sock.sendMessage(from, { text: `✅ $${monto} agregados a @${mentioned.split('@')[0]}`, mentions: [mentioned] }, { quoted: m });
                }
            }
            else if (command === 'addstock' && await isAdmin()) {
                const producto = args[0]?.toLowerCase();
                const cuenta = args.slice(1).join(' ');
                if (producto && cuenta) {
                    if (!db.stock[producto]) db.stock[producto] = [];
                    db.stock[producto].push(cuenta);
                    saveDB(db);
                    await sock.sendMessage(from, { text: `✅ Stock actualizado en *${producto}*. Total: ${db.stock[producto].length}` }, { quoted: m });
                }
            }
            else if (command === 'setprecio' && await isAdmin()) {
                const producto = args[0]?.toLowerCase();
                const precio = parseInt(args[1]);
                if (producto && !isNaN(precio)) {
                    db.precios[producto] = precio;
                    if (!db.stock[producto]) db.stock[producto] = [];
                    saveDB(db);
                    await sock.sendMessage(from, { text: `✅ Precio de *${producto}* ajustado a *$${precio} MXN*.` }, { quoted: m });
                }
            }
        });
    } catch (error) {
        console.log('Error en el bot, reiniciando en 5 segundos...', error);
        setTimeout(() => startBot(), 5000);
    }
}

startBot();

// Mantiene el proceso vivo ante cualquier imprevisto de Node.js
process.on('uncaughtException', (err) => {
    console.error('Error no controlado:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Promesa rechazada no controlada:', reason);
});