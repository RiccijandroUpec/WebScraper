# 🤖 RickTech/BeMovil — WhatsApp Bot para Recargas y Pagos

**Sistema automatizado** que conecta WhatsApp con la plataforma [BeMovil](https://bemovil.net) para realizar **recargas móviles**, **pago de servicios** y **cualquier otro producto que venda BeMovil** (streaming, paquetes de datos, depósitos, apuestas, lotería, etc.) en Ecuador, usando **DeepSeek AI**, **Playwright** y **Evolution API**.

---

## 📋 Índice

- [Estado del Proyecto](#estado-del-proyecto)
- [Arquitectura Técnica](#arquitectura-técnica)
- [Los 3 Intents: topup / bill / order](#los-3-intents-topup--bill--order)
- [Confirmación de pago: código por pedido vía administrador](#confirmación-de-pago-código-por-pedido-vía-administrador)
- [BeMovil: anti-bot y selectores reales](#bemovil-anti-bot-y-selectores-reales)
- [Tecnologías y Herramientas Usadas](#tecnologías-y-herramientas-usadas)
- [Lo que se Implementó ✅](#lo-que-se-implementó-)
- [Lo que Falta / Limitaciones Conocidas ⚠️](#lo-que-falta--limitaciones-conocidas-️)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Instalación y Configuración](#instalación-y-configuración)
- [Variables de Entorno](#variables-de-entorno)
- [Docker](#docker)
- [Endpoints de la API](#endpoints-de-la-api)
- [Uso desde Línea de Comandos](#uso-desde-línea-de-comandos)
- [Evolution API: infraestructura compartida](#evolution-api-infraestructura-compartida)
- [Solución de Problemas](#solución-de-problemas)

---

## Estado del Proyecto

```
🚀 FUNCIONAL DE EXTREMO A EXTREMO (hasta el paso de confirmación).
   Login real verificado, anti-bot superado, recargas y consulta de
   servicios probadas con datos reales, y el descubrimiento automático
   de formularios (processOrder) verificado contra TODO el catálogo
   de BeMovil (136 productos, ver dryrun_results.json).

⚠️  NUNCA se completó un pago/recarga real de principio a fin con
   confirm:true (todas las pruebas reales fueron de rechazo controlado:
   saldo insuficiente, referencia inválida). Ver "Limitaciones Conocidas".
```

---

## Arquitectura Técnica

```
┌─────────────────────────────────────────────────────────────┐
│                    USUARIO FINAL (cliente)                   │
│              (WhatsApp en su celular)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ "Quiero Netflix" / "Recarga $5 a Claro 0991234567"
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
│  1. Recibe webhook, filtra fromMe y mensajes viejos          │
│  2. Verifica número autorizado + límite diario               │
│  3. DeepSeek clasifica: topup | bill | order | greeting      │
│  4. Mantiene contexto de conversación (BD + memoria, 30 min) │
│  5. topup/bill: junta datos directo. order: descubre el      │
│     formulario real en BeMovil (processOrder dryRun) y       │
│     pregunta dinámicamente lo que haga falta                 │
│  6. Cuando todo está completo, genera un CÓDIGO de 4 dígitos  │
│     y se lo manda SOLO al administrador (no al cliente)      │
│  7. El cliente paga en efectivo/transferencia al admin        │
│  8. El cliente reenvía el código → AHÍ se ejecuta el cobro    │
│     real en BeMovil                                           │
└─────────────────────┬───────────────────────────────────────┘
                      │ scraper.sellTopup() / payBill() / processOrder()
                      ▼
┌─────────────────────────────────────────────────────────────┐
│         SCRAPER.JS (Playwright + Chromium, modo headed)      │
├─────────────────────────────────────────────────────────────┤
│  1. Reutiliza sesión guardada (.bemovil-session.json) si      │
│     sigue vigente; si no, hace login completo (tecleado       │
│     humano, headless:false — BeMovil bloquea Chromium         │
│     headless real con un HTTP 400 disfrazado de error)        │
│  2. Busca el producto en el buscador real de BeMovil          │
│  3. Descubre labels/botones reales del formulario en vivo     │
│     (no hay un formulario fijo por categoría)                 │
│  4. Llena los campos y se DETIENE antes de cualquier botón    │
│     que cobre, salvo que confirm:true                         │
│  5. Detecta éxito/error comparando banners antes/después y    │
│     si el modal de confirmación sigue abierto tras el click   │
└─────────────────────────────────────────────────────────────┘
```

---

## Los 3 Intents: topup / bill / order

DeepSeek clasifica cada mensaje en uno de estos:

| Intent | Para qué | Función de scraper.js | Patrón del formulario |
|---|---|---|---|
| **`topup`** | Recargas de saldo móvil | `sellTopup(operator, phone, amount)` | Teléfono + monto → "Vender recarga" (un solo paso, sin confirmación previa) |
| **`bill`** | Servicios de **una sola referencia** a consultar (agua, luz, SRI, registro civil, tránsito, cobranza bancaria) | `payBill(service, reference, {confirm})` | Referencia → "Consultar"/"Realizar consulta" → modal "Confirmar venta" |
| **`order`** | **Todo lo demás** que vende BeMovil: streaming (Netflix, Disney+...), paquetes de datos, pines de juegos, depósitos bancarios, apuestas/pronósticos, lotería, retiros, internacionales | `processOrder(product, {tierChoice, fields, confirm})` | Variable — se descubre en vivo (ver abajo) |

`order` es el intent genérico: en vez de tener un formulario hardcodeado por categoría, `processOrder()` navega al producto, detecta si hay un modal "Escoger Producto" (planes/tiers con precio) y qué campos reales pide BeMovil, y `server.js` se lo pregunta al cliente dinámicamente usando esos nombres reales — no una lista fija. Ver `dryrun_results.json` para el catálogo completo ya verificado (136 productos).

---

## Confirmación de pago: código por pedido vía administrador

No hay un PIN fijo. El flujo real (decidido para que coincida con el negocio real: el cliente paga en efectivo o transferencia, no hay pasarela de pago integrada):

1. El bot junta todos los datos del pedido (y, si es `bill`/`order`, primero hace una **consulta de solo lectura** para mostrar el monto/detalle real).
2. Genera un código de **4 dígitos nuevo** (nunca el mismo dos veces) y se lo manda **solo al administrador** (`ADMIN_NUMBERS`), junto con los datos del cliente y el pedido.
3. El cliente paga en efectivo o por transferencia **directamente al administrador**, fuera del bot.
4. El administrador, ya con el pago confirmado, le dicta el código al cliente.
5. El cliente responde ese código por WhatsApp → **ahí y solo ahí** se ejecuta la acción real en BeMovil (`confirm: true`).
6. El administrador también recibe un aviso de éxito o error tras la ejecución (importante si ya cobró el efectivo y la transacción falla).

Si `ADMIN_NUMBERS` no está configurado, el bot rechaza el pedido en vez de ejecutarlo sin confirmación (falla cerrado).

---

## BeMovil: anti-bot y selectores reales

Cosas no obvias descubiertas a fuerza de pruebas reales (ver también los comentarios en `scraper.js`):

- **BeMovil bloquea Chromium headless** con un HTTP 400 "La transacción ya se está procesando `<id>`" — el `<id>` es en realidad el ID de usuario, no una transacción real; es un mensaje de detección de bots disfrazado. Por eso `scraper.js` usa `headless: false` (en Docker corre contra **Xvfb**, una pantalla virtual) + user-agent real + `navigator.webdriver` oculto + tecleo carácter por carácter en el login.
- Sesión persistida en `.bemovil-session.json` (gitignored) para no loguearse en cada llamada — `ensureLoggedIn()` la reutiliza si sigue vigente y solo hace login completo si caducó.
- Los inputs usan `<label for="...">` flotante, **no** `placeholder`.
- El modal de "Escoger Producto" / "Confirmar venta" usa la clase real `dialog-root`/`dialog-section`, no `[class*="modal"]`.
- El botón final de venta dice literalmente **"Si, realizar venta"** sin tilde en "Si".
- Operadoras de recarga reales (las únicas válidas): **Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus**. ("OpenMobile" no existe en BeMovil — era un dato inventado en una versión anterior del prompt.)
- El buscador de BeMovil es literal, no difuso: "Reg Civil" no encuentra nada, hace falta "Registro Civil" completo. Para "CNEL" hace falta especificar la regional (ej. "CNEL Guayaquil") — hay 12 entidades CNEL distintas.

---

## Tecnologías y Herramientas Usadas

| Tecnología | Propósito |
|---|---|
| **Node.js** | Runtime del servidor |
| **Express.js** | Framework HTTP, webhook |
| **Playwright** | Automatización de navegador (scraper) — modo `headless:false` + Xvfb en producción |
| **MySQL** (`mysql2`) | Persistencia de conversaciones, transacciones, números autorizados y límites diarios |
| **DeepSeek AI** (`deepseek-chat`) | Clasificación de intención, extracción de datos, prompts dinámicos para `order` |
| **Evolution API** | Gateway WhatsApp (instancia compartida con el proyecto "sistema-kiosko", ver más abajo) |
| **Docker / docker-compose** | Despliegue (bot + MySQL + phpMyAdmin), con Xvfb dentro del contenedor |

---

## Lo que se Implementó ✅

| Área | Detalle |
|---|---|
| **Login real anti-bot** | Headed + Xvfb, tecleo humano, sesión persistida y reutilizada automáticamente |
| **Recargas (`topup`)** | Las 6 operadoras reales verificadas con datos reales (sin ejecutar venta real) |
| **Pago de servicios (`bill`)** | Verificado con CNT, Agua (varias EPMAPS/Servipagos/Ser. Básicos), SRI — incluye detección de banners de error específicos por categoría (ej. "No se permite realizar transacciones en este horario") |
| **Cualquier otro producto (`order`)** | `processOrder()` genérico: descubre tiers/campos en vivo. Verificado contra los 136 productos no-Recargas del catálogo (`dryrun_results.json`) |
| **Confirmación por código de administrador** | Reemplaza un PIN fijo; código nuevo por pedido, nunca conocido de antemano por el cliente |
| **Persistencia en MySQL** | Conversaciones, transacciones, números autorizados, límites diarios (`db.js`/`init.sql`), con fallback a memoria si la BD no está disponible |
| **Multi-turno sin perder datos** | Merge de contexto que ignora valores `null`/vacíos devueltos por la IA en turnos posteriores (bug real encontrado y corregido) |
| **Dashboard** | `dashboard.html` consumiendo `/stats` |
| **Docker** | `Dockerfile` con Xvfb/xauth, `docker-compose.yml` con MySQL + phpMyAdmin + red compartida con Evolution API |
| **CLI para pruebas** | `node scraper.js topup ...` / `bill ...` |

---

## Lo que Falta / Limitaciones Conocidas ⚠️

| # | Limitación | Detalle |
|---|---|---|
| 1 | **Ningún pago/recarga real completado de principio a fin** | Todas las pruebas con `confirm:true` terminaron en rechazo controlado (saldo insuficiente, datos de prueba inválidos). El código está verificado para detectar ambos casos correctamente, pero el "camino feliz" real nunca se vio. |
| 2 | **Build de Docker sin probar en contenedor real** | El Dockerfile/compose están listos pero no se completó un build+run real en esta máquina (bloqueado por espacio en disco al momento de escribir esto). |
| 3 | **Pega2/Pega3/Pega4 (combinaciones de lotería)** | Usan un selector de dígitos de varios pasos, no un formulario simple — `processOrder` los detecta pero el botón de acción real ("Agregar combinación") no es el envío final. Seguro (no cobra mal), pero incompleto. |
| 4 | **Internacionales** | Descubrimiento verificado (todos tienen selector de plan), pero nunca se probó el llenado completo de campos. |
| 5 | **Migración de BD existente** | `init.sql` ya incluye `'order'` en el ENUM de `transactions.type`, pero una base de datos ya creada con la versión vieja necesita `ALTER TABLE transactions MODIFY type ENUM('topup','bill','order')` manual. |
| 6 | **Nunca probado con Evolution API real** | Todas las pruebas de conversación se hicieron simulando el webhook directamente con `curl`, no con WhatsApp real. |

---

## Estructura del Proyecto

```
📁 webscrapper/
├── server.js                # Express + webhook + DeepSeek (3 intents) + contexto + confirmación por código
├── scraper.js                # Playwright: login anti-bot, sellTopup, payBill, processOrder (genérico)
├── db.js                     # Conexión MySQL (conversaciones, transacciones, auth, límites diarios)
├── init.sql                  # Esquema de la base de datos
├── dashboard.html            # Panel web (consume /stats)
├── Dockerfile                # Node + Chromium + Xvfb/xauth
├── docker-compose.yml        # bot + mysql + phpmyadmin + red compartida con Evolution API
├── product_catalog.json      # Catálogo real de BeMovil escaneado (12 categorías)
├── dryrun_results.json       # Resultado de inspeccionar los 136 productos no-Recargas con processOrder
├── .env / .env.example       # Variables de entorno (.env NO se sube a git)
├── package.json
└── node_modules/              # (ignorado por git)
```

---

## Instalación y Configuración

### Prerrequisitos

```bash
node --version   # v18+
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
# Editar .env con tus credenciales reales
```

### Iniciar (sin Docker, modo local)

```bash
npm start
```

> En local (fuera de Docker) `scraper.js` abre una ventana real de Chromium (`headless:false`) — es necesario porque BeMovil bloquea el modo headless. En Docker, esto corre contra Xvfb automáticamente (ver sección Docker).

---

## Variables de Entorno

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

# Número(s) de WhatsApp del administrador que recibe el código de
# confirmación de cada pedido (solo dígitos, sin "+"; varios separados por coma)
ADMIN_NUMBERS=593987654321

# Números autorizados a usar el bot (separados por coma, o * para todos)
AUTHORIZED_NUMBERS=*

# Credenciales de MySQL (usadas por docker-compose)
MYSQL_ROOT_PASSWORD=elige_una_contraseña_fuerte
MYSQL_PASSWORD=elige_otra_contraseña_fuerte
```

| Variable | Obligatorio | Descripción |
|---|---|---|
| `BEMOVIL_USER` / `BEMOVIL_PASS` | ✅ | Credenciales reales de BeMovil |
| `DEEPSEEK_API_KEY` | ✅ | API Key de DeepSeek (fallback a `OPENAI_API_KEY`) |
| `EVOLUTION_API_URL` / `EVOLUTION_API_TOKEN` / `INSTANCE_NAME` | ✅ | Gateway de WhatsApp |
| `ADMIN_NUMBERS` | ✅ para producción | Sin esto, el bot rechaza todos los pedidos (no hay forma de confirmar pagos) |
| `AUTHORIZED_NUMBERS` | ❌ | `*` = cualquiera puede usar el bot. En producción real, restringir. |
| `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` | ✅ para Docker | Sin defaults — deben definirse explícitamente |

---

## Docker

```bash
docker compose up -d --build
```

El `Dockerfile` instala `xvfb` + `xauth` y el `CMD` corre `start.sh`, que lanza Xvfb manualmente en segundo plano antes de `node server.js` — **no usar `xvfb-run`**, se queda colgado para siempre en este entorno esperando una señal `SIGUSR1` que nunca llega (node nunca arranca, el contenedor queda "Up" sin logs). `docker-compose.yml` define `shm_size: 1gb` para el contenedor del bot (Chromium necesita más `/dev/shm` que el default de Docker).

> **Build verificado funcionando end-to-end el 2026-06-26** (bot + MySQL + phpMyAdmin levantados, `/health` OK, mensajes de WhatsApp recibidos y respondidos). Si el volumen `mysql_data` es de una corrida anterior con credenciales distintas a las de tu `.env` actual, MySQL rechazará la conexión (los env vars de usuario/password solo se aplican la primera vez que se crea el volumen) — en ese caso hay que `docker compose down` + `docker volume rm <proyecto>_mysql_data` + `docker compose up -d` para recrearlo limpio.

---

## Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/webhook` | Webhook para Evolution API |
| `GET` | `/health` | Health check (uptime, memoria, conversaciones activas) |
| `GET` | `/stats` | Estadísticas de transacciones (desde MySQL) |
| `GET` | `/dashboard` | Panel HTML |

---

## Uso desde Línea de Comandos

```bash
# Recarga (operadoras válidas: Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus)
node scraper.js topup "Claro" 0991234567 5

# Pago/consulta de servicio de una sola referencia
node scraper.js bill "CNT Telefonia Fija" 1234567890
```

`processOrder()` (intent `order`, cualquier otro producto) no tiene CLI propia todavía — se invoca solo desde `server.js`.

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

Solución aplicada en su momento (2026-06-22): en `docker-compose-evolution.yml` se fijó la imagen a `evoapicloud/evolution-api:v2.3.6` en vez de `:latest`.

> **Actualización 2026-06-26: ese mismo pin a `v2.3.6` resultó tener un bug distinto y peor — dejaba de recibir mensajes directos nuevos** (`state` seguía en `"open"`, los envíos funcionaban, pero nada entrante llegaba al webhook, sin ningún error en los logs). Se probó reiniciar el contenedor, cerrar sesión + re-escanear QR, e incluso desvincular el dispositivo desde el propio celular + QR nuevo — nada de eso lo arregló. Se descartó que fuera el número específico (se probó con un número de WhatsApp completamente distinto, mismo fallo). La solución fue volver a `:latest` (en ese momento resolvía a v2.3.7) y recrear el contenedor — las instancias ya emparejadas reconectaron solas y la recepción volvió a funcionar, sin que reapareciera el bug original del pre-key (ese bug solo afecta *parejas nuevas*, no reconexiones de sesiones ya emparejadas). **Moraleja: no asumas que el pin a `v2.3.6` sigue siendo correcto — revisa qué tag está activo actualmente en `docker-compose-evolution.yml` antes de gastar tiempo en otras hipótesis si dejan de llegar mensajes.**

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

Solución habitual: `docker restart evolution_api` (~15s). La sesión/pairing no se pierde (vive en Postgres, en `evolution_db`), no hace falta volver a escanear el QR.

Si el restart simple NO lo arregla (sigue sin llegar nada nuevo después de reiniciar, cerrar sesión y volver a escanear QR, e incluso probando con un número distinto), el problema probablemente sea la versión de la imagen `evoapicloud/evolution-api` en sí — ver "Bug conocido: Evolution API `:latest` + Baileys RC rompe el pairing" más arriba, donde justamente el pin a `v2.3.6` causó esta misma falla de recepción y la solución fue volver a `:latest`.

### El bot no refleja cambios de código después de editar `server.js`

El servicio `bot` en `docker-compose.yml` usa `build: .` **sin bind-mount** del código fuente. Para que un cambio en `server.js`/`scraper.js`/`db.js` se refleje, hay que reconstruir la imagen:

```bash
docker compose up -d --build bot
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

### DeepSeek 402 / "Insufficient Balance"
```
Causa: Saldo insuficiente en la cuenta de DeepSeek
Solucion: https://platform.deepseek.com/top_up
IMPORTANTE: si esto pasa sin haber usado mucho la API, revisar primero que
la API key no se haya filtrado publicamente (ver historial de seguridad
del repo) antes de simplemente recargar saldo.
```

### Login en BeMovil falla / HTTP 400 "transacción ya se está procesando"
```
Causa: BeMovil detectó el navegador como bot (Chromium headless real,
o demasiados intentos de login en poco tiempo).
Solucion: confirmar que scraper.js esta usando headless:false (en Docker,
corriendo contra Xvfb). Ver seccion "BeMovil: anti-bot y selectores reales".
```

### El build de Docker falla con errores raros / muy lento
```
Causa probable: poco espacio en disco. Un build de esta imagen (Node +
Chromium + Xvfb + MySQL) necesita varios GB libres comodos.
Solucion: liberar espacio (docker system prune, revisar que no haya
otra cosa llenando el disco) antes de reintentar.
```

### WhatsApp no conecta / QR falla / mensajes no llegan
```
Ver seccion "Evolution API: infraestructura compartida" mas arriba.
```

---

## Licencia

**Uso privado — RickTech** © 2026

## Repositorio

https://github.com/RiccijandroUpec/WebScraper
