// ============================================
// server.js - RickTech/BeMovil WhatsApp Bot
// ============================================
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const scraper = require('./scraper');
const db = require('./db');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_API_TOKEN = process.env.EVOLUTION_API_TOKEN || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || '';

// ============================================
// CONTEXTO EN MEMORIA (fallback si no hay BD)
// ============================================
const memoryConversations = new Map();
const CONTEXT_TIMEOUT = 30 * 60 * 1000;

setInterval(async () => {
  const now = Date.now();
  for (const [jid, conv] of memoryConversations.entries()) {
    if (now - conv.lastMessage > CONTEXT_TIMEOUT) {
      memoryConversations.delete(jid);
    }
  }
  await db.cleanOldConversations().catch(() => {});
}, 5 * 60 * 1000);

// ============================================
// EXTRACCIÓN DE MENSAJES DEL WEBHOOK
// ============================================

function extractMessage(body) {
  try {
    const timestamp = body?.data?.messageTimestamp || body?.messageTimestamp || null;
    if (body?.data?.message?.conversation) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.conversation, timestamp };
    }
    if (body?.data?.message?.extendedTextMessage?.text) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.extendedTextMessage.text, timestamp };
    }
    if (body?.data?.message?.imageMessage?.caption) {
      return { remoteJid: body.data.key.remoteJid, fromMe: body.data.key.fromMe, text: body.data.message.imageMessage.caption, timestamp };
    }
    if (body?.message?.conversation) {
      return { remoteJid: body.key?.remoteJid || body.from, fromMe: body.key?.fromMe || false, text: body.message.conversation, timestamp };
    }
    if (body?.message?.extendedTextMessage?.text) {
      return { remoteJid: body.key?.remoteJid || body.from, fromMe: body.key?.fromMe || false, text: body.message.extendedTextMessage.text, timestamp };
    }
    return null;
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    return null;
  }
}

// Ignora mensajes recibidos con retraso (reconexiones, reinicios en desarrollo)
// para que el bot no conteste mensajes viejos como si fueran nuevos.
const MAX_MESSAGE_AGE_MS = 2 * 60 * 1000;

function isStaleMessage(timestamp) {
  if (!timestamp) return false;
  const ms = Number(timestamp) * (Number(timestamp) < 1e12 ? 1000 : 1);
  return Date.now() - ms > MAX_MESSAGE_AGE_MS;
}

// ============================================
// ENVÍO DE MENSAJES WHATSAPP
// ============================================

async function sendWhatsAppMessage(remoteJid, text) {
  try {
    const url = `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`;
    await axios.post(url, {
      number: remoteJid,
      text,
      delay: 1200
    }, {
      headers: { apikey: EVOLUTION_API_TOKEN, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`[WHATSAPP] Enviado a ${remoteJid}`);
  } catch (error) {
    console.error('[WHATSAPP] Error:', error?.response?.data || error.message);
  }
}

async function sendImageMessage(remoteJid, imagePath, caption) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(imagePath)) return;
    const base64 = fs.readFileSync(imagePath, { encoding: 'base64' });
    const url = `${EVOLUTION_API_URL}/message/sendMedia/${INSTANCE_NAME}`;
    await axios.post(url, {
      number: remoteJid,
      mediatype: 'image',
      mimetype: 'image/png',
      media: base64,
      caption: caption || ''
    }, {
      headers: { apikey: EVOLUTION_API_TOKEN, 'Content-Type': 'application/json' },
      timeout: 30000
    });
  } catch (error) {
    console.error('[WHATSAPP] Error img:', error?.response?.data || error.message);
  }
}

// ============================================
// DEEPSEEK AI
// ============================================

