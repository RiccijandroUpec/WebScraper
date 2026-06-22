# 🤖 RickTech/BeMovil — WhatsApp Bot para Recargas y Pagos

**Sistema automatizado** que conecta WhatsApp con la plataforma [BeMovil](https://bemovil.net) para realizar **recargas móviles** y **pago de servicios** en Ecuador usando **Inteligencia Artificial (DeepSeek)**, **Playwright** y **Evolution API**.

---

## 📋 Índice

- [Estado del Proyecto](#estado-del-proyecto)
- [Arquitectura Técnica](#arquitectura-técnica)
- [Tecnologías y Herramientas Usadas](#tecnologías-y-herramientas-usadas)
- [Flujo de Funcionamiento](#flujo-de-funcionamiento)
- [Lo que se Implementó ✅](#lo-que-se-implementó-)
- [Lo que Falta Implementar ❌](#lo-que-falta-implementar-)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Instalación y Configuración](#instalación-y-configuración)
- [Variables de Entorno](#variables-de-entorno)
- [Endpoints de la API](#endpoints-de-la-api)
- [Uso desde Línea de Comandos](#uso-desde-línea-de-comandos)
- [Solución de Problemas](#solución-de-problemas)

---

## Estado del Proyecto

```
🚀 FUNCIONAL — El bot arranca, recibe mensajes, analiza con DeepSeek AI,
           ejecuta el scraper y responde por WhatsApp.
⚠️  PENDIENTE: Selectores del DOM de BeMovil requieren ajuste manual
           y Evolution API debe estar configurada.
```

---

## Arquitectura Técnica

```
┌─────────────────────────────────────────────────────────────┐
│                    USUARIO FINAL                             │
│              (WhatsApp en su celular)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ Envía: "Recarga $5 a Claro 0991234567"
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    EVOLUTION API                             │
│           (Gateway WhatsApp → Webhook HTTP)                  │
└─────────────────────┬───────────────────────────────────────┘
                      │ POST /webhook (JSON)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│               SERVER.JS (Express + Node.js)                  │
├─────────────────────────────────────────────────────────────┤
│  1. Recibe webhook de Evolution API                         │
│  2. Extrae mensaje (soporta v1 y v2 del API)               │
│  3. Filtra mensajes propios (fromMe)                       │
│  4. Verifica autorización del número                       │
│  5. Consulta a DeepSeek AI para clasificar intención       │
│  6. Mantiene contexto de conversación (30 min)              │
│  7. Si datos completos → ejecuta scraper                   │
│  8. Responde al usuario por WhatsApp                       │
│  9. Guarda log de transacción                              │
└─────────────────────┬───────────────────────────────────────┘
                      │ Llamada a scraper.sellTopup() o payBill()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              SCRAPER.JS (Playwright + Chromium)              │
├─────────────────────────────────────────────────────────────┤
│  1. Abre navegador headless Chromium                        │
│  2. Navega a https://bemovil.net/login                      │
│  3. Selecciona país Ecuador (+593)                          │
│  4. Ingresa usuario y contraseña                            │
│  5. Navega a sección de Recargas o Recaudos                 │
│  6. Busca inputs por placeholder/texto                      │
│  7. Ingresa datos (operadora, teléfono, monto)             │
│  8. Hace clic en botones de venta                           │
│  9. Captura screenshot del resultado                        │
│  10. Detecta mensajes de éxito/error                        │
│  11. Retorna resultado                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Tecnologías y Herramientas Usadas

| Tecnología | Versión | Propósito |
|---|---|---|
| **Node.js** | v24.12.0 | Runtime del servidor |
| **Express.js** | v5.2.1 | Framework HTTP, manejo de rutas y webhooks |
| **body-parser** | v2.3.0 | Parseo de JSON en peticiones entrantes |
| **Axios** | v1.18.0 | Cliente HTTP para Evolution API y DeepSeek API |
| **Playwright** | v1.61.0 | Automatización de navegador (scraper) |
| **Chromium** | (incluido) | Motor de navegación headless |
| **dotenv** | v17.4.2 | Carga de variables de entorno (.env) |
| **DeepSeek AI** | deepseek-chat | Procesamiento de lenguaje natural (NLP) |
| **Evolution API** | v2.x | Gateway WhatsApp (webhook) |
| **BeMovil** | — | Plataforma de recargas y pagos (target) |

### APIs Externas

| API | Endpoint | Costo | Uso |
|---|---|---|---|
| **DeepSeek** | `POST https://api.deepseek.com/chat/completions` | ~$0.14/1M tokens | Análisis de intención, contexto, extracción de datos |
| **Evolution API** | `POST http://localhost:8080/message/sendText/{instance}` | Gratis (local) | Envío de mensajes e imágenes a WhatsApp |

---

## Flujo de Funcionamiento

### 🔄 Ciclo Completo de una Recarga

```
1. Usuario escribe: "Recarga $5 a Claro 0991234567"
2. Evolution API recibe el mensaje → POST a /webhook
3. server.js extrae el mensaje, verifica fromMe y autorización
4. Envía prompt con contexto a DeepSeek AI
5. DeepSeek devuelve JSON:
   {
     "intent": "topup",
     "is_complete": true,
     "reply_message": "Perfecto, voy a recargar $5 a Claro (0991234567)...",
     "topup_data": {
       "operator": "Claro",
       "phone": "0991234567",
       "amount": "5"
     }
   }
6. server.js envía confirmación al usuario
7. Ejecuta scraper.sellTopup("Claro", "0991234567", "5")
8. Playwright abre BeMovil, hace login, navega a recargas
9. Ingresa datos, hace clic en vender, captura resultado
10. Envía resultado final al usuario
11. Guarda log en transactions.json
```

### 🔄 Ciclo de Conversación Multi-Mensaje (con contexto)

```
Usuario: "Quiero una recarga"
  → DeepSeek: intent="topup", is_complete=false
  → Bot: "¿Para qué operadora, número y monto?"

Usuario: "A Movistar"
  → DeepSeek: conserva "operator"="Movistar" en contexto, faltan phone y amount
  → Bot: "¿Cuál es el número y el monto?"

Usuario: "0991234567, $10"
  → DeepSeek: usa contexto (Movistar) + datos nuevos → is_complete=true
  → Bot: ejecuta recarga de $10 a Movistar 0991234567
```

---

## Lo que se Implementó ✅

### ✅ Funcionalidades Completas

| # | Funcionalidad | Archivo | Detalle Técnico |
|---|---|---|---|
| 1 | **Webhook Evolution API** | `server.js` | Soporte para Evolution API v1 y v2. Extrae `conversation`, `extendedTextMessage` e `imageMessage.caption` |
| 2 | **Autenticación en BeMovil** | `scraper.js` | Login con selección de país (+593 Ecuador), 2 pasos (usuario → contraseña), espera de URL `/backoffice/**` |
| 3 | **Recargas (sellTopup)** | `scraper.js` | Navega a `/backoffice/sell`, busca operadora por texto, inputs por placeholder, botones por regex, captura screenshots |
| 4 | **Pago de Servicios (payBill)** | `scraper.js` | Navega a `/backoffice/collection`, busca servicio, ingresa referencia, captura resultado |
| 5 | **Análisis con DeepSeek AI** | `server.js` | Prompt con contexto, operadoras válidas, servicios válidos, formato JSON estricto, manejo de saludos y desconocidos |
| 6 | **Contexto de Conversación** | `server.js` | `Map<remoteJid, Conversation>` con timeout de 30 min, limpieza automática cada 5 min, merge de datos parciales |
| 7 | **Filtro de Autorización** | `server.js` | Variable `AUTHORIZED_NUMBERS` en `.env`. Soporta lista separada por comas o `*` para todos |
| 8 | **Logs de Transacciones** | `server.js` | Archivo `transactions.json` con tipo, datos, estado, error y timestamp. Últimas 1000 transacciones |
| 9 | **Envío de Imágenes** | `server.js` | Función `sendImageMessage()` codifica imagen a base64 y envía vía Evolution API |
| 10 | **Endpoints /health y /stats** | `server.js` | Health check con uptime/memoria/conversaciones activas. Stats con conteo de transacciones |
| 11 | **Saludos e Intención Desconocida** | `server.js` | Detecta `intent: "greeting"` y responde presentación. `intent: "unknown"` pide aclaración |
| 12 | **Manejo de Errores** | `scraper.js` | Captura errores, toma screenshot, retorna `{success: false, error: mensaje}` |
| 13 | **CLI para pruebas** | `scraper.js` | `node scraper.js topup "Claro" 0991234567 5` y `node scraper.js bill "CNEL" 1234567890` |
| 14 | **Guía de Configuración** | `SETUP.md` | Pasos para obtener API Key de DeepSeek, configurar Evolution API y desplegar |

### ✅ Mejoras Técnicas

- **Selectores dinámicos**: Busca inputs por placeholder, tipo y posición; botones por regex de texto
- **Screenshots automáticos**: Captura resultados exitosos y errores para debugging
- **Detección de éxito/error**: Busca palabras clave en la página después de la transacción
- **Timeout en navegador**: Chromium con `--no-sandbox` para entornos restringidos
- **Expresiones regulares**: Para buscar botones y confirmaciones
- **Merge de contexto**: Combina datos de mensajes anteriores con los nuevos automáticamente

---

## Lo que Falta Implementar ❌

### 🔴 Crítico

| # | Pendiente | Impacto | Solución |
|---|---|---|---|
| 1 | **Selectores exactos del DOM post-login** | El scraper usa selectores genéricos. Si BeMovil cambia, falla | Ejecutar scraper y ajustar selectores a clases CSS reales según screenshots |
| 2 | **Manejo de stock/saldo insuficiente** | Si no hay saldo, el scraper falla sin avisar al usuario | Detectar "saldo insuficiente" y notificar |
| 3 | **Confirmación antes de ejecutar** | Ejecuta inmediatamente al tener todos los datos | Pedir "¿Confirmas la recarga de $5 a Claro 0991234567?" |

### 🟠 Alto

| # | Pendiente | Impacto | Solución |
|---|---|---|---|
| 4 | **Base de datos persistente** | Conversaciones se pierden al reiniciar | SQLite o Redis para persistencia |
| 5 | **Validación de montos mínimos/máximos** | Usuario puede pedir montos no soportados | Validar $1-$50 antes de ejecutar |
| 6 | **Notificación proactiva al usuario** | Usuario no sabe si fue exitoso hasta que responde | Enviar "procesando..." inmediato |
| 7 | **Más variantes de lenguaje** | Algunas formas de pedir recarga no se detectan | Mejorar prompt con más ejemplos |

### 🟡 Media

| # | Pendiente | Solución Propuesta |
|---|---|---|
| 8 | Más servicios en prompt | Agregar más servicios al prompt de DeepSeek |
| 9 | Logging en archivo | Implementar winston/pino para logs rotativos |
| 10 | Dashboard web | Panel HTML/JS que consuma `/stats` |
| 11 | Rate limiting | Límite de 10 recargas/día por número |
| 12 | Manejo de 2FA | Detectar 2FA en BeMovil y notificar al admin |

### 🟢 Baja

| # | Pendiente | Solución Propuesta |
|---|---|---|
| 13 | Múltiples idiomas | Detección de idioma del mensaje |
| 14 | Pruebas unitarias | Tests con Jest |
| 15 | Dockerización | Dockerfile con Chromium incluido |

---

## Estructura del Proyecto

```
📁 webscrapper/
├── 📄 server.js              # 🔧 Servidor Express + webhook + DeepSeek AI + contexto + logs + stats (446 líneas)
├── 📄 scraper.js             # 🔧 Automatización Playwright para BeMovil (login, recargas, pagos)
├── 📄 .env                   # 🔒 Variables de entorno (NO SUBIR A GIT)
├── 📄 .env.example           # 📝 Ejemplo de variables
├── 📄 package.json           # 📦 Dependencias y scripts
├── 📄 package-lock.json      # 🔒 Lockfile
├── 📄 README.md              # 📖 Documentación
├── 📄 SETUP.md               # 📖 Guía rápida
├── 📄 transactions.json      # 📊 Log de transacciones (se genera automáticamente)
├── 📄 dashboard.html         # 🐛 Debug: HTML del login de BeMovil
├── 📄 dashboard.png          # 🐛 Debug: screenshot del login
├── 📄 dom.html               # 🐛 Debug: DOM extraído
├── 📄 login_page.png         # 🐛 Debug: screenshot login
├── 📄 dashboard_texts.json   # 🐛 Debug: textos del DOM
├── 📁 node_modules/          # 📦 Dependencias (ignorado por git)
```

---

## Instalación y Configuración

### Prerrequisitos

```bash
node --version   # v18+ (v24.12.0 recomendado)
npx playwright install chromium
```

### Instalación

```bash
git clone https://github.com/RiccijandroUpec/WebScraper.git
cd WebScraper
npm install
npx playwright install chromium
```

### Configurar `.env`

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

### Iniciar

```bash
npm start
```

Verás:

```
===============================================
    RICKTECH/BEMOVIL WHATSAPP BOT
===============================================
  Puerto:        3000
  Webhook:       /webhook
  Health:        /health
  Stats:         /stats
  Evolution API: http://localhost:8080
  DeepSeek API:  OK
  Aut. Numbers:  Todos
===============================================
```

---

## Variables de Entorno

```env
# === CREDENCIALES BEMOVIL ===
BEMOVIL_USER=REDACTED_USER
BEMOVIL_PASS=tu_contraseña

# === DEEPSEEK AI (para analizar mensajes) ===
DEEPSEEK_API_KEY=sk-tu-api-key-de-deepseek

# === EVOLUTION API (gateway WhatsApp) ===
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_TOKEN=tu_token_evolution
INSTANCE_NAME=tu_instancia

# === OPCIONAL ===
# AUTHORIZED_NUMBERS=593991234567,593998765432   # * = todos
# PORT=3000
```

| Variable | Obligatorio | Descripción |
|---|---|---|
| `BEMOVIL_USER` | ✅ | Usuario de BeMovil |
| `BEMOVIL_PASS` | ✅ | Contraseña de BeMovil |
| `DEEPSEEK_API_KEY` | ✅ | API Key de DeepSeek (fallback a `OPENAI_API_KEY`) |
| `EVOLUTION_API_URL` | ✅ | URL de Evolution API (default: `http://localhost:8080`) |
| `EVOLUTION_API_TOKEN` | ✅ | Token de autenticación |
| `INSTANCE_NAME` | ✅ | Nombre de la instancia en Evolution API |
| `AUTHORIZED_NUMBERS` | ❌ | Números autorizados. `*` = todos |
| `PORT` | ❌ | Puerto (default: 3000) |

> `DEEPSEEK_API_KEY` también acepta `OPENAI_API_KEY` como fallback (mismo formato de API).

---

## Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/webhook` | Webhook para Evolution API |
| `GET` | `/health` | Health check (uptime, memoria, conversaciones) |
| `GET` | `/stats` | Estadísticas de transacciones |

### `/health`

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2026-06-21T20:34:39.066Z",
  "memory": { "rss": 126722048, "heapTotal": 115740672, "heapUsed": 57218440 },
  "conversations_active": 0
}
```

### `/stats`

```bash
curl http://localhost:3000/stats
```

```json
{
  "total_transactions": 15,
  "topups": { "total": 10, "success": 8, "failed": 2 },
  "bills": { "total": 5, "success": 4, "failed": 1 },
  "active_conversations": 0,
  "last_10": [{ "type": "topup", "operator": "Claro", "status": "success" }]
}
```

---

## Evolution API: infraestructura compartida

Los contenedores `evolution_api` y `evolution_db` **no están definidos en el `docker-compose.yml` de este proyecto**. Pertenecen a un proyecto hermano, **"sistema-kiosko"**, cuyo compose vive en:

```
C:\xampp\htdocs\sistema de kiosko impresiones\sistema-kiosko\docker-compose-evolution.yml
```

`docker-compose.yml` de webscrapper declara la red `sistema-kiosko_default` como `external: true` y el servicio `bot` se une a ella, reutilizando así la instancia de Evolution API que ya corre para el kiosko en vez de levantar una propia. Para cualquier cambio de imagen/versión/env de Evolution API hay que editar **ese otro** compose, no este.

La configuración de Evolution API queda persistida en su propio Postgres (`evolution_db`), así que sobrevive a recreaciones del contenedor `evolution_api` (instancia, webhook, settings).

### Bug conocido: Evolution API `:latest` + Baileys RC rompe el pairing de WhatsApp

Síntoma: el QR se escanea, el celular muestra "no se puede conectar", y los logs de `evolution_api` repiten este patrón cada intento:

```
"stream errored out" (tag stream:error, code 515)
"Pre-key upload timeout" (408)
```

Causa: la imagen `evoapicloud/evolution-api:latest` resolvía a **v2.3.7**, que trae **Baileys 7.0.0-rc.9** (release candidate con una regresión conocida — ver issue #2437 en `EvolutionAPI/evolution-api`). La versión **v2.3.6** (Baileys rc.6) no tiene este problema.

Solución aplicada: en `docker-compose-evolution.yml` se fijó la imagen a `evoapicloud/evolution-api:v2.3.6` en vez de `:latest`, y se recreó el contenedor (`docker rm -f evolution_api && docker compose -f docker-compose-evolution.yml up -d evolution_api`).

Nota práctica: el QR estático descargado por API (`GET /instance/connect/{instance}`) caduca en ~20-30s. Para vincular el dispositivo usar el **Manager web** (`http://localhost:8080/manager`, login con la `apikey`), que refresca el QR solo y evita falsos "no se puede conectar" por código vencido.

### Formato de body correcto para enviar mensajes (Evolution API v2)

`server.js` envía mensajes con el schema **v2** (flat), confirmado leyendo `/evolution/dist/validate/message.schema.*` dentro del contenedor:

```js
// Texto: POST /message/sendText/{instance}
{ number, text, delay }

// Imagen: POST /message/sendMedia/{instance} (NO existe /sendImage)
{ number, mediatype: "image", mimetype, media /* base64 */, caption }
```

Si después de una actualización de Evolution API los envíos vuelven a fallar en silencio (o a colgarse), revisar primero si cambió el schema de body antes de asumir que es un problema de conexión.

### Bug conocido: socket de WhatsApp queda "zombie" (`state: "open"` pero no llega nada)

Síntoma: el bot deja de responder mensajes. `GET /instance/connectionState/{instance}` sigue devolviendo `"open"`, el webhook de la instancia está bien configurado (`http://ricktech-bot:3000/webhook`, evento `MESSAGES_UPSERT`), y la conectividad de red entre contenedores funciona — pero ningún mensaje nuevo llega al endpoint `/webhook` del bot.

Cómo confirmarlo sin asumir nada: comparar la hora del mensaje de prueba con el último mensaje que Evolution API tiene realmente guardado:

```bash
curl -s -X POST -H "apikey: $EVOLUTION_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"where":{}}' "http://localhost:8080/chat/findMessages/$INSTANCE_NAME" | head -c 500
```

Si el `messageTimestamp` más reciente es de varios minutos atrás (anterior a tus pruebas), el mensaje nunca llegó a Baileys — no es un problema del bot ni del webhook, es el socket de WhatsApp colgado.

Causa: el websocket de Baileys deja de recibir eventos push de los servidores de WhatsApp aunque la conexión siga marcada como abierta (falla conocida de Baileys, no depende del código de este proyecto).

Solución: `docker restart evolution_api` (~15s). La sesión/pairing no se pierde (vive en Postgres, en `evolution_db`), no hace falta volver a escanear el QR.

### El bot no refleja cambios de código después de editar `server.js`

El servicio `bot` en `docker-compose.yml` usa `build: .` **sin bind-mount** del código fuente (solo se monta el volumen `bot_screenshots`). Esto significa que `docker compose restart bot` o `docker restart ricktech-bot` **reinician la imagen ya compilada**, sin aplicar cambios hechos en el código local.

Para que un cambio en `server.js`/`scraper.js`/`db.js` se refleje, hay que reconstruir la imagen:

```bash
docker compose up -d --build bot
```

---

## Uso desde Línea de Comandos

```bash
# Recarga
node scraper.js topup "Claro" 0991234567 5

# Pago de servicio
node scraper.js bill "CNEL" 1234567890

# Ver código de salida
node scraper.js topup "Claro" 0991234567 5 && echo "Exito" || echo "Fallo"
```

| Comando | Arg 1 | Arg 2 | Arg 3 |
|---|---|---|---|
| `topup` | Operadora (Claro, Movistar, CNT, Tuenti, OpenMobile) | Teléfono (10 dígitos) | Monto (5, 10, 20) |
| `bill` | Servicio (CNEL, CNT, ETAPA, Agua Quito) | Referencia (cédula/contrato) | — |

---

## Scripts NPM

```bash
npm start         # Iniciar servidor
npm run dev       # Iniciar con --watch (reinicio automático al editar)
npm test          # Probar scraper: recarga $1 a Claro 0991234567
npm run test:bill # Probar scraper: consulta CNEL
npm run health    # curl http://localhost:3000/health
npm run stats     # curl http://localhost:3000/stats
```

---

## Solución de Problemas

### `ECONNREFUSED` con Evolution API
```
Causa: Evolution API no está corriendo
Solucion: Iniciar Evolution API y verificar URL en .env
```

### Playwright no encuentra Chromium
```
Causa: Chromium no instalado
Solucion: npx playwright install chromium
```

### DeepSeek 401 Unauthorized
```
Causa: API Key inválida o desactivada
Solucion:
  1. Ir a https://platform.deepseek.com/api_keys
  2. Verificar toggle verde (activated)
  3. Copiar key correcta a DEEPSEEK_API_KEY en .env
```

### DeepSeek 402 Payment Required
```
Causa: Saldo insuficiente
Solucion: Ir a https://platform.deepseek.com/top_up
```

### Login en BeMovil falla
```
Causa: Credenciales incorrectas o cambios en el login
Solucion: Verificar BEMOVIL_USER y BEMOVIL_PASS en .env
         Revisar login_page.png para ver el error
```

### WhatsApp no conecta / QR falla / mensajes no llegan
```
Ver seccion "Evolution API: infraestructura compartida" mas arriba.
Causas mas comunes: imagen :latest con bug de Baileys RC, QR estatico vencido,
o socket "zombie" (state=open pero Baileys no recibe nada -> reiniciar evolution_api).
```

### El bot no responde y no aparece nada en los logs ni con un log de debug agregado
```
Causa probable: editaste server.js pero solo hiciste restart, no rebuild.
Solucion: docker compose up -d --build bot (ver seccion "Evolution API:
infraestructura compartida" -> "El bot no refleja cambios de codigo").
```

---

## Licencia

**Uso privado — RickTech** © 2026

---

## Repositorio

https://github.com/RiccijandroUpec/WebScraper
