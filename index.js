else if (command === 'comprar') {
                const producto = args[0]?.toLowerCase();
                if (!producto || !db.precios[producto]) return sock.sendMessage(from, { text: `❌ Producto no válido.` });
                const precio = db.precios[producto];
                
                const userSaldo = db.saldos[senderKey] || db.saldos[privateJid] || 0;
                if (userSaldo < precio) return sock.sendMessage(from, { text: `❌ Saldo insuficiente.` });
                if (!db.stock[producto] || db.stock[producto].length === 0) return sock.sendMessage(from, { text: `❌ Agotado.` });
                
                // Descontar saldo y extraer producto
                if (db.saldos[senderKey] !== undefined) {
                    db.saldos[senderKey] -= precio;
                } else {
                    db.saldos[privateJid] -= precio;
                }
                
                const cuentaEntregada = db.stock[producto].shift();
                saveDB(db);

                // --- ENVÍO 100% PRIVADO Y AISLADO ---
                try {
                    await sock.sendMessage(privateJid, { 
                        text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${producto.toUpperCase()}\n🔑 *Credenciales:*\n${cuentaEntregada}` 
                    });
                } catch (errPrivado) {
                    console.log("Error al enviar al privado:", errPrivado);
                }

                // Aviso único en el grupo (este sí va a 'from', pero SOLO es texto de aviso, nunca las credenciales)
                await sock.sendMessage(from, { 
                    text: `✅ Compra de *${producto.toUpperCase()}* procesada con éxito. Revisa tu chat privado para ver tus credenciales 🔑.` 
                });
            }