async function analyzeIntent(userMessage, context) {
  if (!context) context = {};
  const contextStr = JSON.stringify(context, null, 2);

  const systemPrompt = [
    'Eres el asistente virtual de WhatsApp para "RickTech/Bemovil", recargas y pagos Ecuador.',
    'Analiza el mensaje y extrae datos en JSON.',
    '',
    'CONTEXTO ANTERIOR:',
    contextStr,
    '',
    'USA EL CONTEXTO. Si ya tiene un valor, NO LO PIDAS DE NUEVO.',
    'Combina datos nuevos con contexto.',
    'RESPUESTA: SOLO JSON. NADA MAS.',
    '',
    'OPERADORAS DE RECARGA (únicas válidas en bemovil): Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus.',
    'SERVICIOS DE PAGO: bemovil tiene CIENTOS de servicios (agua/luz por municipio, bancos, SRI, registros, transito, etc).',
    'NO restrinjas "service" a una lista fija: toma el nombre TAL CUAL lo escribe el usuario, usando el nombre MAS COMPLETO posible',
    '(ej. usuario dice "CNEL" -> pide que aclare cuál regional, ej. "CNEL Guayaquil"; "registro civil" -> usa "Registro Civil" completo, no abreviar "Reg. Civil").',
    'Si bemovil no encuentra el servicio exacto al procesarlo, el sistema avisará con un error pidiendo el nombre completo.',
    '',
    'JSON: {"intent":"topup"|"bill"|"unknown"|"greeting", "is_complete":bool, "reply_message":"texto", "topup_data":{"operator":"nombre|null","phone":"10dig|null","amount":"numero|null"}, "bill_data":{"service":"nombre|null","reference":"numero|null"}, "missing_fields":["campos"]}',
    '',
    'REGLAS: 1.Saludo=greeting 2.Recarga:operadora+telefono(10dig)+monto 3.Pago:servicio+ref 4.Si falta,is_complete=false 5.Completo(con contexto)=true 6.Tel:10dig sin +593 7.Monto:solo numeros 8."recargar" sin datos->pedir 3'
  ].join('\n');

  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.1,
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    let text = response.data?.choices?.[0]?.message?.content;
    if (!text) return null;
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('[DEEPSEEK] Error:', error?.response?.data || error.message);
    return null;
  }
}

// ============================================
// CONTEXTO (BD + Memoria)
// ============================================

async function getContext(remoteJid) {
  const dbCtx = await db.getConversation(remoteJid);
  if (dbCtx) {
    if (Date.now() - dbCtx.lastMessage < CONTEXT_TIMEOUT) return dbCtx.context;
    await db.deleteConversation(remoteJid).catch(() => {});
  }
  if (memoryConversations.has(remoteJid)) {
    const mem = memoryConversations.get(remoteJid);
    if (Date.now() - mem.lastMessage < CONTEXT_TIMEOUT) return mem.context;
    memoryConversations.delete(remoteJid);
  }
  return {};
}

async function saveContext(remoteJid, context) {
  await db.saveConversation(remoteJid, context).catch(() => {});
  memoryConversations.set(remoteJid, { context, lastMessage: Date.now() });
}

async function deleteContext(remoteJid) {
  await db.deleteConversation(remoteJid).catch(() => {});
  memoryConversations.delete(remoteJid);
}

// ============================================
// WEBHOOK
// ============================================

