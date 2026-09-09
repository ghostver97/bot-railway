# Bot Tienda WhatsApp + Railway

## 1. Railway
Crea un Volume y móntalo en:

`/app/datos`

Agrega esta variable:

`DATA_DIR=/app/datos`

Agrega también:

`ADMIN_NUMBERS=521XXXXXXXXXX,521YYYYYYYYYY`

Usa los números de los administradores con código de país, sin `+`, espacios ni guiones.

## 2. GitHub
Sube `index.js` y `package.json` al repositorio.

Railway debe ejecutar:

`npm start`

## 3. Vincular WhatsApp
Abre el dominio público de Railway. Si aparece un QR, escanéalo desde:

WhatsApp > Dispositivos vinculados > Vincular dispositivo.

La sesión se guarda en el Volume.

## 4. Comandos

Clientes:
- `.menu`
- `.saldo`
- `.pagos`
- `.stock`
- `.comprar netflix`

Administradores:
- `.addsaldo NUMERO CANTIDAD`
- `.addsaldo CANTIDAD` mencionando al cliente
- `.addstock netflix correo:contraseña`
- `.setprecio netflix 65`
- `.addpago transferencia BBVA CLABE XXXXX`
- `.addpago oxxo Número XXXXX`
- `.delpago transferencia`
- `.delpago oxxo`
- `.admin`

Grupos:
- `.abrir`
- `.cerrar`

IMPORTANTE: para `.abrir` y `.cerrar`, el bot debe ser administrador del grupo.

## 5. Flujo de compra

`.comprar producto`

1. Comprueba precio, saldo y stock.
2. Intenta entregar la cuenta por privado.
3. Si WhatsApp acepta la entrega, descuenta el saldo y elimina la cuenta del stock.
4. Si la entrega falla, no descuenta ni elimina el stock.
