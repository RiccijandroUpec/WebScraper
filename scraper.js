const { chromium } = require('playwright');
require('dotenv').config();
const path = require('path');
const fs = require('fs');

// ============================================================
// Utilidades
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(min, max) {
    return sleep(min + Math.random() * (max - min));
}

// Escribe el texto carácter por carácter con retrasos aleatorios, como un
// humano tecleando. bemovil parece penalizar (con bloqueos tipo "transacción
// ya se está procesando") los logins donde el formulario se llena de forma
// instantánea, además de detectar Chromium headless.
async function humanType(locator, text) {
    await locator.click({ force: true });
    await locator.fill('');
    await locator.pressSequentially(text, { delay: 90 });
}

const SESSION_PATH = path.join(__dirname, '.bemovil-session.json');

// Bemovil bloquea con HTTP 400 ("La transacción ya se está procesando <id>")
// cuando detecta Chromium en modo headless. headless:false (corriendo contra
// Xvfb en Docker) + UA real + ocultar navigator.webdriver evita el bloqueo.
async function launchStealthBrowser() {
    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const hasSession = fs.existsSync(SESSION_PATH);
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        locale: 'es-EC',
        storageState: hasSession ? SESSION_PATH : undefined
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return { browser, context };
}

// ============================================================
// LOGIN
// ============================================================

async function login(page) {
    console.log('[LOGIN] Navegando a https://bemovil.net/login...');
    await page.goto('https://bemovil.net/login', { waitUntil: 'networkidle', timeout: 30000 });

    // 1. Seleccionar país: el selector de país tiene la bandera de Colombia (+57) por defecto
    console.log('[LOGIN] Seleccionando país Ecuador (+593)...');

    // Esperar que el selector de país esté visible
    await page.waitForSelector('.box-input.withvalue.md', { timeout: 10000 });

    // Hacer clic en el selector de país (donde aparece la bandera y +57)
    const countrySelector = page.locator('.box-input.withvalue.md .input-style').first();
    await countrySelector.click();
    await jitter(300, 700);

    // El dropdown de países se abre. Buscar Ecuador por su texto
    const ecuadorOption = page.locator('.country', { hasText: 'Ecuador' });
    await ecuadorOption.waitFor({ state: 'visible', timeout: 5000 });
    await ecuadorOption.click();
    await jitter(200, 500);

    // 2. Ingresar usuario (tecleado, no .fill() instantáneo)
    console.log('[LOGIN] Ingresando usuario...');
    const userInput = page.locator('input[type="text"]');
    await userInput.waitFor({ state: 'visible', timeout: 5000 });
    await humanType(userInput, process.env.BEMOVIL_USER);
    await jitter(300, 600);

    // Paso 1: botón "Continuar" revela el campo de contraseña
    const continuarBtn = page.getByRole('button', { name: 'Continuar' });
    await continuarBtn.waitFor({ state: 'visible', timeout: 5000 });
    await continuarBtn.click();
    await jitter(1200, 2000);

    // 3. Ingresar contraseña (tecleada)
    console.log('[LOGIN] Ingresando contraseña...');
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 8000 });
    await humanType(passInput, process.env.BEMOVIL_PASS);
    await jitter(400, 800);

    // Paso 2: botón "Iniciar sesión" (es un botón distinto al de "Continuar")
    const loginBtn = page.getByRole('button', { name: 'Iniciar sesión' });
    await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
    await loginBtn.click();

    // 4. Esperar a que cargue el dashboard (backoffice/sell)
    console.log('[LOGIN] Esperando dashboard...');
    await page.waitForURL('**/backoffice/**', { timeout: 20000 });
    await page.waitForTimeout(2000);
    console.log('[LOGIN] ¡Login exitoso!');

    // Guardar sesión para que las próximas llamadas no necesiten loguearse de nuevo
    await page.context().storageState({ path: SESSION_PATH });
}

