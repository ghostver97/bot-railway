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
const http = require('http');

let qrImage = '';
let activeSock = null;

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    if (qrImage) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>QR Bot WhatsApp</title>
                <meta http-equiv="refresh" content="5">
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
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(200).send('OK - Bot Activo 24/7');
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('Healthy');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP activo en el puerto ${PORT}`);
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
        if (activeSock) {
            try { activeSock.end(); } catch(e) {}
            activeSock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState('./datos/auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false
        });

        activeSock = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrImage = await QRCode.toDataURL(qr);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('⚠️ Conexión cerrada. Reconectando:', shouldReconnect);
                
                if (shouldReconnect) {
                    setTimeout(() => startBot(), 4000);
                } else {
                    qrImage = '';
                    try { fs.rmSync('./datos/auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                    setTimeout(() => startBot(), 4000);
                }
            } else if (connection === 'open') {
                qrImage = ''; 
                console.log('✅ Bot conectado exitosamente a WhatsApp.');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            try {
                if (type !== 'notify') return;
                const m = messages[0];
                if (!m.message || m.key.fromMe) return;

                const from = m.key.remoteJid;
                const isGroup = from.endsWith('@g.us');
                
                const rawSender = isGroup ? (m.key.participant || m.participant) : from;
                if (!rawSender) return;
                
                const cleanNum = rawSender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                const userJid = `${cleanNum}@s.whatsapp.net`;

                const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
                if (!body.startsWith('.')) return;

                const args = body.slice(1).trim().split(/ +/);
                const command = args.shift().toLowerCase();
                const db = loadDB();

                async function isAdmin() {
                    if (!isGroup) return true;
                    try {
                        const metadata = await sock.groupMetadata(from);
                        const p = metadata.participants.find(item => item.id.includes(cleanNum));
                        return p && (p.admin === 'admin' || p.admin === 'superadmin');
                    } catch (e) {
                        return false;
                    }
                }

                if (command === 'menu' || command === 'tienda') {
                    let text = `🛒 *MENÚ DE TIENDA SAMANTHA*\n\n👤 *Tu Saldo:* $${db.saldos[userJid] || 0} MXN\n\n📦 *Productos:*\n`;
                    const productos = Object.keys(db.precios);
                    if (productos.length === 0) {
                        text += `_No hay productos registrados._\n`;
                    } else {
                        productos.forEach(p => {
                            text += `• *${p.toUpperCase()}* - $${db.precios[p]} MXN (Stock: ${(db.stock[p] || []).length})\n`;
                        });
                    }
                    await sock.sendMessage(from, { text });
                }
                else if (command === 'saldo') {
                    await sock.sendMessage(from, { text: `💰 Tu saldo actual es: *$${db.saldos[userJid] || 0} MXN*` });
                }
                else if (command === 'stock') {
                    let text = `📦 *INVENTARIO DISPONIBLE:*\n\n`;
                    for (const p in db.precios) text += `• *${p.toUpperCase()}*: ${(db.stock[p] || []).length} disponibles\n`;
                    await sock.sendMessage(from, { text });
                }
                else if (command === 'comprar') {
                    const producto = args[0]?.toLowerCase();
                    if (!producto || !db.precios[producto]) {
                        await sock.sendMessage(from, { text: `❌ Producto no válido.` });
                        return;
                    }
                    
                    const precio = db.precios[producto];
                    const userSaldo = db.saldos[userJid] || 0;
                    
                    if (userSaldo < precio) {
                        await sock.sendMessage(from, { text: `❌ Saldo insuficiente.` });
                        return;
                    }
                    
                    if (!db.stock[producto] || db.stock[producto].length === 0) {
                        await sock.sendMessage(from, { text: `❌ Agotado.` });
                        return;
                    }
                    
                    db.saldos[userJid] -= precio;
                    const cuentaEntregada = db.stock[producto].shift();
                    saveDB(db);

                    // Envío exclusivo al chat privado del usuario
                    await sock.sendMessage(userJid, { 
                        text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${producto.toUpperCase()}\n🔑 *Credenciales:*\n${cuentaEntregada}` 
                    });

                    // Aviso en el grupo si se compró desde ahí
                    if (isGroup) {
                        await sock.sendMessage(from, { 
                            text: `✅ Compra de *${producto.toUpperCase()}* procesada con éxito. Revisa tu chat privado para ver tus credenciales 🔑.` 
                        });
                    }
                }
                else if (command === 'addsaldo' && await isAdmin()) {
                    let targetJid = userJid;
                    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) {
                        const mentionNum = mentioned.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                        targetJid = `${mentionNum}@s.whatsapp.net`;
                    }
                    const monto = parseInt(args[1] || args[0]);
                    if (!isNaN(monto)) {
                        db.saldos[targetJid] = (db.saldos[targetJid] || 0) + monto;
                        saveDB(db);
                        await sock.sendMessage(from, { text: `✅ $${monto} agregados correctamente al saldo del usuario.` });
                    }
                }
                else if (command === 'addstock' && await isAdmin()) {
                    const producto = args[0]?.toLowerCase();
                    const cuenta = args.slice(1).join(' ');
                    if (producto && cuenta) {
                        if (!db.stock[producto]) db.stock[producto] = [];
                        db.stock[producto].push(cuenta);
                        saveDB(db);
                        await sock.sendMessage(from, { text: `✅ Stock actualizado en *${producto}*. Total: ${db.stock[producto].length}` });
                    }
                }
                else if (command === 'setprecio' && await isAdmin()) {
                    const producto = args[0]?.toLowerCase();
                    const precio = parseInt(args[1]);
                    if (producto && !isNaN(precio)) {
                        db.precios[producto] = precio;
                        if (!db.stock[producto]) db.stock[producto] = [];
                        saveDB(db);
                        await sock.sendMessage(from, { text: `✅ Precio de *${producto}* ajustado a *$${precio} MXN*.` });
                    }
                }
            } catch (errInternal) {
                console.log("Error procesando mensaje:", errInternal);
            }
        });
    } catch (error) {
        console.log("Error crítico en el bot:", error);
        setTimeout(() => startBot(), 5000);
    }
}

startBot();

setInterval(() => {
    http.get(`http://127.0.0.1:${PORT}/health`, (res) => {}).on('error', () => {});
}, 15000);

process.on('uncaughtException', (err) => { console.log('Excepción global:', err); });
process.on('unhandledRejection', (err) => { console.log('Promesa rechazada global:', err); });