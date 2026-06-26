# ============================================
# Dockerfile - RickTech/BeMovil WhatsApp Bot
# ============================================

# Usar imagen oficial de Node.js con Playwright
FROM node:24-slim

# Dependencias base: Xvfb (pantalla virtual) + utilidades.
# Las librerias de sistema que Chromium necesita (libgbm1, libnss3, etc.) las
# instala "playwright install --with-deps" mas abajo, no se mantienen a mano
# aqui porque una lista manual incompleta rompe el lanzamiento del navegador
# (ej.: falto libgbm.so.1 y el scraper se caia con "browser has been closed").
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
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

# Instalar Chromium + todas sus dependencias de sistema
RUN npx playwright install --with-deps chromium

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
