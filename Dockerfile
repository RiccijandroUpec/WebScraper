# ============================================
# Dockerfile - RickTech/BeMovil WhatsApp Bot
# ============================================

# Usar imagen oficial de Node.js con Playwright
FROM node:24-slim

# Instalar dependencias necesarias para Chromium/Playwright
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    xvfb \
    xauth \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json primero (para cachear dependencias)
COPY package.json package-lock.json ./

# Instalar dependencias
RUN npm install

# Instalar Chromium para Playwright
RUN npx playwright install chromium

# Copiar el resto del código
COPY . .

RUN chmod +x start.sh

# Exponer puerto
EXPOSE 3000

# Comando por defecto
# start.sh lanza Xvfb (pantalla virtual) manualmente antes de node: Playwright
# usa headless:false porque bemovil bloquea con HTTP 400 cuando detecta Chromium
# headless. No se usa xvfb-run porque su deteccion de "Xvfb listo" via SIGUSR1
# se queda colgada en este entorno (node nunca llega a arrancar).
CMD ["./start.sh"]
