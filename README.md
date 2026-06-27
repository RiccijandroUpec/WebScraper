# 🤖 RickTech/BeMovil — Bot de WhatsApp para Recargas y Pagos

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-automation-2EAD33?logo=playwright&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)
![Licencia](https://img.shields.io/badge/uso-privado-lightgrey)

Bot de WhatsApp que conecta con [BeMovil](https://bemovil.net) para hacer **recargas 📱**, **pagos de servicios 💧⚡** y **cualquier otro producto que venda BeMovil** (Netflix, datos, apuestas, lotería...) en Ecuador 🇪🇨, usando **DeepSeek AI 🧠** + **Playwright 🎭** + **Evolution API**.

---

## 🏗️ Arquitectura

```
📱 Cliente WhatsApp
   ▼  (Evolution API → POST /webhook)
🧠 server.js — DeepSeek clasifica: topup | bill | order | greeting
   │  Mantiene contexto + historial real de la conversación (MySQL)
   │  Al completar el pedido, genera un código y se lo manda SOLO al admin
   ▼
🎭 scraper.js — Playwright + Chromium (headed + Xvfb)
   Login con sesión reutilizada, busca el producto en vivo en BeMovil,
   llena el formulario y se detiene antes de cobrar salvo confirm:true
```

| Intent | Para qué | Función |
|---|---|---|
| 📱 `topup` | Recargas (Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus) | `sellTopup(operator, phone, amount)` |
| 💧 `bill` | Servicios de una sola referencia (agua, luz, SRI, etc.) | `payBill(service, reference, {confirm})` |
| 🛍️ `order` | Cualquier otro producto de BeMovil | `processOrder(product, {tierChoice, fields, confirm})` |

**Confirmación de pago:** no hay PIN fijo. El bot genera un código de 4 dígitos nuevo por pedido y se lo manda **solo al administrador** (`ADMIN_NUMBERS`); el cliente paga en efectivo/transferencia directo al admin, y solo al responder ese código se ejecuta el cobro real en BeMovil. Sin `ADMIN_NUMBERS` configurado, el bot rechaza todos los pedidos.

---

## 🚀 Instalación

### Con Docker (recomendado)

```bash
cp .env.example .env   # editar con tus credenciales reales
docker compose up -d --build
```

### Local sin Docker

```bash
npm install
npx playwright install --with-deps chromium
npm start
```

> 💡 BeMovil bloquea Chromium headless, así que `scraper.js` siempre corre con `headless:false` (ventana real en local, Xvfb en Docker).

---

## 🔑 Variables de Entorno

```env
BEMOVIL_USER=...                          # credenciales reales de BeMovil
BEMOVIL_PASS=...
EVOLUTION_API_URL=http://localhost:8080   # gateway WhatsApp
EVOLUTION_API_TOKEN=...
INSTANCE_NAME=...
DEEPSEEK_API_KEY=...
ADMIN_NUMBERS=593987654321                # quién recibe el código de confirmación
AUTHORIZED_NUMBERS=*                      # * = cualquiera puede usar el bot
MYSQL_ROOT_PASSWORD=...                   # solo Docker, sin defaults
MYSQL_PASSWORD=...
```

---

## 🌐 Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/webhook` | Webhook de Evolution API |
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Estadísticas de transacciones |
| `GET` | `/dashboard` | Panel HTML |

## 💻 CLI

```bash
node scraper.js topup "Claro" 0991234567 5
node scraper.js bill "CNT Telefonia Fija" 1234567890
```

---

## 🔗 Infraestructura compartida (Evolution API)

`evolution_api`/`evolution_db` **no están en el `docker-compose.yml` de este proyecto** — pertenecen al proyecto hermano "sistema-kiosko" (`docker-compose-evolution.yml`). `webscrapper` se une a su red en vez de levantar su propia instancia; cualquier cambio de imagen/versión de Evolution API se hace en ese otro compose, no en este.

`docker-compose.yml` no monta el código como volumen — tras editar `server.js`/`scraper.js`/`db.js` hay que reconstruir:
```bash
docker compose up -d --build bot
```

---

## 🆘 Solución de Problemas

| Problema | Solución |
|---|---|
| Playwright no encuentra Chromium / `libgbm.so.1` | `npx playwright install --with-deps chromium` (no usar una lista manual de `apt-get`) |
| MySQL rechaza conexión tras cambiar `.env` | El volumen `mysql_data` ya tenía credenciales viejas → `docker compose down` + `docker volume rm <proyecto>_mysql_data` + `docker compose up -d` |
| DeepSeek 402 "Insufficient Balance" | [Recargar saldo](https://platform.deepseek.com/top_up) — revisar primero que la key no se haya filtrado públicamente |
| WhatsApp no conecta / no llegan mensajes | Revisar `docker restart evolution_api`; si persiste, probar cambiar el tag de imagen en `docker-compose-evolution.yml` (los bugs de versión van en ambos sentidos) |
| Build de Docker falla/lento | Poco espacio en disco — `docker system prune` |

---

## 📜 Licencia

Uso privado — RickTech © 2026 · [Repositorio](https://github.com/RiccijandroUpec/WebScraper)
