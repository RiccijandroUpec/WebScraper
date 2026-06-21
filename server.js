require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const scraper = require('./scraper');

// ============================================================
// CONFIGURACION
// ============================================================

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_API_TOKEN = process.env.EVOLUTION_API_TOKEN || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || '';
const AUTHORIZED_NUMBERS = process.env.AUTHORIZED_NUMBERS || '*';
const TRANSACTIONS_LOG = path.join(__dirname, 'transactions.json');

// ============================================================
// PERSISTENCIA DE CONVERSACIONES
// ============================================================

const conversations = new Map();
const CONTEXT_TIMEOUT = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [jid, conv] of conversations.entries()) {
    if (now - conv.lastMessage > CONTEXT_TIMEOUT) {
      conversations.delete(jid);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// LOGS DE TRANSACCIONES
// ============================================================

function logTransaction(entry) {
  try {
    let transactions = [];
    if (fs.existsSync(TRANSACTIONS_LOG)) {
      transactions = JSON.parse(fs.readFileSync(TRANSACTIONS_LOG, 'utf8'));
    }
    entry.timestamp = new Date().toISOString();
    transactions.push(entry);
    if (transactions.length > 1000) transactions = transactions.slice(-1000);
    fs.writeFileSync(TRANSACTIONS_LOG, JSON.stringify(transactions, null, 2));
  } catch (err) {
    console.error('[LOG] Error:', err.message);
  }
}

// ============================================================
// EXTRACCION DE MENSAJES DEL WEBHOOK
// ============================================================

function extractMessage(body) {
  try {
    if (body && body.data && body.data.message && body.data.message.conversation) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.conversation };
    }
    if (body && body.data && body.data.message && body.data.message.extendedTextMessage && body.data.message.extendedTextMessage.text) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.extendedTextMessage.text };
    }
    if (body && body.message && body.message.conversation) {
      return { remoteJid: (body.key && body.key.remoteJid) || body.from, fromMe: (body.key && body.key.fromMe) || false, text: body.message.conversation };
    }
    if (body && body.message && body.message.extendedTextMessage && body.message.extendedTextMessage.text) {
      return { remoteJid: (body.key && body.key.remoteJid) || body.from, fromMe: (body.key && body.key.fromMe) || false, text: body.message.extendedTextMessage.text };
    }
    if (body && body.data && body.data.message && body.data.message.imageMessage && body.data.message.imageMessage.caption) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.imageMessage.caption };
    }
    return null;
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    return null;
  }
}

function isAuthorized(remoteJid) {
  if (AUTHORIZED_NUMBERS === '*') return true;
  const numbers = AUTHORIZED_NUMBERS.split(',').map(function(n) { return n.trim(); });
  const phone = remoteJid.split('@')[0];
  return numbers.indexOf(phone) !== -1;
}

// ============================================================
// ENVIO DE MENSAJES WHATSAPP
// ============================================================

