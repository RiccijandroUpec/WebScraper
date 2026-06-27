# 🤖 RickTech/BeMovil — Bot de WhatsApp para Recargas y Pagos

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-automation-2EAD33?logo=playwright&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)
![Licencia](https://img.shields.io/badge/uso-privado-lightgrey)

**Sistema automatizado** que conecta WhatsApp con [BeMovil](https://bemovil.net) para hacer **recargas 📱**, **pagos de servicios 💧⚡** y **cualquier otro producto que venda BeMovil** (Netflix, paquetes de datos, apuestas, lotería, depósitos...) en Ecuador 🇪🇨, usando **DeepSeek AI 🧠**, **Playwright 🎭** y **Evolution API**.

---

## 📋 Índice

- [🚦 Estado del Proyecto](#-estado-del-proyecto)
- [🏗️ Arquitectura](#️-arquitectura)
- [🎯 Los 3 Intents](#-los-3-intents-topup--bill--order)
- [🔐 Confirmación de pago](#-confirmación-de-pago-código-por-pedido-vía-administrador)
- [🕵️ BeMovil: anti-bot](#️-bemovil-anti-bot-y-selectores-reales)
- [🛠️ Tecnologías](#️-tecnologías)
- [✅ Implementado](#-implementado)
- [⚠️ Limitaciones Conocidas](#️-limitaciones-conocidas)
- [📁 Estructura del Proyecto](#-estructura-del-proyecto)
- [🚀 Instalación](#-instalación)
- [🔑 Variables de Entorno](#-variables-de-entorno)
- [🐳 Docker](#-docker)
- [🌐 Endpoints](#-endpoints)
- [💻 CLI](#-cli)
- [🔗 Evolution API compartida](#-evolution-api-infraestructura-compartida)
- [🆘 Solución de Problemas](#-solución-de-problemas)

---

## 🚦 Estado del Proyecto

✅ **Funcional de extremo a extremo**: login real anti-bot superado, recargas y consultas probadas con datos reales, conversación de WhatsApp verificada en producción (Docker + Evolution API), y el descubrimiento automático de formularios (`processOrder`) verificado contra **todo el catálogo de BeMovil** (136 productos, ver `dryrun_results.json`).

⚠️ Ningún pago/recarga real se ha completado con `confirm:true` todavía (todas las pruebas reales terminaron en rechazo controlado: saldo insuficiente, datos de prueba). Ver [Limitaciones Conocidas](#️-limitaciones-conocidas).

---

## 🏗️ Arquitectura

```
📱 Cliente WhatsApp
   │  "Quiero Netflix" / "Recarga $5 a Claro 0991234567"
   ▼
🌐 Evolution API  (gateway WhatsApp → webhook HTTP)
   │  POST /webhook
   ▼
🧠 server.js  (Express + DeepSeek)
   1. Filtra mensajes propios y viejos
   2. Verifica número autorizado + límite diario
   3. DeepSeek clasifica: topup | bill | order | greeting
   4. Mantiene contexto de conversación (MySQL + memoria, 30 min)
   5. order: descubre el formulario real en BeMovil y pregunta lo que falte
   6. Al completar el pedido, genera un código de 4 dígitos
      y se lo envía SOLO al administrador (no al cliente)
   7. Cliente paga en efectivo/transferencia al admin
   8. Cliente reenvía el código → AHÍ se ejecuta el cobro real
   ▼
🎭 scraper.js  (Playwright + Chromium, modo headed + Xvfb)
   1. Reutiliza sesión guardada o hace login con tecleo humano
   2. Busca el producto en el buscador real de BeMovil
   3. Descubre labels/botones reales del formulario en vivo
   4. Se detiene antes de cobrar, salvo que confirm:true
   5. Detecta éxito/error comparando banners antes/después
```

---

## 🎯 Los 3 Intents: topup / bill / order

| Intent | 🎯 Para qué | Función | Patrón |
|---|---|---|---|
| 📱 `topup` | Recargas de saldo móvil | `sellTopup(operator, phone, amount)` | Teléfono + monto → "Vender recarga" (un solo paso) |
| 💧 `bill` | Servicios de **una sola referencia** (agua, luz, SRI, registro civil, tránsito, bancos) | `payBill(service, reference, {confirm})` | Referencia → consulta → modal "Confirmar venta" |
| 🛍️ `order` | **Todo lo demás**: streaming, datos, juegos, depósitos, apuestas, lotería, retiros, internacionales | `processOrder(product, {tierChoice, fields, confirm})` | Se descubre en vivo, no hay formulario fijo |

`order` es el intent genérico: `processOrder()` navega al producto, detecta planes/tiers y los campos reales que pide BeMovil, y `server.js` se lo pregunta al cliente con esos nombres reales — no con una lista fija. Catálogo completo verificado en `dryrun_results.json`.

---

## 🔐 Confirmación de pago: código por pedido vía administrador

No hay un PIN fijo — el flujo coincide con el negocio real (el cliente paga en efectivo/transferencia, no hay pasarela integrada):

1. 🤖 El bot junta los datos del pedido (y hace una consulta de solo lectura si es `bill`/`order`, para mostrar el monto real)
2. 🔢 Genera un código de **4 dígitos nuevo** y se lo manda **solo al administrador** (`ADMIN_NUMBERS`)
3. 💵 El cliente paga en efectivo/transferencia directamente al administrador
4. 🗣️ El administrador, ya cobrado, le dicta el código al cliente
5. ✅ El cliente responde ese código por WhatsApp → ahí se ejecuta la acción real en BeMovil
6. 📩 El administrador recibe aviso de éxito o error tras la ejecución

> Si `ADMIN_NUMBERS` no está configurado, el bot **rechaza** el pedido en vez de ejecutarlo sin confirmación.

---

## 🕵️ BeMovil: anti-bot y selectores reales

Hallazgos no obvios de pruebas reales (ver también comentarios en `scraper.js`):

- 🚫 **BeMovil bloquea Chromium headless** con un HTTP 400 disfrazado de error de "transacción en proceso" — por eso `scraper.js` usa `headless:false` (Xvfb en Docker) + user-agent real + tecleo humano en el login
- 💾 Sesión persistida en `.bemovil-session.json` (gitignored) — solo hace login completo si caducó
- 🏷️ Los inputs usan `<label for="...">` flotante, no `placeholder`
- 🪟 Los modales usan la clase real `dialog-root`/`dialog-section`, no `[class*="modal"]`
- 📡 Operadoras de recarga **válidas**: Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus (¡"OpenMobile" no existe!)
- 🔎 El buscador de BeMovil es literal, no difuso: hace falta el nombre completo ("Registro Civil", "CNEL Guayaquil")

---

## 🛠️ Tecnologías

| Tecnología | Propósito |
|---|---|
| 🟢 **Node.js** | Runtime del servidor |
| ⚡ **Express.js** | Framework HTTP, webhook |
| 🎭 **Playwright** | Automatización de navegador — `headless:false` + Xvfb en producción |
| 🐬 **MySQL** | Conversaciones, transacciones, números autorizados, límites diarios |
| 🧠 **DeepSeek AI** | Clasificación de intención, extracción de datos |
| 📲 **Evolution API** | Gateway WhatsApp (instancia compartida, ver más abajo) |
| 🐳 **Docker Compose** | Despliegue: bot + MySQL + phpMyAdmin |

---

## ✅ Implementado

| Área | Detalle |
|---|---|
| 🔓 Login real anti-bot | Headed + Xvfb, tecleo humano, sesión reutilizada automáticamente |
| 📱 Recargas | 6 operadoras reales verificadas |
| 💧 Pago de servicios | Verificado con CNT, Agua, SRI — detecta banners de error específicos |
| 🛍️ Cualquier otro producto | `processOrder()` genérico, verificado contra 136 productos del catálogo |
| 🔢 Confirmación por código | Código nuevo por pedido, vía administrador |
| 🗄️ Persistencia en MySQL | Con fallback a memoria si la BD no está disponible |
| 🧠 Memoria conversacional real | DeepSeek recibe el historial real de la conversación (no solo datos extraídos), y reconoce continuaciones ambiguas en vez de reiniciar |
| 🔁 Multi-turno robusto | No pierde datos entre mensajes ni reinicia la conversación con datos sueltos |
| 📊 Dashboard | `dashboard.html` consumiendo `/stats` |
| 🐳 Docker | Bot + MySQL + phpMyAdmin, build verificado funcionando end-to-end |
| 💻 CLI de pruebas | `node scraper.js topup ...` / `bill ...` |

---

## ⚠️ Limitaciones Conocidas

| # | Limitación |
|---|---|
| 1 | Ningún pago/recarga real completado con `confirm:true` — solo rechazos controlados probados |
| 2 | Pega2/3/4 (lotería): `processOrder` detecta el selector pero no completa el envío final |
| 3 | Internacionales: descubrimiento verificado, llenado completo de campos sin probar |
| 4 | BD existente con la versión vieja necesita `ALTER TABLE transactions MODIFY type ENUM('topup','bill','order')` manual |

---

## 📁 Estructura del Proyecto

```
📁 webscrapper/
├── 🧠 server.js              # Express + webhook + DeepSeek (3 intents) + confirmación por código
├── 🎭 scraper.js             # Playwright: login anti-bot, sellTopup, payBill, processOrder
├── 🗄️ db.js                  # Conexión MySQL
├── 📜 init.sql               # Esquema de la base de datos
├── 📊 dashboard.html         # Panel web (consume /stats)
├── 🐳 Dockerfile             # Node + Chromium + Xvfb
├── 🐳 docker-compose.yml     # bot + mysql + phpmyadmin + red compartida
├── 🚀 start.sh               # Arranque: Xvfb + node server.js
├── 📦 product_catalog.json   # Catálogo real de BeMovil (12 categorías)
├── 📦 dryrun_results.json    # Inspección de los 136 productos no-Recargas
├── 🔒 .env / .env.example    # Variables de entorno (.env NO se sube a git)
└── package.json
```

---

## 🚀 Instalación

```bash
git clone https://github.com/RiccijandroUpec/WebScraper.git
cd WebScraper
npm install
npx playwright install --with-deps chromium

cp .env.example .env
# Editar .env con tus credenciales reales

npm start
```

> 💡 En local (sin Docker), `scraper.js` abre una ventana real de Chromium porque BeMovil bloquea el modo headless. En Docker, esto corre contra Xvfb automáticamente.

---

## 🔑 Variables de Entorno

```env
# Credenciales de BeMovil
BEMOVIL_USER=tu_usuario_bemovil
BEMOVIL_PASS=tu_password_bemovil

# Evolution API (gateway WhatsApp)
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_TOKEN=tu_token_aqui
INSTANCE_NAME=tu_instancia

# DeepSeek AI
DEEPSEEK_API_KEY=tu_api_key_aqui

# WhatsApp del administrador que recibe el código de confirmación
ADMIN_NUMBERS=593987654321

# Números autorizados a usar el bot (* = todos)
AUTHORIZED_NUMBERS=*

# Credenciales de MySQL (usadas por docker-compose)
MYSQL_ROOT_PASSWORD=elige-tu-propia-contraseña
MYSQL_PASSWORD=elige-otra-contraseña
```

| Variable | Obligatorio | Descripción |
|---|---|---|
| `BEMOVIL_USER` / `BEMOVIL_PASS` | ✅ | Credenciales reales de BeMovil |
| `DEEPSEEK_API_KEY` | ✅ | API Key de DeepSeek (fallback a `OPENAI_API_KEY`) |
| `EVOLUTION_API_URL` / `EVOLUTION_API_TOKEN` / `INSTANCE_NAME` | ✅ | Gateway de WhatsApp |
| `ADMIN_NUMBERS` | ✅ | Sin esto, el bot rechaza todos los pedidos |
| `AUTHORIZED_NUMBERS` | ❌ | `*` = cualquiera puede usar el bot |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | ✅ (Docker) | Sin defaults, hay que definirlas |

---

## 🐳 Docker

```bash
docker compose up -d --build
```

El `Dockerfile` instala Xvfb y arranca con `start.sh` (lanza Xvfb manualmente antes de `node server.js`). **No usar `xvfb-run`**: se queda colgado esperando una señal que nunca llega en este entorno.

> 💡 Si MySQL rechaza la conexión tras cambiar `.env`, es porque el volumen `mysql_data` ya existía con credenciales viejas (solo se aplican al crear el volumen por primera vez). Solución: `docker compose down` + `docker volume rm <proyecto>_mysql_data` + `docker compose up -d`.

---

## 🌐 Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/webhook` | Webhook para Evolution API |
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Estadísticas de transacciones |
| `GET` | `/dashboard` | Panel HTML |

---

## 💻 CLI

```bash
# Recarga (operadoras válidas: Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus)
node scraper.js topup "Claro" 0991234567 5

# Pago/consulta de un servicio de una sola referencia
node scraper.js bill "CNT Telefonia Fija" 1234567890
```

---

## 🔗 Evolution API: infraestructura compartida

Los contenedores `evolution_api` y `evolution_db` **no están en el `docker-compose.yml` de este proyecto** — pertenecen al proyecto hermano **"sistema-kiosko"** (`docker-compose-evolution.yml`). `webscrapper` se une a su red (`sistema-kiosko_default`, `external: true`) en vez de levantar su propia instancia. Cambios de imagen/versión/env de Evolution API se hacen en **ese otro** compose.

La config (instancia, webhook, settings) vive en Postgres (`evolution_db`), así que sobrevive a recreaciones del contenedor `evolution_api`.

### 🐛 Bugs conocidos de esta infraestructura

- **Pairing roto con `:latest`** → en su momento se fijó a `v2.3.6` por una regresión de Baileys RC (issue #2437).
- **`v2.3.6` deja de recibir mensajes directos** (mismo bug, distinto síntoma — `state:"open"` pero nada entrante llega, sin errores). Se arregló volviendo a `:latest`. **Moraleja: revisa qué tag está activo antes de asumir nada — los bugs de versión van en ambas direcciones.**
- **Socket "zombie"**: `connectionState` dice `"open"` pero Baileys deja de recibir. Confirmar comparando timestamps con `chat/findMessages`; arreglo habitual: `docker restart evolution_api`.
- **QR estático caduca en ~20-30s** → usar el **Manager web** (`http://localhost:8080/manager`) en vez de descargar el PNG.
- **Schema v2 de mensajes**: `sendText` usa `{number, text, delay}` plano (no anidado como v1); `sendMedia` para imágenes, no existe `/sendImage`.

### El bot no refleja cambios de código

`docker-compose.yml` no monta el código como volumen. Tras editar `server.js`/`scraper.js`/`db.js`:

```bash
docker compose up -d --build bot
```

---

## 🆘 Solución de Problemas

| Problema | Causa | Solución |
|---|---|---|
| `ECONNREFUSED` con Evolution API | No está corriendo | Verificar que esté arriba y la URL en `.env` |
| Playwright no encuentra Chromium | No instalado | `npx playwright install --with-deps chromium` |
| `browser has been closed` / `libgbm.so.1` | Faltan dependencias de sistema | Usar `playwright install --with-deps`, no una lista manual de `apt-get` |
| DeepSeek 402 "Insufficient Balance" | Sin saldo | [Recargar](https://platform.deepseek.com/top_up) — y revisar que la key no se haya filtrado públicamente |
| Login en BeMovil falla / HTTP 400 | Bot detectado como headless | Confirmar `headless:false` + Xvfb (ver sección anti-bot) |
| Build de Docker falla/lento | Poco espacio en disco | `docker system prune`, revisar espacio libre |
| WhatsApp no conecta / no llegan mensajes | Ver sección de Evolution API | — |
| El bot "no recuerda" nada entre mensajes / se siente ambiguo | Con MySQL conectado, `db.js` parseaba dos veces una columna `JSON` que `mysql2` ya entrega como objeto — `JSON.parse()` fallaba en silencio y el contexto volvía `{}` en cada lectura | Ya corregido (`db.js`). Si vuelve a pasar: comparar directo lo que hay en la tabla `conversations` vs lo que devuelve `db.getConversation()` para el mismo `remote_jid` |

---

## 📜 Licencia

**Uso privado — RickTech** © 2026

## 🔗 Repositorio

https://github.com/RiccijandroUpec/WebScraper
