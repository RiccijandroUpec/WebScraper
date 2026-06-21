# 🤖 RickTech/BeMovil — WhatsApp Bot para Recargas y Pagos

**Sistema automatizado** que conecta WhatsApp con la plataforma [BeMovil](https://bemovil.net) para realizar **recargas móviles** y **pago de servicios** en Ecuador usando **Inteligencia Artificial (Google Gemini)**, **Playwright** y **Evolution API**.

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
- [Endpoints de la API](#endpoints-de-la-api)
- [Uso desde Línea de Comandos](#uso-desde-línea-de-comandos)
- [Solución de Problemas](#solución-de-problemas)

---

## Estado del Proyecto

```
⚙️  EN DESARROLLO — Funcionalidad base completa, pendientes mejoras críticas
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
│  5. Consulta a Gemini AI para clasificar intención          │
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
| **Axios** | v1.18.0 | Cliente HTTP para Evolution API y Gemini API |
| **Playwright** | v1.61.0 | Automatización de navegador (scraper) |
| **Chromium** | (incluido) | Motor de navegación headless |
| **dotenv** | v17.4.2 | Carga de variables de entorno (.env) |
| **Google Gemini API** | gemini-1.5-flash | Procesamiento de lenguaje natural (NLP) |
| **Evolution API** | v2.x | Gateway WhatsApp (webhook) |
| **BeMovil** | — | Plataforma de recargas y pagos (target) |

### APIs Externas Consumidas

1. **Google Gemini** `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`
   - Usada para: análisis de intención, extracción de datos, mantenimiento de contexto
2. **Evolution API** `http://localhost:8080/message/sendText/{instance}`
   - Usada para: enviar mensajes de texto e imágenes de vuelta al usuario

---

## Flujo de Funcionamiento

### 🔄 Ciclo Completo de una Recarga

```
1. Usuario escribe: "Recarga $5 a Claro 0991234567"
2. Evolution API recibe el mensaje → POST a /webhook
3. server.js extrae el mensaje, verifica fromMe y autorización
4. Envía prompt con contexto a Gemini AI
5. Gemini devuelve JSON:
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

### 🔄 Ciclo de Conversación Multi-Mensaje

```
Usuario: "Quiero una recarga"
  → Gemini: intent="topup", is_complete=false, missing_fields=["operator","phone","amount"]
  → Bot: "¿Para qué operadora, número y monto?"

Usuario: "A Claro"
  → Gemini: rellena "operator"="Claro" del contexto, sigue faltando phone y amount
  → Bot: "¿Cuál es el número y el monto?"

Usuario: "0991234567, $5"
  → Gemini: completó todos los datos, is_complete=true
  → Bot: ejecuta recarga
```

---

## Lo que se Implementó ✅

### ✅ Funcionalidades Completas

| # | Funcionalidad | Archivo | Detalle Técnico |
|---|---|---|---|
| 1 | **Webhook Evolution API** | `server.js` | Soporte para Evolution API v1 y v2. Extrae `conversation`, `extendedTextMessage` e `imageMessage.caption` |
| 2 | **Autenticación en BeMovil** | `scraper.js` | Login con selección de país (+593 Ecuador), usuario + contraseña con 2 pasos, espera de URL `/backoffice/**` |
| 3 | **Recargas (sellTopup)** | `scraper.js` | Navega a `/backoffice/sell`, busca operadora por texto, inputs por placeholder, botones por regex, captura screenshots |
| 4 | **Pago de Servicios (payBill)** | `scraper.js` | Navega a `/backoffice/collection`, busca servicio, ingresa referencia, captura resultado |
| 5 | **Análisis con Gemini AI** | `server.js` | Prompt estructurado con 8 reglas, operadoras válidas, servicios válidos, formato JSON estricto |
| 6 | **Persistencia de Conversación** | `server.js` | `Map<remoteJid, Conversation>` con timeout de 30 min, limpieza automática cada 5 min |
| 7 | **Filtro de Autorización** | `server.js` | Variable `AUTHORIZED_NUMBERS` en `.env`. Soporta lista separada por comas o `*` para todos |
| 8 | **Logs de Transacciones** | `server.js` | Archivo `transactions.json` con tipo, datos, estado, error y timestamp. Últimas 1000 transacciones |
| 9 | **Envío de Imágenes** | `server.js` | Función `sendImageMessage()` que codifica imagen a base64 y envía vía Evolution API |
| 10 | **Endpoints /health y /stats** | `server.js` | Health check con uptime/memoria/conversaciones activas. Stats con conteo de transacciones |
| 11 | **Saludos e Intención Desconocida** | `server.js` | Detecta `intent: "greeting"` y responde presentación. `intent: "unknown"` pide aclaración |
| 12 | **Manejo de Errores** | `scraper.js` | Captura errores, toma screenshot, retorna `{success: false, error: mensaje}` |
| 13 | **CLI para pruebas** | `scraper.js` | `node scraper.js topup "Claro" 0991234567 5` y `node scraper.js bill "CNEL" 1234567890` |
| 14 | **Guía de Configuración** | `SETUP.md` | Pasos para obtener API Key de Gemini, configurar Evolution API y desplegar |

### ✅ Mejoras Técnicas Incluidas

- **Selectores dinámicos**: Busca inputs por placeholder, tipo y posición; botones por regex de texto
- **Screenshots automáticos**: Captura resultados exitosos y errores para debugging
- **Detección de éxito/error**: Busca palabras clave en la página después de la transacción
- **Timeout en navegador**: Chromium con `--no-sandbox` para entornos restringidos
- **Expresiones regulares**: Para buscar botones (Vender|Realizar venta|Continuar), confirmaciones (Confirmar|Sí|Aceptar), errores (error|falló|rechazada)

---

## Lo que Falta Implementar ❌

### 🔴 Crítico — Imprescindible para funcionar al 100%

| # | Pendiente | Impacto | Solución Propuesta |
|---|---|---|---|
| 1 | **API Key real de Google Gemini** | El bot no puede analizar mensajes sin una clave válida. La actual (`sk-tu-api-key`) parece de OpenAI, no funciona con Gemini | Obtener clave en https://aistudio.google.com/apikey y ponerla en `.env` como `GEMINI_API_KEY` |
| 2 | **Selectores exactos del DOM post-login** | El scraper usa selectores genéricos (por placeholder, posición, texto). Si el dashboard de BeMovil cambia, falla | Ejecutar el scraper y analizar los screenshots para ajustar selectores a clases CSS y atributos reales |
| 3 | **Manejo de stock/saldo insuficiente** | Si la cuenta de BeMovil no tiene saldo, el scraper intenta vender igual y falla sin avisar al usuario | Detectar mensajes de "saldo insuficiente", "fondos insuficientes" y notificar al usuario |

### 🟠 Alto — Mejora significativa de funcionalidad

| # | Pendiente | Impacto | Solución Propuesta |
|---|---|---|---|
| 4 | **Base de datos persistente** | Las conversaciones se pierden al reiniciar el servidor (Map en memoria) | Usar SQLite o Redis para persistencia de contexto entre reinicios |
| 5 | **Manejo de múltiples operadoras** | Solo recarga en la operadora que se menciona. No detecta variantes ("$10 de claro", "recarga claro $5") | Mejorar prompt de Gemini con más ejemplos de lenguaje natural |
| 6 | **Validación de montos mínimos/máximos** | El usuario puede pedir montos no soportados por BeMovil ($0.50, $1000) | Agregar validación de montos (ej. $1-$50) antes de ejecutar scraper |
| 7 | **Notificación proactiva al usuario** | El usuario no sabe si la operación fue exitosa hasta que el bot responde (puede tardar segundos) | Enviar estado "procesando..." inmediatamente, luego el resultado |
| 8 | **Confirmación antes de ejecutar** | El bot ejecuta inmediatamente cuando tiene todos los datos | Pedir confirmación: "¿Confirmas la recarga de $5 a Claro 0991234567?" |

### 🟡 Media — Completitud del sistema

| # | Pendiente | Impacto | Solución Propuesta |
|---|---|---|---|
| 9 | **Soporte para más servicios** | Solo CNEL, CNT, ETAPA, Agua Quito, Municipio Guayaquil, Registro Civil | Agregar más servicios al prompt de Gemini |
| 10 | **Logging en archivo separado** | Los logs solo van a consola, se pierden al reiniciar | Implementar `winston` o `pino` para logs rotativos |
| 11 | **Dashboard web de administración** | No hay UI para ver transacciones o estado del bot | Crear panel web con HTML/JS que consuma `/stats` |
| 12 | **Límite de transacciones por día** | Un usuario podría abusar del sistema sin control | Agregar rate limiting por número (ej. 10 recargas/día) |
| 13 | **Manejo de 2FA en BeMovil** | Si BeMovil pide verificación en dos pasos, el login falla | Detectar si aparece solicitud de 2FA y notificar al admin |

### 🟢 Baja — Mejoras cosméticas/de conveniencia

| # | Pendiente | Impacto | Solución Propuesta |
|---|---|---|---|
| 14 | **Múltiples idiomas** | Solo responde en español | Agregar detección de idioma del mensaje |
| 15 | **Mensajes con formato** | Los emojis pueden no renderizarse igual en todos los WhatsApp | Probar y ajustar caracteres especiales |
| 16 | **Pruebas unitarias** | No hay tests automatizados | Agregar tests con Jest para server.js y scraper.js |
| 17 | **Dockerización** | Depende de Chromium instalado en el sistema | Crear Dockerfile con Playwright y Chromium incluidos |

---

## Estructura del Proyecto

```
📁 webscrapper/
├── 📄 server.js              # Servidor Express con webhook y endpoints
├── 📄 scraper.js             # Automatización con Playwright para BeMovil
├── 📄 .env                   # Variables de entorno (NO SUBIR A GIT)
├── 📄 .env.example           # Ejemplo de variables de entorno
├── 📄 package.json           # Dependencias y scripts
├── 📄 package-lock.json      # Lockfile de dependencias
├── 📄 README.md              # Esta documentación
├── 📄 SETUP.md               # Guía rápida de configuración
├── 📄 transactions.json      # Log de transacciones (se crea automáticamente)
├── 📄 dashboard.html         # HTML descargado del login de BeMovil (debug)
├── 📄 dashboard.png          # Screenshot del login (debug)
├── 📄 dom.html               # DOM extraído de BeMovil (debug)
├── 📁 node_modules/          # Dependencias instaladas (ignorar)
```

---

## Instalación y Configuración

### Prerrequisitos

```bash
# Node.js v18+
node --version   # v24.12.0

# Playwright con Chromium
npx playwright install chromium
```

### Instalación Rápida

```bash
# 1. Clonar o copiar el proyecto
cd webscrapper

# 2. Instalar dependencias
npm install

# 3. Instalar navegador Chromium para Playwright
npx playwright install chromium

# 4. Configurar .env (ver SETUP.md para detalles)
#    - Obtener API Key de Gemini en https://aistudio.google.com/apikey
#    - Configurar Evolution API (token e instancia)

# 5. Iniciar el servidor
node server.js
```

### Variables de Entorno (`.env`)

| Variable | Obligatorio | Descripción |
|---|---|---|
| `BEMOVIL_USER` | ✅ Sí | Usuario de BeMovil |
| `BEMOVIL_PASS` | ✅ Sí | Contraseña de BeMovil |
| `GEMINI_API_KEY` | ✅ Sí | API Key de Google Gemini (fallback a `OPENAI_API_KEY`) |
| `EVOLUTION_API_URL` | ✅ Sí | URL de Evolution API (default: http://localhost:8080) |
| `EVOLUTION_API_TOKEN` | ✅ Sí | Token de autenticación de Evolution API |
| `INSTANCE_NAME` | ✅ Sí | Nombre de la instancia en Evolution API |
| `AUTHORIZED_NUMBERS` | ❌ No | Números autorizados separados por coma. `*` = todos |
| `PORT` | ❌ No | Puerto del servidor (default: 3000) |

---

## Endpoints de la API

| Método | Ruta | Descripción | Respuesta |
|---|---|---|---|
| `POST` | `/webhook` | Webhook para Evolution API | `{ status: "ok" }` (inmediato) |
| `GET` | `/health` | Estado del servidor | `{ status, uptime, timestamp, memory, conversations_active }` |
| `GET` | `/stats` | Estadísticas de transacciones | `{ total_transactions, topups, bills, last_10 }` |

### Ejemplo de respuesta `/health`

```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2026-06-21T20:34:39.066Z",
  "memory": {
    "rss": 126722048,
    "heapTotal": 115740672,
    "heapUsed": 57218440,
    "external": 3744946,
    "arrayBuffers": 20593
  },
  "conversations_active": 0
}
```

### Ejemplo de respuesta `/stats`

```json
{
  "total_transactions": 15,
  "topups": { "total": 10, "success": 8, "failed": 2 },
  "bills": { "total": 5, "success": 4, "failed": 1 },
  "active_conversations": 0,
  "last_10": [ { "type": "topup", "operator": "Claro", ... } ]
}
```

---

## Uso desde Línea de Comandos

El scraper puede ejecutarse independientemente del servidor para pruebas:

```bash
# Recarga
node scraper.js topup "Claro" 0991234567 5

# Pago de servicio
node scraper.js bill "CNEL" 1234567890

# Ver resultado de salida
node scraper.js topup "Claro" 0991234567 5 && echo "✅ Éxito" || echo "❌ Falló"
```

### Parámetros

| Comando | Argumento 1 | Argumento 2 | Argumento 3 |
|---|---|---|---|
| `topup` | Operadora (ej: "Claro", "Movistar") | Teléfono (10 dígitos) | Monto (ej: 5, 10, 20) |
| `bill` | Servicio (ej: "CNEL", "CNT") | Referencia (cédula/contrato) | — |

---

## Solución de Problemas

### Error: `ECONNREFUSED` al conectar con Evolution API
```
Causa: Evolution API no está corriendo
Solución: Iniciar Evolution API y verificar URL en .env
```

### Error: Playwright no encuentra Chromium
```
Causa: Chromium no instalado
Solución: npx playwright install chromium
```

### Error: Gemini devuelve respuestas vacías
```
Causa: API Key inválida o sin créditos
Solución: Verificar que GEMINI_API_KEY en .env sea una clave real de Google AI Studio
```

### Error: Login en BeMovil falla
```
Causa: Credenciales incorrectas o cambios en la página de login
Solución: Verificar BEMOVIL_USER y BEMOVIL_PASS en .env. Revisar screenshot login_page.png
```

---

## Licencia

**Uso privado — RickTech** © 2026