// Reutiliza la sesión guardada si sigue vigente; solo hace login completo
// (con el riesgo de detección que eso implica) cuando es realmente necesario.
async function ensureLoggedIn(page) {
    if (fs.existsSync(SESSION_PATH)) {
        console.log('[LOGIN] Probando sesión guardada...');
        await page.goto('https://bemovil.net/backoffice/sell', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
        if (page.url().includes('/backoffice')) {
            console.log('[LOGIN] Sesión reutilizada, sin necesidad de login.');
            return;
        }
        console.log('[LOGIN] Sesión expirada, se requiere login completo.');
    }
    await login(page);
}

// ============================================================
// RECARGAS (sellTopup)
// ============================================================

async function sellTopup(operator, phone, amount) {
    const { browser, context } = await launchStealthBrowser();
    const page = await context.newPage();

    try {
        await ensureLoggedIn(page);

        console.log('============================================');
        console.log(`💳 INICIANDO VENTA DE RECARGA`);
        console.log(`   Operador: ${operator}`);
        console.log(`   Teléfono: ${phone}`);
        console.log(`   Monto:    $${amount}`);
        console.log('============================================');

        await page.goto('https://bemovil.net/backoffice/sell', { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(2000);

        // El buscador principal ("Buscar producto") filtra y agrupa resultados
        // por sección (Recargas, Paquetes, Internacionales, Planes, Favoritos).
        // Usamos el label flotante para ubicar el input real (no tiene placeholder).
        console.log(`   🔎 Buscando "${operator}" en el buscador de productos...`);
        const searchInput = page.getByLabel('Buscar producto');
        await searchInput.waitFor({ state: 'visible', timeout: 8000 });
        await searchInput.click({ force: true });
        await searchInput.fill(operator);
        await page.waitForTimeout(1500);

        // Tomar el resultado específicamente bajo la sección "Recargas"
        // (no bajo "Paquetes", "Internacionales" ni "Planes", que también
        // pueden contener coincidencias con el mismo nombre de operador).
        const recargasHeading = page.locator('h2', { hasText: 'Recargas' }).first();
        const foundRecargas = await recargasHeading.isVisible({ timeout: 8000 }).catch(() => false);
        if (!foundRecargas) {
            throw new Error(`No encontré la operadora "${operator}" en Recargas. Verifica el nombre (ej. Claro, Movistar, CNT, Tuenti, Akimovil, Maxiplus).`);
        }
        const recargasSection = recargasHeading.locator('xpath=following-sibling::*[1]');
        const operatorItem = recargasSection.locator('.item, [class*="item"]', { hasText: operator }).first();
        const foundOperator = await operatorItem.isVisible({ timeout: 8000 }).catch(() => false);
        if (!foundOperator) {
            throw new Error(`No encontré la operadora "${operator}" en Recargas. Verifica el nombre (ej. Claro, Movistar, CNT, Tuenti, Akimovil, Maxiplus).`);
        }
        await operatorItem.click();
        console.log(`   ✅ Producto de Recargas seleccionado: ${operator}`);
        await page.waitForTimeout(1500);

        // Formulario "Realizar recarga": campos identificados por su label flotante
        const phoneInput = page.getByLabel('Celular del cliente');
        await phoneInput.waitFor({ state: 'visible', timeout: 8000 });
        await phoneInput.click({ force: true });
        await phoneInput.fill('');
        await phoneInput.fill(phone);
        console.log(`   ✅ Teléfono ingresado: ${phone}`);

        const amountInput = page.getByLabel('Valor');
        await amountInput.waitFor({ state: 'visible', timeout: 8000 });
        await amountInput.click({ force: true });
        await amountInput.fill('');
        await amountInput.fill(amount.toString());
        console.log(`   ✅ Monto ingresado: $${amount}`);

        await page.waitForTimeout(1000);

        // Botón final "Vender recarga"
        const sellBtn = page.getByRole('button', { name: /Vender recarga/i });
        if (await sellBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await sellBtn.click();
            console.log('   ✅ Click en botón de venta');
            await page.waitForTimeout(2000);
        }

        // Confirmación final si aparece
        const confirmBtn = page.getByText(/Confirmar|Realizar venta|Sí|Aceptar|OK/i).first();
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('   ✅ Confirmación final');
            await page.waitForTimeout(2000);
        }

        // Capturar resultado
        await page.screenshot({ path: 'recarga_resultado.png', fullPage: true });
        console.log('   📸 Screenshot guardado: recarga_resultado.png');

        // Intentar obtener mensaje de éxito/error
        const successMsg = await page.getByText(/éxito|exitosa|completada|aprobada|recarga exitosa/i).first()
            .textContent().catch(() => null);
        const errorMsg = await page.getByText(/error|falló|rechazada|saldo insuficiente/i).first()
            .textContent().catch(() => null);

        if (successMsg) {
            console.log(`   ✅ Resultado: ${successMsg.trim()}`);
        } else if (errorMsg) {
            console.log(`   ❌ Resultado: ${errorMsg.trim()}`);
            throw new Error(errorMsg.trim());
        }

        console.log('   ✅ Recarga finalizada exitosamente');
        return { success: true };

    } catch (error) {
        console.error('❌ Error durante la recarga:', error.message);
        await page.screenshot({ path: 'recarga_error.png', fullPage: true }).catch(() => {});
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

// ============================================================
// PAGO DE SERVICIOS (payBill)
// ============================================================

// Por defecto SOLO consulta (no mueve dinero). Pasar { confirm: true } hace
// el clic final de pago/venta — solo debe usarse después de que un humano
// confirmó el monto exacto que devolvió la consulta (ver flujo de PIN en
// server.js).
async function payBill(serviceName, reference, { confirm = false } = {}) {
    const { browser, context } = await launchStealthBrowser();
    const page = await context.newPage();

    try {
        await ensureLoggedIn(page);

        console.log('============================================');
        console.log(`📄 INICIANDO ${confirm ? 'CONFIRMACIÓN DE PAGO' : 'CONSULTA'} DE SERVICIO`);
        console.log(`   Servicio:  ${serviceName}`);
        console.log(`   Referencia: ${reference}`);
        console.log('============================================');

        await page.goto('https://bemovil.net/backoffice/sell', { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(2000);

        // El buscador principal filtra entre Servipagos / Ser. Básicos / Otros
        // Recaudos a la vez; no hay una sola sección fija como en Recargas,
        // así que tomamos la primera coincidencia visible.
        console.log(`   🔎 Buscando "${serviceName}" en el buscador de productos...`);
        const searchInput = page.getByLabel('Buscar producto');
        await searchInput.waitFor({ state: 'visible', timeout: 8000 });
        await searchInput.click({ force: true });
        await searchInput.fill(serviceName);
        await page.waitForTimeout(1500);

        const serviceOption = page.locator('.item, [class*="item"]', { hasText: serviceName }).first();
        const foundService = await serviceOption.isVisible({ timeout: 8000 }).catch(() => false);
        if (!foundService) {
            throw new Error(`No encontré el servicio "${serviceName}" en bemovil. Intenta con el nombre completo (ej. "Registro Civil" en vez de "Reg. Civil", "CNEL Guayaquil" en vez de solo "CNEL").`);
        }
        await serviceOption.click();
        console.log(`   ✅ Servicio seleccionado: ${serviceName}`);
        await page.waitForTimeout(1500);

        // Campo de referencia: el label varía según el servicio (Nro Cuenta /
        // Contrato, Cédula, etc.), así que si no hay un label conocido caemos
        // al primer input de texto visible del formulario "Realizar venta".
        let refInput = page.getByLabel(/Nro Cuenta|Contrato|Cédula|Cedula|Referencia/i).first();
        if (!(await refInput.isVisible({ timeout: 3000 }).catch(() => false))) {
            refInput = page.locator('input[type="text"], input[type="number"], input[type="tel"]').first();
        }
        await refInput.click({ force: true });
        await refInput.fill('');
        await refInput.fill(reference);
        console.log(`   ✅ Referencia ingresada: ${reference}`);

        // Bemovil muestra avisos y errores con el mismo estilo de banner
        // (".message-container"), incluyendo restricciones que no son obvias
        // por palabras clave (ej. "No se permite realizar transacciones en
        // este horario"). Comparamos antes/después del click para detectar
        // SOLO el banner nuevo que aparece como reacción a la consulta.
        const getBanners = () => page.locator('.message-container').allTextContents();
        const bannersBefore = await getBanners().catch(() => []);

        await page.waitForTimeout(1000);

        // Botón de consulta: el texto varía según categoría ("Consultar" en
        // Otros Recaudos/SRI, "Realizar consulta" en Servipagos/Ser. Básicos).
        const consultarBtn = page.getByRole('button', { name: /consulta|pagar|ver factura/i }).first();
        await consultarBtn.click();
        console.log('   ✅ Click en Consultar');
        await page.waitForTimeout(3000);

        // Capturar resultado
        await page.screenshot({ path: 'recaudo_resultado.png', fullPage: true });
        console.log('   📸 Screenshot guardado: recaudo_resultado.png');

        const bannersAfter = await getBanners().catch(() => []);
        const newBanners = bannersAfter.filter(b => !bannersBefore.includes(b));

        // Evidencia positiva de que la consulta sí encontró algo para pagar:
        // un modal/diálogo de confirmación de venta (ej. "Confirmar venta" +
        // botón "Sí, realizar venta"). No usamos "$" como señal porque el
        // saldo "Mi Caja" del sidebar siempre tiene "$" visible.
        // "Si, realizar venta" en bemovil NO lleva tilde en "Si" (a diferencia
        // de lo esperable en español correcto) — no depender del acento.
        const confirmBtn = page.getByRole('button', { name: /realizar venta|Confirmar pago|Confirmar venta|^Pagar$/i }).first();
        const hasPayBtn = await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false);

        if (newBanners.length > 0 && !hasPayBtn) {
            const msg = newBanners.join(' / ').trim();
            console.log(`   ❌ Resultado: ${msg}`);
            throw new Error(msg);
        }

        if (!hasPayBtn) {
            // Ni error ni modal de confirmación: caso no contemplado, lo
            // tratamos como "no se pudo confirmar" en vez de asumir éxito.
            throw new Error('No pude confirmar el resultado de la consulta (no apareció ni un error ni una pantalla de confirmación de pago).');
        }

        // El modal "Confirmar venta" es el contenedor más confiable para leer
        // el detalle (monto, comisión, total) Y para detectar el resultado
        // del pago: errores como "No dispone de suficiente saldo" se renderizan
        // DENTRO de este modal con su propia clase, no en ".message-container".
        const confirmModal = page.locator('[class*="modal"]', { hasText: /Confirmar/i }).first();
        const details = await confirmModal.innerText().catch(() => null)
            || (await getBanners().catch(() => [])).join(' / ');
        console.log(`   📊 Detalle de la consulta:\n${(details || '').substring(0, 500)}`);

        if (!confirm) {
            console.log('   ℹ️  Esto solo CONSULTA el servicio; no se hizo click en el botón de pago.');
            return { success: true, details, pendingConfirm: true };
        }

        await confirmBtn.click();
        console.log('   ✅ Click en confirmar pago');
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'recaudo_resultado.png', fullPage: true });

        // Si el modal de confirmación SIGUE visible tras el click, el pago NO
        // se completó (quedó atascado mostrando el motivo del rechazo, ej.
        // "No dispone de suficiente saldo"). Solo si el modal se cerró
        // asumimos que la venta avanzó.
        const modalStillOpen = await confirmModal.isVisible({ timeout: 2000 }).catch(() => false);
        if (modalStillOpen) {
            const rejectionText = await confirmModal.innerText().catch(() => 'El pago no se completó (el modal de confirmación no se cerró).');
            console.log(`   ❌ Resultado del pago: ${rejectionText}`);
            throw new Error(rejectionText.split('\n').find(l => l && !details.includes(l)) || rejectionText);
        }

        const bannersAfterPay = await getBanners().catch(() => []);
        const payBanners = bannersAfterPay.filter(b => !bannersAfter.includes(b));
        const successMsg = payBanners.length > 0 ? payBanners.join(' / ').trim() : 'Pago confirmado (el modal de confirmación se cerró sin errores).';
        console.log(`   ✅ Resultado del pago: ${successMsg}`);
        return { success: true, details: successMsg };

    } catch (error) {
        console.error('❌ Error durante el recaudo:', error.message);
        await page.screenshot({ path: 'recaudo_error.png', fullPage: true }).catch(() => {});
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

module.exports = {
    sellTopup,
    payBill
};

// ============================================================
// EJECUCIÓN POR LÍNEA DE COMANDOS
// ============================================================
if (require.main === module) {
    const action = process.argv[2];
    if (action === 'topup') {
        const operator = process.argv[3];
        const phone = process.argv[4];
        const amount = process.argv[5];
        if (!operator || !phone || !amount) {
            console.log('❌ Faltan argumentos.');
            console.log('Uso: node scraper.js topup "<operador>" <telefono> <monto>');
            console.log('Ej:  node scraper.js topup "Claro" 0991234567 5');
            process.exit(1);
        }
        sellTopup(operator, phone, amount).then(res => {
            console.log('Resultado:', res);
            process.exit(res.success ? 0 : 1);
        });
    } else if (action === 'bill') {
        const serviceName = process.argv[3];
        const reference = process.argv[4];
        if (!serviceName || !reference) {
            console.log('❌ Faltan argumentos.');
            console.log('Uso: node scraper.js bill "<servicio>" <referencia>');
            console.log('Ej:  node scraper.js bill "CNEL" 1234567890');
            process.exit(1);
        }
        payBill(serviceName, reference).then(res => {
            console.log('Resultado:', res);
            process.exit(res.success ? 0 : 1);
        });
    } else {
        console.log('❌ Comando no reconocido.');
        console.log('Comandos disponibles:');
        console.log('  node scraper.js topup "<operador>" <telefono> <monto>');
        console.log('  node scraper.js bill "<servicio>" <referencia>');
    }
}