app.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });

  try {
    const extracted = extractMessage(req.body);
    if (!extracted) return;
    const { remoteJid, fromMe, text: message, timestamp } = extracted;
    if (fromMe) return;
    if (isStaleMessage(timestamp)) {
      console.log(`[WEBHOOK] Ignorado (mensaje viejo) ${remoteJid}: "${message}"`);
      return;
    }

    console.log(`[WEBHOOK] ${remoteJid}: "${message}"`);

    const authorized = await db.isAuthorized(remoteJid);
    if (!authorized) { console.log(`[SEGURIDAD] No autorizado: ${remoteJid}`); return; }

    const limit = await db.checkDailyLimit(remoteJid);
    if (!limit.allowed) {
      await sendWhatsAppMessage(remoteJid, `❌ Límite de ${limit.max} transacciones/día alcanzado.`);
      return;
    }

    const context = await getContext(remoteJid);

    // Si hay una acción de dinero real esperando confirmación, este mensaje
    // SOLO puede ser el PIN o una cancelación — no se vuelve a llamar a la IA.
    if (context.pendingConfirmation) {
      await handlePendingConfirmation(remoteJid, message.trim(), context);
      return;
    }

    const aiResponse = await analyzeIntent(message, context);
    if (!aiResponse) {
      await sendWhatsAppMessage(remoteJid, '⚠️ Error interno. Intenta de nuevo.');
      return;
    }

    console.log(`[AI] ${aiResponse.intent} | completo:${aiResponse.is_complete}`);

    if (aiResponse.intent === 'greeting') {
      await sendWhatsAppMessage(remoteJid, '👋 Hola! Soy el asistente de *RickTech/BeMovil*.\n\n📱 Recargas (Claro, Movistar, CNT, Tuenti)\n💡 Pagos (CNEL, CNT, Etapa, Agua Quito)\n\nEj: "Recarga $10 a Claro 0991234567"\n¿En qué te ayudo? 😊');
      return;
    }

    if (aiResponse.intent === 'unknown') {
      await sendWhatsAppMessage(remoteJid, '🤔 No entendí. Puedes pedir:\n📱 "Recarga $5 a Claro 0991234567"\n💡 "Paga CNEL cédula 1234567890"');
      return;
    }

    // Actualizar contexto
    const newContext = { ...context, intent: aiResponse.intent };
    if (aiResponse.topup_data) newContext.topup_data = { ...(newContext.topup_data || {}), ...aiResponse.topup_data };
    if (aiResponse.bill_data) newContext.bill_data = { ...(newContext.bill_data || {}), ...aiResponse.bill_data };
    await saveContext(remoteJid, newContext);

    await sendWhatsAppMessage(remoteJid, aiResponse.reply_message);

    if (!aiResponse.is_complete) return;

    if (aiResponse.intent === 'topup' && aiResponse.topup_data) {
      const { operator, phone, amount } = aiResponse.topup_data;
      // Las recargas no tienen un paso previo de "consultar monto": el monto
      // ya lo dio el usuario, así que pedimos el PIN directamente sobre eso.
      await requestPinConfirmation(remoteJid, {
        type: 'topup',
        data: { operator, phone, amount },
        summary: `📱 Recarga de *$${amount}* a *${operator}* (${phone})`
      });

    } else if (aiResponse.intent === 'bill' && aiResponse.bill_data) {
      const { service, reference } = aiResponse.bill_data;
      console.log(`[SCRAPER] Consultando ${service} Ref ${reference}`);
      await sendWhatsAppMessage(remoteJid, `⏳ Consultando *${service}*...`);

      const result = await scraper.payBill(service, reference);
      if (!result?.success) {
        await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Verifica datos.`);
        await db.saveTransaction({ type: 'bill', service, reference, remoteJid, status: 'error', error: result?.error }).catch(() => {});
        await deleteContext(remoteJid);
        return;
      }

      // La consulta encontró algo para pagar; el pago real solo se hace tras
      // confirmar con PIN (puede ser dinero de terceros, ej. factura de SRI).
      await requestPinConfirmation(remoteJid, {
        type: 'bill',
        data: { service, reference },
        summary: `📋 *${service}* (ref. ${reference})\n${(result.details || '').substring(0, 400)}`
      });
    }
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
  }
});

// ============================================
// CONFIRMACIÓN CON PIN (antes de mover dinero real)
// ============================================

const PAYMENT_PIN = process.env.PAYMENT_PIN || null;
if (!PAYMENT_PIN) {
  console.warn('[PIN] ⚠️  PAYMENT_PIN no está configurado: las recargas y pagos se ejecutarán SIN pedir confirmación.');
}

async function requestPinConfirmation(remoteJid, pending) {
  if (!PAYMENT_PIN) {
    // Sin PIN configurado, no hay forma de confirmar: ejecutar directo (comportamiento previo).
    await executeConfirmedAction(remoteJid, pending);
    return;
  }
  await saveContext(remoteJid, { pendingConfirmation: pending });
  await sendWhatsAppMessage(
    remoteJid,
    `${pending.summary}\n\n🔐 Responde con el *PIN* para confirmar y procesar el pago, o escribe *cancelar*.`
  );
}

async function handlePendingConfirmation(remoteJid, text, context) {
  const pending = context.pendingConfirmation;

  if (text.toLowerCase() === 'cancelar') {
    await sendWhatsAppMessage(remoteJid, '🚫 Operación cancelada.');
    await deleteContext(remoteJid);
    return;
  }

  if (text !== PAYMENT_PIN) {
    await sendWhatsAppMessage(remoteJid, '❌ PIN incorrecto. Responde con el PIN correcto o escribe *cancelar*.');
    return;
  }

  await executeConfirmedAction(remoteJid, pending);
  await deleteContext(remoteJid);
}

async function executeConfirmedAction(remoteJid, pending) {
  if (pending.type === 'topup') {
    const { operator, phone, amount } = pending.data;
    console.log(`[SCRAPER] Recarga confirmada ${operator} ${phone} $${amount}`);
    await sendWhatsAppMessage(remoteJid, `⏳ Procesando recarga de *$${amount}* a *${operator}*...`);
    await db.saveTransaction({ type: 'topup', operator, phone, amount, remoteJid, status: 'pending' }).catch(() => {});

    const result = await scraper.sellTopup(operator, phone, amount);
    if (result?.success) {
      await sendWhatsAppMessage(remoteJid, `✅ Recarga exitosa!\n📱 ${operator}\n📞 ${phone}\n💰 $${amount}\n\nGracias 😊`);
      await db.saveTransaction({ type: 'topup', operator, phone, amount, remoteJid, status: 'success' }).catch(() => {});
      await db.incrementDailyCount(remoteJid).catch(() => {});
    } else {
      await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Intenta de nuevo.`);
      await db.saveTransaction({ type: 'topup', operator, phone, amount, remoteJid, status: 'error', error: result?.error }).catch(() => {});
    }

  } else if (pending.type === 'bill') {
    const { service, reference } = pending.data;
    console.log(`[SCRAPER] Pago confirmado ${service} Ref ${reference}`);
    await sendWhatsAppMessage(remoteJid, `⏳ Procesando pago de *${service}*...`);
    await db.saveTransaction({ type: 'bill', service, reference, remoteJid, status: 'pending' }).catch(() => {});

    const result = await scraper.payBill(service, reference, { confirm: true });
    if (result?.success) {
      await sendWhatsAppMessage(remoteJid, `✅ Pago realizado!\n📋 ${service}\n🔢 ${reference}\n\nGracias 😊`);
      await sendImageMessage(remoteJid, path.join(__dirname, 'recaudo_resultado.png'), `Resultado ${service}`).catch(() => {});
      await db.saveTransaction({ type: 'bill', service, reference, remoteJid, status: 'success' }).catch(() => {});
      await db.incrementDailyCount(remoteJid).catch(() => {});
    } else {
      await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Verifica datos.`);
      await db.saveTransaction({ type: 'bill', service, reference, remoteJid, status: 'error', error: result?.error }).catch(() => {});
    }
  }
}

// ============================================
// HEALTH
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    conversations_active: memoryConversations.size,
    deepseek: DEEPSEEK_API_KEY ? 'ok' : 'missing',
    evolution: EVOLUTION_API_TOKEN ? 'ok' : 'missing'
  });
});

// ============================================
// STATS JSON
// ============================================

app.get('/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    stats.conversations_active = memoryConversations.size;
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DASHBOARD HTML
// ============================================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ============================================
// START
// ============================================

async function start() {
  await db.initDatabase();

  app.listen(PORT, () => {
    console.log('');
    console.log('===============================================');
    console.log('    RICKTECH/BEMOVIL WHATSAPP BOT');
    console.log('===============================================');
    console.log(`  Puerto:        ${PORT}`);
    console.log('  Webhook:       /webhook');
    console.log('  Health:        /health');
    console.log('  Stats:         /stats (JSON)');
    console.log('  Dashboard:     /dashboard (HTML)');
    console.log(`  Evolution API: ${EVOLUTION_API_URL}`);
    console.log(`  DeepSeek API:  ${DEEPSEEK_API_KEY ? 'OK' : 'FALTA KEY'}`);
    console.log('===============================================');
    console.log('');
    console.log('  🧠 IA: DeepSeek Chat');
    console.log('  🗄️  BD: MySQL (fallback memoria)');
    console.log('  📊 Dashboard: http://localhost:' + PORT + '/dashboard');
    console.log('  📡 Esperando mensajes de WhatsApp...');
    console.log('');
  });
}

start();
