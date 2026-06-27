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
        // bemovil es una SPA: cuando la sesión caducó, la URL sigue mostrando
        // /backoffice/sell (el guard de ruta renderiza el login SIN navegar
        // a otra URL), así que checar page.url() no detecta una sesión
        // muerta. Tampoco basta con buscar "Buscar producto" visible: la
        // barra de navegación (Inicio, Reportes, etc.) y el campo de
        // búsqueda existen en el layout general del sitio incluso SIN
        // sesión válida (confirmado en producción: ambos chequeos pasaban a
        // la vez que el botón "Continuar" del login seguía visible). La
        // señal inequívoca es la AUSENCIA del botón "Continuar" del primer
        // paso del login (mismo botón que usa login() más arriba).
        const loginFormVisible = await page.getByRole('button', { name: 'Continuar' })
            .waitFor({ state: 'visible', timeout: 4000 })
            .then(() => true)
            .catch(() => false);
        if (!loginFormVisible) {
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
    let browser, context, page;
    try {
        ({ browser, context } = await launchStealthBrowser());
        page = await context.newPage();
    } catch (error) {
        console.error('❌ Error al iniciar el navegador:', error.message);
        return { success: false, error: `No se pudo iniciar el navegador: ${error.message}` };
    }

    try {
        await ensureLoggedIn(page);

        console.log('============================================');
        console.log(`💳 INICIANDO VENTA DE RECARGA`);
        console.log(`   Operador: ${operator}`);
        console.log(`   Teléfono: ${phone}`);
        console.log(`   Monto:    $${amount}`);
        console.log('============================================');

        // ensureLoggedIn() ya deja la página cargada en /backoffice/sell con
        // sesión confirmada — un goto adicional aquí recarga la SPA y puede
        // dejarla en un estado inconsistente (confirmado en producción).
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
        const foundRecargas = await recargasHeading.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!foundRecargas) {
            throw new Error(`No encontré la operadora "${operator}" en Recargas. Verifica el nombre (ej. Claro, Movistar, CNT, Tuenti, Akimovil, Maxiplus).`);
        }
        const recargasSection = recargasHeading.locator('xpath=following-sibling::*[1]');
        const operatorItem = recargasSection.locator('.item, [class*="item"]', { hasText: operator }).first();
        const foundOperator = await operatorItem.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
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

        // Bemovil muestra avisos y errores con el mismo estilo de banner que
        // en payBill (".message-container") — comparamos antes/después del
        // click para detectar SOLO el banner nuevo que reacciona a la venta,
        // en vez de adivinar con un texto fijo de "éxito"/"error" que puede
        // no coincidir con la redacción real de bemovil.
        const getBanners = () => page.locator('.message-container').allTextContents();
        const bannersBefore = await getBanners().catch(() => []);

        // Botón final "Vender recarga"
        const sellBtn = page.getByRole('button', { name: /Vender recarga/i });
        if (await sellBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
            await sellBtn.click();
            console.log('   ✅ Click en botón de venta');
            await page.waitForTimeout(2000);
        }

        // Confirmación final si aparece
        const confirmBtn = page.getByText(/Confirmar|Realizar venta|Sí|Aceptar|OK/i).first();
        if (await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
            await confirmBtn.click();
            console.log('   ✅ Confirmación final');
            await page.waitForTimeout(2000);
        }

        // Capturar resultado
        await page.screenshot({ path: 'recarga_resultado.png', fullPage: true });
        console.log('   📸 Screenshot guardado: recarga_resultado.png');

        // IMPORTANTE: nunca asumir éxito por defecto cuando no se reconoce
        // ningún mensaje — eso reportaba "recarga exitosa" en casos donde
        // bemovil en realidad rechazó la venta (saldo insuficiente, operador
        // equivocado) con una redacción que no coincidía con el patrón fijo
        // de texto que se buscaba antes (confirmado en producción: reportó
        // éxito en una recarga que debía fallar). Solo se confirma éxito con
        // evidencia POSITIVA; cualquier otro caso es error/incierto.
        const bannersAfter = await getBanners().catch(() => []);
        const newBanners = bannersAfter.filter(b => !bannersBefore.includes(b));

        const successMsg = await page.getByText(/recarga exitosa|venta exitosa|transacción exitosa/i).first()
            .textContent().catch(() => null);

        if (successMsg) {
            console.log(`   ✅ Resultado: ${successMsg.trim()}`);
            return { success: true, details: successMsg.trim() };
        }

        if (newBanners.length > 0) {
            const msg = newBanners.join(' / ').trim();
            console.log(`   ❌ Resultado: ${msg}`);
            throw new Error(msg);
        }

        throw new Error('No pude confirmar el resultado de la recarga (no apareció ni un mensaje de éxito ni de error). Verifica manualmente antes de confiar en este resultado.');

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
//
// Antes de pagar/consultar, hay que saber el nombre EXACTO que bemovil usa
// (su buscador es literal). Ni el cliente ni la IA lo conocen de antemano
// ("agua ibarra" vs el nombre real "AGUA EMAPA - IBARRA"), así que en vez de
// adivinar buscamos en vivo en bemovil (su propio buscador ya filtra de forma
// difusa) y devolvemos las coincidencias reales para que el cliente elija —
// el mismo patrón que processOrder() ya usa para elegir planes/tiers.
async function findBillService(query) {
    let browser, context, page;
    try {
        ({ browser, context } = await launchStealthBrowser());
        page = await context.newPage();
    } catch (error) {
        console.error('❌ Error al iniciar el navegador:', error.message);
        return { success: false, error: `No se pudo iniciar el navegador: ${error.message}` };
    }

    try {
        await ensureLoggedIn(page);
        await page.waitForTimeout(2000);

        const searchInput = page.getByLabel('Buscar producto');
        await searchInput.waitFor({ state: 'visible', timeout: 8000 });

        // El selector ".item"/[class*="item"] no es exclusivo del dropdown de
        // resultados: también matchea navegación y chrome de toda la página
        // (confirmado en producción: "Inicio", "Reportes", "Mis comisiones"...
        // aparecían como "resultados"). Filtramos solo lo que de verdad
        // contiene alguna palabra de la búsqueda, y descartamos textos muy
        // largos (esos son secciones de la página, no nombres de producto).
        const significantWords = query.split(/\s+/).filter(w => w.length >= 3);
        const wordPattern = significantWords.length > 0
            ? new RegExp(significantWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
            : null;
        const isPlausibleResult = (t) => {
            const clean = t.trim();
            if (!clean || clean.length > 60) return false;
            return wordPattern ? wordPattern.test(clean) : true;
        };

        // El buscador de bemovil ya filtra de forma difusa contra lo que se
        // escriba — probamos con la consulta completa primero, y si no
        // aparece nada, con palabras sueltas (de más a menos significativas:
        // las más largas primero), para no depender de que el usuario o la
        // IA acierten el nombre completo y exacto.
        const candidateQueries = [query, ...significantWords.filter(w => w.length >= 4).sort((a, b) => b.length - a.length)];
        const seen = new Set();
        let items = [];

        for (const q of candidateQueries) {
            await searchInput.click({ force: true });
            await searchInput.fill('');
            await searchInput.fill(q);
            await page.waitForTimeout(1500);

            const texts = await page.locator('.item:visible, [class*="item"]:visible').allTextContents().catch(() => []);
            for (const t of texts) {
                const clean = t.trim();
                if (clean && isPlausibleResult(clean) && !seen.has(clean)) { seen.add(clean); items.push(clean); }
            }
            if (items.length > 0) break;
        }

        if (items.length === 0) {
            return { success: false, error: `No encontré ningún servicio parecido a "${query}" en bemovil. Intenta con otras palabras (ej. la ciudad o la empresa exacta).` };
        }

        // La búsqueda que sí trajo resultados pudo haber sido solo UNA
        // palabra (ej. "Ibarra" trae luz, agua, municipio, registro...) —
        // si alguno de los candidatos contiene TODAS las palabras
        // significativas originales (ej. "agua" Y "ibarra"), nos quedamos
        // solo con esos, mucho más precisos que la lista cruda.
        if (significantWords.length > 1) {
            const refined = items.filter(name => {
                const normalized = name.toLowerCase();
                return significantWords.every(w => normalized.includes(w.toLowerCase()));
            });
            if (refined.length > 0) items = refined;
        }

        // Más de ~8 resultados normalmente significa que la consulta era
        // demasiado genérica (ej. solo "agua") — pedirle al cliente que
        // afine en vez de mandarle una lista enorme por WhatsApp.
        if (items.length > 8) {
            return { success: false, error: `Encontré demasiados resultados parecidos a "${query}" (${items.length}). Sé más específico (ej. agrega la ciudad o empresa exacta).` };
        }
        return { success: true, candidates: items };
    } catch (error) {
        console.error('❌ Error buscando el servicio:', error.message);
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

async function payBill(serviceName, reference, { confirm = false } = {}) {
    let browser, context, page;
    try {
        ({ browser, context } = await launchStealthBrowser());
        page = await context.newPage();
    } catch (error) {
        console.error('❌ Error al iniciar el navegador:', error.message);
        return { success: false, error: `No se pudo iniciar el navegador: ${error.message}` };
    }

    try {
        await ensureLoggedIn(page);

        console.log('============================================');
        console.log(`📄 INICIANDO ${confirm ? 'CONFIRMACIÓN DE PAGO' : 'CONSULTA'} DE SERVICIO`);
        console.log(`   Servicio:  ${serviceName}`);
        console.log(`   Referencia: ${reference}`);
        console.log('============================================');

        // ensureLoggedIn() ya deja la página cargada en /backoffice/sell con
        // sesión confirmada — un goto adicional aquí recarga la SPA y puede
        // dejarla en un estado inconsistente (confirmado en producción).
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
        const foundService = await serviceOption.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
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
        if (!(await refInput.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false))) {
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
        const hasPayBtn = await confirmBtn.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);

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
        const confirmModal = page.locator('[class*="dialog-root"]', { hasText: /Confirmar/i }).first();
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
        const modalStillOpen = await confirmModal.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
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

// ============================================================
// PEDIDO GENÉRICO (processOrder) — cualquier categoría no cubierta por
// sellTopup/payBill: Tv Digital, Paquetes, Entretenimiento, Depósitos,
// Internacionales, Lotería, Retiros, Pronósticos, etc.
// ============================================================
//
// Modos de uso:
//   dryRun:true   -> solo descubre el formulario real (tiers/labels), no
//                    hace click en nada que pueda costar dinero. Seguro.
//   confirm:false (default) -> llena los campos y se detiene justo antes
//                    de pulsar el botón que cobra (Vender/Procesar/Cargar).
//                    Si el botón es de solo-consulta (Consultar/Realizar
//                    consulta) sí lo pulsa, porque eso no cobra nada.
//   confirm:true  -> ejecuta la acción real (cobra). Solo debe llamarse
//                    después de que el administrador confirmó el pedido.
const FIELD_PATTERNS = [
    // "número" solo no cuenta como teléfono: choca con "Número de Cuenta".
    { key: 'phone', re: /celular|tel[eé]fono/i },
    { key: 'email', re: /correo|email/i },
    { key: 'account', re: /nro\s*cuenta|contrato|cuenta|suministro|c[eé]dula|documento|placa|referencia|ruc|c[oó]digo|clave/i },
    { key: 'amount', re: /valor|monto/i }
];

function resolveFieldValue(label, fields) {
    const pattern = FIELD_PATTERNS.find(p => p.re.test(label));
    if (pattern && fields[pattern.key] != null && fields[pattern.key] !== '') return fields[pattern.key];
    return fields[label] != null ? fields[label] : null;
}

async function processOrder(productQuery, opts = {}) {
    const { categoryHint, tierChoice, fields = {}, confirm = false, dryRun = false } = opts;
    let browser, context, page;
    try {
        ({ browser, context } = await launchStealthBrowser());
        page = await context.newPage();
    } catch (error) {
        console.error('❌ Error al iniciar el navegador:', error.message);
        return { success: false, error: `No se pudo iniciar el navegador: ${error.message}` };
    }

    try {
        await ensureLoggedIn(page);

        console.log('============================================');
        console.log(`🛒 ${dryRun ? 'INSPECCIONANDO' : confirm ? 'CONFIRMANDO' : 'PREPARANDO'} PEDIDO: ${productQuery}`);
        console.log('============================================');

        // ensureLoggedIn() ya deja la página cargada en /backoffice/sell con
        // sesión confirmada — un goto adicional aquí recarga la SPA y puede
        // dejarla en un estado inconsistente (confirmado en producción).
        await page.waitForTimeout(2000);

        console.log(`   🔎 Buscando "${productQuery}" en el buscador de productos...`);
        const searchInput = page.getByLabel('Buscar producto');
        await searchInput.waitFor({ state: 'visible', timeout: 8000 });
        await searchInput.click({ force: true });
        await searchInput.fill(productQuery);
        await page.waitForTimeout(1500);

        let scope = page;
        if (categoryHint) {
            const heading = page.locator('h2', { hasText: categoryHint }).first();
            const foundHeading = await heading.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
            if (foundHeading) scope = heading.locator('xpath=following-sibling::*[1]');
        }

        const productItem = scope.locator('.item, [class*="item"]', { hasText: productQuery }).first();
        const foundProduct = await productItem.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!foundProduct) {
            throw new Error(`No encontré "${productQuery}" en bemovil. Verifica el nombre exacto.`);
        }
        await productItem.click();
        console.log(`   ✅ Producto seleccionado: ${productQuery}`);
        await page.waitForTimeout(1500);

        // Paso opcional: modal "Escoger Producto" (planes/tiers con precio,
        // ej. Netflix 1 Pantalla $5.10 vs Netflix Completo $14.82).
        const tierModal = page.locator('[class*="dialog-root"]', { hasText: 'Escoger Producto' }).first();
        const hasTierModal = await tierModal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
        let tierOptions = [];
        if (hasTierModal) {
            const rawOptions = await tierModal.locator('.item, [class*="item"]').allTextContents();
            tierOptions = [...new Set(rawOptions.map(t => t.trim()).filter(t => t && t !== 'Escoger Producto'))];

            if (!tierChoice) {
                return { success: false, needsTierChoice: true, tierOptions, error: 'Hay varias opciones disponibles, falta elegir cuál.' };
            }
            const tierItem = tierModal.locator('.item, [class*="item"]', { hasText: tierChoice }).first();
            const foundTier = await tierItem.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
            if (!foundTier) {
                return { success: false, needsTierChoice: true, tierOptions, error: `No encontré la opción "${tierChoice}".` };
            }
            await tierItem.click();
            console.log(`   ✅ Opción elegida: ${tierChoice}`);
            await page.waitForTimeout(1500);
        }

        // Descubrir los campos reales del formulario (label flotante real -> input)
        const discoveredFields = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input'))
                .map(i => ({
                    id: i.id,
                    label: i.id ? (document.querySelector(`label[for="${i.id}"]`)?.innerText || '') : ''
                }))
                .filter(f => f.id && f.label);
        });

        const actionBtnText = await page.evaluate(() => {
            const skip = /cancelar|atr[aá]s|volver/i;
            const btn = Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').trim();
                // Descartar botones sin texto real (ej. numpads de combinaciones
                // de lotería como Pega2/3/4: dígitos sueltos "0".."9" que no son
                // el botón de acción real) — exigir al menos 2 letras.
                return t && !skip.test(t) && b.offsetParent !== null && /[a-zA-Záéíóúñ]{2,}/.test(t);
            });
            return btn ? btn.innerText.trim() : null;
        });

        if (dryRun) {
            return {
                success: true,
                dryRun: true,
                tierOptions,
                requiredFields: discoveredFields.map(f => f.label),
                actionButton: actionBtnText
            };
        }

        const missing = [];
        for (const f of discoveredFields) {
            const value = resolveFieldValue(f.label, fields);
            if (value == null || value === '') {
                missing.push(f.label);
                continue;
            }
            // Selector de atributo, no #id: los ids generados por bemovil a
            // veces empiezan con un dígito (ej. "544ee"), lo cual es inválido
            // como selector CSS de id sin escapar.
            const input = page.locator(`[id="${f.id}"]`);
            await input.click({ force: true });
            await input.fill('');
            await input.fill(String(value));
            console.log(`   ✅ ${f.label}: ${value}`);
        }

        if (missing.length > 0) {
            return { success: false, missingFields: missing, tierOptions, error: `Faltan datos: ${missing.join(', ')}` };
        }

        await page.waitForTimeout(800);

        // Los botones de solo-consulta son seguros de pulsar siempre (no
        // cobran). El resto (Vender/Procesar/Cargar) solo se pulsa si
        // confirm:true — es la frontera real de "esto mueve dinero".
        const isConsultOnly = !!actionBtnText && /^consultar$|realizar consulta|ver factura/i.test(actionBtnText);

        if (!actionBtnText) {
            return { success: false, error: 'No encontré un botón de acción en el formulario.' };
        }

        if (!confirm && !isConsultOnly) {
            const summary = discoveredFields
                .map(f => `${f.label}: ${resolveFieldValue(f.label, fields)}`)
                .join('\n');
            return {
                success: true,
                pendingConfirm: true,
                details: `Producto: ${productQuery}${tierChoice ? ` — ${tierChoice}` : ''}\n${summary}\nAcción pendiente: "${actionBtnText}" (no ejecutada todavía)`
            };
        }

        const getBanners = () => page.locator('.message-container').allTextContents();
        const bannersBefore = await getBanners().catch(() => []);

        const actionBtn = page.getByRole('button', { name: actionBtnText, exact: true }).first();
        await actionBtn.click();
        console.log(`   ✅ Click en "${actionBtnText}"`);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'order_resultado.png', fullPage: true });

        const bannersAfter = await getBanners().catch(() => []);
        const newBanners = bannersAfter.filter(b => !bannersBefore.includes(b));

        // Igual que en payBill: bemovil suele mostrar un modal "Confirmar
        // venta" antes de cobrar de verdad, sin importar el botón inicial.
        const confirmBtn = page.getByRole('button', { name: /realizar venta|Confirmar pago|Confirmar venta|^Pagar$/i }).first();
        const hasConfirmModal = await confirmBtn.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);

        if (hasConfirmModal) {
            if (newBanners.length > 0) throw new Error(newBanners.join(' / ').trim());

            const confirmModal = page.locator('[class*="dialog-root"]', { hasText: /Confirmar/i }).first();
            const details = await confirmModal.innerText().catch(() => '');

            if (!confirm) {
                return { success: true, pendingConfirm: true, details };
            }

            await confirmBtn.click();
            console.log('   ✅ Click en confirmar pago');
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'order_resultado.png', fullPage: true });

            const modalStillOpen = await confirmModal.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
            if (modalStillOpen) {
                const rejectionText = await confirmModal.innerText().catch(() => 'El pago no se completó.');
                throw new Error(rejectionText.split('\n').find(l => l && !details.includes(l)) || rejectionText);
            }
            return { success: true, details };
        }

        // Sin modal de confirmación: el click ya ejecutó la acción
        // directamente (patrón tipo "Vender recarga"). Revisar el resultado.
        if (newBanners.length > 0) throw new Error(newBanners.join(' / ').trim());
        const errorMsg = await page.getByText(/error|falló|rechazada|saldo insuficiente/i).first().textContent().catch(() => null);
        if (errorMsg) throw new Error(errorMsg.trim());

        return { success: true, details: 'Operación completada.' };

    } catch (error) {
        console.error('❌ Error en processOrder:', error.message);
        await page.screenshot({ path: 'order_error.png', fullPage: true }).catch(() => {});
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

module.exports = {
    sellTopup,
    payBill,
    findBillService,
    processOrder
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
