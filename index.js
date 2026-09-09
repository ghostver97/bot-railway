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

                // Envío de texto plano limpio, sin menciones problemáticas que bloqueen el envío
                await sock.sendMessage(from, { 
                    text: `🎉 *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${producto.toUpperCase()}\n🔑 *Credenciales:*\n${cuentaEntregada}` 
                });
            }