async function sendWhatsAppMessage(remoteJid, text) {
  try {
    const url = EVOLUTION_API_URL + '/message/sendText/' + INSTANCE_NAME;
    await axios.post(url, {
      number: remoteJid,
      options: { delay: 1200, presence: 'composing' },
      textMessage: { text: text }
    }, {
      headers: { 'apikey': EVOLUTION_API_TOKEN, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log('[WHATSAPP] Mensaje enviado a ' + remoteJid);
  } catch (error) {
    console.error('[WHATSAPP] Error:', error && error.response && error.response.data || error.message);
  }
}

async function sendImageMessage(remoteJid, imagePath, caption) {
  try {
    if (!fs.existsSync(imagePath)) return;
    const base64 = fs.readFileSync(imagePath, { encoding: 'base64' });
    const url = EVOLUTION_API_URL + '/message/sendImage/' + INSTANCE_NAME;
    await axios.post(url, {
      number: remoteJid,
      options: { delay: 1200, presence: 'composing' },
      imageMessage: { image: base64, caption: caption || '' }
    }, {
      headers: { 'apikey': EVOLUTION_API_TOKEN, 'Content-Type': 'application/json' },
      timeout: 30000
    });
  } catch (error) {
    console.error('[WHATSAPP] Error imagen:', error && error.response && error.response.data || error.message);
  }
}

// ============================================================
// DEEPSEEK AI
// ============================================================

async function analyzeIntent(userMessage, context) {
  if (context === undefined) context = {};
  var contextStr = JSON.stringify(context, null, 2);

  var systemPrompt = [
    'Eres el asistente virtual de WhatsApp para "RickTech/Bemovil", un sistema de recargas moviles y pago de servicios en Ecuador.',
    'Debes analizar el mensaje del usuario y extraer los datos.',
    '',
    'CONTEXTO ANTERIOR (datos ya recopilados):',
    contextStr,
    '',
    'USA EL CONTEXTO. Si ya tiene un valor, NO LO PIDAS DE NUEVO.',
    '',
    'INSTRUCCIONES:',
    '- Combina mensaje nuevo con contexto anterior.',
    '- Si contexto ya tiene operador y mensaje no lo menciona, conserva contexto.',
    '- Si contexto ya tiene telefono y mensaje no lo menciona, conserva contexto.',
    '- Si contexto ya tiene monto y mensaje no lo menciona, conserva contexto.',
    '- Si completaste usando contexto, marca is_complete=true.',
    '- RESPUESTA: SOLO JSON valido. NADA MAS.',
    '',
    'OPERADORAS: Claro, Movistar, CNT, Tuenti, OpenMobile (Ecuador)',
    'SERVICIOS: CNEL, CNT, ETAPA, Agua Quito, Municipio Guayaquil, Registro Civil',
    '',
    'JSON:',
    '{"intent":"topup"|"bill"|"unknown"|"greeting", "is_complete":bool, "reply_message":"texto",',
    ' "topup_data":{"operator":"nombre|null","phone":"10dig|null","amount":"numero|null"},',
    ' "bill_data":{"service":"nombre|null","reference":"numero|null"},',
    ' "missing_fields":["campos","faltantes"]}',
    '',
    'REGLAS:',
    '1. Saludo -> intent:"greeting"',
    '2. Recarga: operadora + telefono(10 dig) + monto',
    '3. Pago: servicio + referencia',
    '4. Faltan datos -> is_complete=false, explica QUE falta',
    '5. Datos completos (con contexto) -> is_complete=true',
    '6. Telefono: 10 dig, sin +593. Ej: 0991234567',
    '7. Monto: solo numeros. Ej: 5, 10',
    '8. Solo "recargar" -> pide los 3 datos'
  ].join('\n');

  try {
    var fullPrompt = systemPrompt + '\\n\\nMensaje del usuario: ' + userMessage;
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.1,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    var text = null;
    if (response.data && response.data.choices && response.data.choices[0] &&
        response.data.choices[0].message && response.data.choices[0].message.content) {
      text = response.data.choices[0].message.content;
    }

    if (!text) {
      console.error('[DEEPSEEK] Respuesta vacia:', JSON.stringify(response.data));
      return null;
    }

    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('[DEEPSEEK] Error:', error && error.response && error.response.data || error.message);
    return null;
  }
}

// ============================================================
// ENDPOINT PRINCIPAL: WEBHOOK
// ============================================================

app.post('/webhook', async function(req, res) {
  res.status(200).json({ status: 'ok' });

  try {
    var extracted = extractMessage(req.body);
    if (!extracted) return;

    var remoteJid = extracted.remoteJid;
    var fromMe = extracted.fromMe;
    var message = extracted.text;

    if (fromMe) return;
    if (!isAuthorized(remoteJid)) {
      console.log('[SEGURIDAD] No autorizado: ' + remoteJid);
      return;
    }

    console.log('[WEBHOOK] Mensaje de ' + remoteJid + ': "' + message + '"');

    if (!conversations.has(remoteJid)) {
      conversations.set(remoteJid, { context: {}, lastMessage: Date.now() });
    }
    var conversation = conversations.get(remoteJid);
    conversation.lastMessage = Date.now();

    var aiResponse = await analyzeIntent(message, conversation.context);

    if (!aiResponse) {
      await sendWhatsAppMessage(remoteJid, '\u26a0\ufe0f Lo siento, tuve un problema interno. Intenta de nuevo.');
      return;
    }

    console.log('[AI] Intencion: ' + aiResponse.intent + ' | Completo: ' + aiResponse.is_complete);

    if (aiResponse.intent === 'greeting') {
      await sendWhatsAppMessage(remoteJid,
        '\ud83d\udc4b Hola! Soy el asistente de *RickTech/BeMovil*.\n\n' +
        'Puedo ayudarte con:\n' +
        '\ud83d\udcf1 *Recargas moviles* (Claro, Movistar, CNT, Tuenti)\n' +
        '\ud83d\udca1 *Pago de servicios* (CNEL, CNT, Etapa, Agua Quito)\n\n' +
        'Ejemplos:\n' +
        '\u27a1\ufe0f \"Recarga $10 a Claro 0991234567\"\n' +
        '\u27a1\ufe0f \"Paga mi planilla de CNEL 1234567890\"\n\n' +
        'En que puedo ayudarte hoy? \ud83d\ude0a'
      );
      return;
    }

    if (aiResponse.intent === 'unknown') {
      await sendWhatsAppMessage(remoteJid,
        '\ud83e\udd14 No entendi bien tu mensaje.\n\n' +
        'Puedes pedirme:\n' +
        '\ud83d\udcf1 *Recargas*: ej. \"Recarga $5 a Claro 0991234567\"\n' +
        '\ud83d\udca1 *Pagos*: ej. \"Paga CNEL con cedula 1234567890\"\n\n' +
        'Como puedo ayudarte?'
      );
      return;
    }

    // Actualizar contexto
    if (aiResponse.topup_data) {
      var mergedTopup = {};
      if (conversation.context.topup_data) {
        for (var k in conversation.context.topup_data) mergedTopup[k] = conversation.context.topup_data[k];
      }
      for (var k in aiResponse.topup_data) mergedTopup[k] = aiResponse.topup_data[k];
      conversation.context.topup_data = mergedTopup;
    }
    if (aiResponse.bill_data) {
      var mergedBill = {};
      if (conversation.context.bill_data) {
        for (var k in conversation.context.bill_data) mergedBill[k] = conversation.context.bill_data[k];
      }
      for (var k in aiResponse.bill_data) mergedBill[k] = aiResponse.bill_data[k];
      conversation.context.bill_data = mergedBill;
    }
    conversation.context.intent = aiResponse.intent;
    conversation.context.lastIntent = Date.now();

    // Responder
    await sendWhatsAppMessage(remoteJid, aiResponse.reply_message);

    // Si esta completo, ejecutar accion
    if (aiResponse.is_complete) {
      if (aiResponse.intent === 'topup' && aiResponse.topup_data) {
        var operator = aiResponse.topup_data.operator;
        var phone = aiResponse.topup_data.phone;
        var amount = aiResponse.topup_data.amount;
        console.log('[SCRAPER] Recarga: ' + operator + ' | ' + phone + ' | $' + amount);

        await sendWhatsAppMessage(remoteJid,
          '\u23f3 Procesando recarga de *$' + amount + '* a *' + operator + '* (' + phone + ')...\nEsto tomara unos segundos.'
        );

        var result = await scraper.sellTopup(operator, phone, amount);

        if (result && result.success) {
          await sendWhatsAppMessage(remoteJid,
            '\u2705 Recarga exitosa!\n\n\ud83d\udcf1 *Operador:* ' + operator + '\n\ud83d\udcde *Telefono:* ' + phone + '\n\ud83d\udcb0 *Monto:* $' + amount + '\n\nGracias por usar RickTech \ud83d\ude0a'
          );
          logTransaction({ type: 'topup', operator: operator, phone: phone, amount: amount, remoteJid: remoteJid, status: 'success' });
        } else {
          var errMsg = (result && result.error) || 'Error desconocido';
          await sendWhatsAppMessage(remoteJid,
            '\u274c Error al procesar la recarga.\n\nDetalle: ' + errMsg + '\n\nIntenta de nuevo o contacta a soporte.'
          );
          logTransaction({ type: 'topup', operator: operator, phone: phone, amount: amount, remoteJid: remoteJid, status: 'error', error: errMsg });
        }
        conversations.delete(remoteJid);

      } else if (aiResponse.intent === 'bill' && aiResponse.bill_data) {
        var service = aiResponse.bill_data.service;
        var reference = aiResponse.bill_data.reference;
        console.log('[SCRAPER] Servicio: ' + service + ' | Ref: ' + reference);

        await sendWhatsAppMessage(remoteJid,
          '\u23f3 Consultando *' + service + '* con referencia *' + reference + '*...'
        );

        var result = await scraper.payBill(service, reference);

        if (result && result.success) {
          await sendWhatsAppMessage(remoteJid,
            '\u2705 Consulta completada!\n\n\ud83d\udccb *Servicio:* ' + service + '\n\ud83d\udd22 *Referencia:* ' + reference + '\n\nGracias por usar RickTech \ud83d\ude0a'
          );
          await sendImageMessage(remoteJid, path.join(__dirname, 'recaudo_resultado.png'), 'Resultado - ' + service);
          logTransaction({ type: 'bill', service: service, reference: reference, remoteJid: remoteJid, status: 'success' });
        } else {
          var errMsg = (result && result.error) || 'Error desconocido';
          await sendWhatsAppMessage(remoteJid,
            '\u274c Error al consultar el servicio.\n\nDetalle: ' + errMsg + '\n\nVerifica los datos.'
          );
          logTransaction({ type: 'bill', service: service, reference: reference, remoteJid: remoteJid, status: 'error', error: errMsg });
        }
        conversations.delete(remoteJid);
      }
    }

  } catch (err) {
    console.error('[WEBHOOK] Error general:', err.message);
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    conversations_active: conversations.size
  });
});

// ============================================================
// ESTADISTICAS
// ============================================================

app.get('/stats', function(req, res) {
  try {
    var transactions = [];
    if (fs.existsSync(TRANSACTIONS_LOG)) {
      transactions = JSON.parse(fs.readFileSync(TRANSACTIONS_LOG, 'utf8'));
    }
    var totalTopups = 0;
    var totalBills = 0;
    var successTopups = 0;
    var successBills = 0;
    for (var i = 0; i < transactions.length; i++) {
      if (transactions[i].type === 'topup') {
        totalTopups++;
        if (transactions[i].status === 'success') successTopups++;
      } else if (transactions[i].type === 'bill') {
        totalBills++;
        if (transactions[i].status === 'success') successBills++;
      }
    }
    var last10 = transactions.slice(-10).reverse();
    res.json({
      total_transactions: transactions.length,
      topups: { total: totalTopups, success: successTopups, failed: totalTopups - successTopups },
      bills: { total: totalBills, success: successBills, failed: totalBills - successBills },
      active_conversations: conversations.size,
      last_10: last10
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, function() {
  console.log('');
  console.log('===============================================');
  console.log('    RICKTECH/BEMOVIL WHATSAPP BOT');
  console.log('===============================================');
  console.log('  Puerto:        ' + PORT);
  console.log('  Webhook:       /webhook');
  console.log('  Health:        /health');
  console.log('  Stats:         /stats');
  console.log('  Evolution API: ' + EVOLUTION_API_URL);
  console.log('  DeepSeek API:  ' + (DEEPSEEK_API_KEY ? 'OK' : 'FALTA KEY'));
  console.log('  Aut. Numbers:  ' + (AUTHORIZED_NUMBERS === '*' ? 'Todos' : AUTHORIZED_NUMBERS));
  console.log('===============================================');
  console.log('');
  console.log('Esperando mensajes de WhatsApp...');
});
