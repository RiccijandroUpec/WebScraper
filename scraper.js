const { chromium } = require('playwright');
require('dotenv').config();

// ============================================================
// Utilidades
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    await page.waitForTimeout(500);

    // El dropdown de países se abre. Buscar Ecuador por su texto
    const ecuadorOption = page.locator('.country', { hasText: 'Ecuador' });
    await ecuadorOption.waitFor({ state: 'visible', timeout: 5000 });
    await ecuadorOption.click();
    await page.waitForTimeout(300);

    // 2. Ingresar usuario
    console.log('[LOGIN] Ingresando usuario...');
    const userInput = page.locator('input[type="text"]');
    await userInput.waitFor({ state: 'visible', timeout: 5000 });
    // Limpiar y llenar
    await userInput.click();
    await userInput.fill('');
    await userInput.fill(process.env.BEMOVIL_USER);

    // Hacer clic en el botón de submit del formulario (primer envío: usuario)
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
    await page.waitForTimeout(1500);

    // 3. Ingresar contraseña
    console.log('[LOGIN] Ingresando contraseña...');
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 8000 });
    await passInput.click();
    await passInput.fill('');
    await passInput.fill(process.env.BEMOVIL_PASS);

    // Hacer clic en Iniciar sesión
    await submitBtn.click();

    // 4. Esperar a que cargue el dashboard (backoffice/sell)
    console.log('[LOGIN] Esperando dashboard...');
    await page.waitForURL('**/backoffice/**', { timeout: 20000 });
    await page.waitForTimeout(2000);
    console.log('[LOGIN] ¡Login exitoso!');
}

// ============================================================
// RECARGAS (sellTopup)
// ============================================================

