# Guía de Configuración - RickTech/BeMovil WhatsApp Bot

## 📋 Requisitos

- **Node.js** v18+ (tienes v24.12.0)
- **Evolution API** instalada y corriendo (para conectar con WhatsApp)
- **Cuenta en BeMovil** (recargas y pagos)
- **API Key de DeepSeek** (para entender mensajes)

---

## ⚙️ Configuración Paso a Paso

### 1️⃣ Obtener API Key de DeepSeek

1. Ve a https://platform.deepseek.com/api_keys
2. Inicia sesión con tu cuenta de Google
3. Haz clic en "Create API Key"
4. Copia la clave generada

### 2️⃣ Editar el archivo `.env`

Tu archivo `.env` actual tiene esto:

```
BEMOVIL_USER=tu_usuario_bemovil
BEMOVIL_PASS=tu_password_bemovil
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_TOKEN=tu_token_aqui
INSTANCE_NAME=tu_instancia
OPENAI_API_KEY=sk-tu-api-key
```

**Cambios necesarios:**

1. **Evolution API:** Reemplaza `tu_token_aqui` y `tu_instancia` con tus datos reales de Evolution API
2. **API Key:** Reemplaza `sk-tu-api-key` con la API Key de DeepSeek que obtuviste
3. **Opcional - Seguridad:** Agrega `AUTHORIZED_NUMBERS` para restringir qué números pueden usar el bot:

```
AUTHORIZED_NUMBERS=593991234567,593998765432
```

(Usa `*` para permitir todos los números)

### 3️⃣ Iniciar el servidor

```bash
node server.js
```

Verás algo como:
```
===============================================
    RICKTECH/BEMOVIL WHATSAPP BOT
===============================================
  Puerto:        3000
  Webhook:       /webhook
  Health:        /health
  Stats:         /stats
  Evolution API: http://localhost:8080
  DeepSeek API:    OK
  Aut. Numbers:  Todos
===============================================
```

### 4️⃣ Configurar Evolution API

En tu Evolution API, configura el webhook para que apunte a:

```
http://TU_IP:3000/webhook
```

(Si está en el mismo servidor, usa `http://localhost:3000/webhook`)

---

## 🔄 Endpoints disponibles

| Endpoint | Método | Descripción |
|---|---|---|
| `/webhook` | POST | Webhook para Evolution API |
| `/health` | GET | Estado del servidor |
| `/stats` | GET | Estadísticas de transacciones |

---

## 📱 Probar el scraper manualmente

Para probar si el scraper funciona sin WhatsApp:

```bash
# Recarga
node scraper.js topup "Claro" 0991234567 5

# Pago de servicio
node scraper.js bill "CNEL" 1234567890
```

---

## 🔧 Solución de problemas

**El servidor no inicia:**
- Verifica que todas las dependencias estén instaladas: `npm install`
- Verifica que la API Key de DeepSeek esté configurada

**El scraper falla al hacer login:**
- Verifica las credenciales de BeMovil en `.env`
- Ejecuta el scraper manualmente para ver el error exacto

**No recibe mensajes de WhatsApp:**
- Verifica que Evolution API esté corriendo
- Verifica la URL del webhook en Evolution API
- Revisa los logs del servidor

---

## 📁 Archivos del proyecto

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor web con webhook y endpoints |
| `scraper.js` | Automatización con Playwright para BeMovil |
| `transactions.json` | Log de transacciones (se crea automáticamente) |
| `node_modules/` | Dependencias del proyecto |
| `.env` | Configuración (NO compartir) |