async function sellTopup(operator, phone, amount) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        await login(page);

        console.log('============================================');
        console.log(`💳 INICIANDO VENTA DE RECARGA`);
        console.log(`   Operador: ${operator}`);
        console.log(`   Teléfono: ${phone}`);
        console.log(`   Monto:    $${amount}`);
        console.log('============================================');

        // Navegar a la sección de Recargas
        // Buscar en el sidebar/menú la opción "Recargas"
        await page.goto('https://bemovil.net/backoffice/sell', { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(2000);

        // Buscar el botón o enlace que dice "Recargas" en el dashboard
        const recargasBtn = page.getByText('Recargas', { exact: false }).first();
        if (await recargasBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await recargasBtn.click();
            await page.waitForTimeout(1500);
        }

        // Buscar el campo de búsqueda de operadora
        const searchInput = page.locator('input[placeholder*="Buscar"], input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await searchInput.fill(operator);
            await page.waitForTimeout(1000);
        }

        // Hacer clic en la operadora que coincida
        const operatorBtn = page.getByText(operator, { exact: false }).first();
        if (await operatorBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await operatorBtn.click();
            await page.waitForTimeout(1000);
        }

        // Buscar inputs de número y monto
        // Buscar input para número de teléfono
        const allInputs = page.locator('input:not([type="hidden"]):not([type="password"])');
        const inputCount = await allInputs.count();

        let phoneInput = null;
        let amountInput = null;

        for (let i = 0; i < inputCount; i++) {
            const input = allInputs.nth(i);
            const placeholder = await input.getAttribute('placeholder').catch(() => '');
            const type = await input.getAttribute('type').catch(() => '');

            if (placeholder && (
                placeholder.toLowerCase().includes('teléfono') ||
                placeholder.toLowerCase().includes('telefono') ||
                placeholder.toLowerCase().includes('celular') ||
                placeholder.toLowerCase().includes('número') ||
                placeholder.toLowerCase().includes('numero') ||
                placeholder.toLowerCase().includes('phone') ||
                placeholder.toLowerCase().includes('mobile')
            )) {
                phoneInput = input;
            } else if (
                placeholder &&
                (placeholder.toLowerCase().includes('monto') ||
                 placeholder.toLowerCase().includes('valor') ||
                 placeholder.toLowerCase().includes('amount') ||
                 placeholder.toLowerCase().includes('precio') ||
                 placeholder.toLowerCase().includes('$'))
            ) {
                amountInput = input;
            }
        }

        // Si no encontramos por placeholder, usar lógica posicional
        if (!phoneInput) {
            // El primer input visible de texto/number podría ser teléfono
            const visibleInputs = page.locator('input[type="text"], input[type="number"], input[type="tel"]');
            const visCount = await visibleInputs.count();
            if (visCount >= 1) phoneInput = visibleInputs.nth(0);
            if (visCount >= 2) amountInput = visibleInputs.nth(1);
        }

        if (phoneInput) {
            await phoneInput.click();
            await phoneInput.fill('');
            await phoneInput.fill(phone);
            console.log(`   ✅ Teléfono ingresado: ${phone}`);
        } else {
            console.log('   ⚠️  No se encontró input de teléfono');
        }

        if (amountInput) {
            await amountInput.click();
            await amountInput.fill('');
            await amountInput.fill(amount.toString());
            console.log(`   ✅ Monto ingresado: $${amount}`);
        } else {
            console.log('   ⚠️  No se encontró input de monto');
        }

        await page.waitForTimeout(1000);
        
        // Buscar botón de "Vender", "Realizar venta", "Continuar", etc
        const sellBtn = page.getByText(/Vender|Realizar venta|Continuar|Pagar|Comprar|Procesar/i).first();
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

async function payBill(serviceName, reference) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        await login(page);

        console.log('============================================');
        console.log(`📄 INICIANDO CONSULTA/PAGO DE SERVICIO`);
        console.log(`   Servicio:  ${serviceName}`);
        console.log(`   Referencia: ${reference}`);
        console.log('============================================');

        // Navegar a sección de recaudos
        await page.goto('https://bemovil.net/backoffice/collection', { waitUntil: 'networkidle', timeout: 20000 })
            .catch(async () => {
                // Si la URL directa no funciona, intentar desde el menú
                const recaudosBtn = page.getByText(/Recaudos|Facturas|Pagos/i).first();
                if (await recaudosBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await recaudosBtn.click();
                    await page.waitForTimeout(2000);
                }
            });

        await page.waitForTimeout(2000);

        // Buscar campo de búsqueda de servicio
        const searchInput = page.locator('input[placeholder*="Buscar"], input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await searchInput.fill(serviceName);
            await page.waitForTimeout(1500);
        }

        // Seleccionar el servicio
        const serviceOption = page.getByText(serviceName, { exact: false }).first();
        if (await serviceOption.isVisible({ timeout: 5000 }).catch(() => false)) {
            await serviceOption.click();
            await page.waitForTimeout(1500);
        }

        // Ingresar referencia (cédula/contrato)
        const refInput = page.locator('input[type="text"], input[type="number"], input[type="tel"]').first();
        if (await refInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await refInput.click();
            await refInput.fill('');
            await refInput.fill(reference);
            console.log(`   ✅ Referencia ingresada: ${reference}`);
        }

        await page.waitForTimeout(1000);

        // Botón Consultar o Pagar
        const consultarBtn = page.getByText(/Consultar|Pagar|Buscar|Ver factura/i).first();
        if (await consultarBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await consultarBtn.click();
            console.log('   ✅ Click en Consultar');
            await page.waitForTimeout(4000);
        }
        
        // Capturar resultado
        await page.screenshot({ path: 'recaudo_resultado.png', fullPage: true });
        console.log('   📸 Screenshot guardado: recaudo_resultado.png');

        // Intentar extraer información de la factura
        const facturaInfo = await page.locator('.table, .factura, .info, .resultado').first()
            .textContent().catch(() => null);
        if (facturaInfo) {
            console.log(`   📊 Información encontrada:\n${facturaInfo.substring(0, 500)}`);
        }

        return { success: true };

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
