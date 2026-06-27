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
  // El historial real de la conversación (lo que se dijo, no solo los datos
  // ya extraídos) se manda como turnos de chat de verdad más abajo — aquí
  // solo describimos el ESTADO estructurado actual (sin el historial, que
  // ya va aparte, para no duplicarlo ni inflar el prompt).
  const { history, ...structuredState } = context;
  const contextStr = JSON.stringify(structuredState, null, 2);

  const systemPrompt = [
    'Eres el asistente virtual de WhatsApp de "RickTech/Bemovil" (recargas y pagos en Ecuador). Conversas de forma natural, no eres un formulario.',
    'Tienes disponible el HISTORIAL REAL de los últimos mensajes de esta conversación (como turnos de chat) — úsalo para entender de qué se está hablando, igual que lo haría una persona leyendo el chat completo.',
    '',
    'ESTADO YA EXTRAÍDO DE ESTA CONVERSACIÓN (datos confirmados hasta ahora):',
    contextStr,
    '',
    'REGLA CLAVE DE CONTINUIDAD: si el estado ya tiene un pedido en curso (por ejemplo bill_data.service ya definido, o topup_data con algunos campos) y el último mensaje del usuario es corto, ambiguo, o no parece un saludo real ni una pregunta nueva, NO clasifiques como "greeting" ni "unknown" solo porque el texto es breve — primero revisa si ese mensaje completa razonablemente el dato que falta (ej. un número o nombre corto después de pedir la referencia). Solo usa "unknown" cuando de verdad no se entiende qué quiere el usuario NI tiene sentido como continuación de lo que estaba pendiente.',
    'Combina los datos nuevos del mensaje con el estado ya extraído (no pidas de nuevo lo que ya está confirmado).',
    'RESPONDE SOLO JSON, nada de texto fuera del JSON.',
    '',
    'OPERADORAS DE RECARGA (únicas válidas en bemovil): Claro, Movistar, Tuenti, CNT, Akimovil, Maxiplus.',
    'SERVICIOS DE PAGO ("bill"): bemovil tiene cientos (agua/luz por municipio, bancos, SRI, registros, tránsito, etc).',
    'No restrinjas "service" a una lista fija: usa el nombre tal cual lo escribe el usuario, en su forma MÁS COMPLETA posible',
    '(ej. "CNEL" -> pregunta cuál regional, "CNEL Guayaquil"; "registro civil" -> usa "Registro Civil" completo, no "Reg. Civil").',
    'IMPORTANTE: si el usuario dice un servicio GENÉRICO sin especificar la empresa/ciudad (ej. solo "agua" o "luz"), NO pongas',
    'bill_data.service todavía — déjalo null y pregunta de qué empresa/ciudad es. Solo llena bill_data.service cuando ya sea un',
    'nombre específico y completo (ej. "Agua Ibarra", "CNEL Guayaquil"). Si el siguiente mensaje del usuario es solo el nombre de',
    'una ciudad/empresa (sin referencia todavía), eso es para COMPLETAR bill_data.service (ej. "agua" + "Ibarra" -> "Agua Ibarra"),',
    'NO uses ese mensaje como bill_data.reference.',
    'Si bemovil no encuentra el servicio exacto al procesarlo, el sistema avisará pidiendo el nombre completo — no es tu responsabilidad validarlo de antemano.',
    '',
    'IMPORTANTE: "bill" es SOLO para servicios de UNA sola referencia a consultar (agua, luz, telefonía, SRI, registro civil, tránsito, cobranza bancaria).',
    'Para CUALQUIER OTRA cosa que bemovil venda (Netflix/Disney+/HBO y otras cuentas streaming, paquetes de datos, pines de juegos como Free Fire,',
    'apuestas/pronósticos como Bet593, lotería, depósitos bancarios, retiros, paquetes internacionales) usa intent "order" con',
    'order_data:{"product_query":"nombre lo más completo posible","category":"Tv Digital"|"Paquetes"|"Entretenimiento"|"Depositos"|"Pronosticos"|"Loteria"|"Retiros"|"Internacionales"|null}.',
    'Para "order" NO pidas todavía teléfono, correo ni monto — el sistema descubre qué pedir y lo pregunta después. Solo extrae el nombre del producto.',
    '',
    'JSON: {"intent":"topup"|"bill"|"order"|"unknown"|"greeting", "is_complete":bool, "reply_message":"texto natural y breve", "topup_data":{"operator":"nombre|null","phone":"10dig|null","amount":"numero|null"}, "bill_data":{"service":"nombre|null","reference":"numero|null"}, "order_data":{"product_query":"nombre|null","category":"nombre|null"}, "missing_fields":["campos"]}',
    '',
    'Reglas rápidas: saludo real (sin ningún pedido en curso) = greeting. Recarga necesita operadora+teléfono(10 dígitos)+monto. Pago de servicio necesita servicio+referencia. Cualquier otro producto = order (solo el nombre). Si falta algo, is_complete=false. Teléfono: 10 dígitos sin +593. Monto: solo números.'
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: userMessage }
  ];

  return callDeepSeekMessages(messages);
}

// Mantiene los últimos turnos REALES de la conversación (lo que se dijo, no
// solo los datos extraídos) para que la IA tenga memoria conversacional de
// verdad en el siguiente turno, en vez de re-interpretar cada mensaje aislado.
const MAX_HISTORY_TURNS = 12;
function pushHistory(context, role, content) {
  const history = [...(context.history || []), { role, content }];
  return history.slice(-MAX_HISTORY_TURNS);
}

// Helper de conveniencia: agrega el turno del usuario y la respuesta del
// bot al historial de una sola vez, para no repetir el doble pushHistory
// en cada punto del webhook donde se responde algo.
function withHistory(context, userMessage, assistantReply) {
  const afterUser = pushHistory(context, 'user', userMessage);
  return pushHistory({ history: afterUser }, 'assistant', assistantReply || '');
}

async function callDeepSeek(systemPrompt, userMessage) {
  return callDeepSeekMessages([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]);
}

async function callDeepSeekMessages(messages) {
  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages,
      temperature: 0.1,
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    let text = response.data?.choices?.[0]?.message?.content;
    if (!text) return null;
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(text);
    } catch (parseError) {
      // A pesar de la instrucción "SOLO JSON", DeepSeek a veces antepone
      // texto conversacional (ej. "Perfecto, ...") antes del JSON real —
      // confirmado en producción, tumbaba toda la respuesta con "Error
      // interno" en vez de degradar con gracia. Como último intento,
      // extraemos el primer objeto/array JSON dentro del texto.
      const match = text.match(/[{[][\s\S]*[}\]]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (e) {}
      }
      console.error('[DEEPSEEK] Respuesta no es JSON valido:', text.substring(0, 200));
      return null;
    }
  } catch (error) {
    console.error('[DEEPSEEK] Error:', error?.response?.data || error.message);
    return null;
  }
}

// ============================================
// IA PARA PEDIDOS GENERICOS ("order") — prompts dinamicos construidos a
// partir de lo que processOrder() descubrio en vivo en bemovil (planes
// reales, labels reales de los campos), no de una lista fija.
// ============================================

async function analyzeTierChoice(productQuery, tierOptions, userMessage) {
  const systemPrompt = [
    `El cliente quiere "${productQuery}" y debe elegir UNA de estas opciones reales de bemovil:`,
    tierOptions.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '',
    'Identifica cuál eligió (puede mencionar el precio, el nombre o el número de la lista).',
    'RESPONDE SOLO JSON: {"tierChoice": "<copia EXACTA de la opción elegida, tal cual aparece arriba>"|null, "reply_message": "texto"}',
    'Si no quedó claro cuál eligió, tierChoice debe ser null y reply_message debe volver a mostrar las opciones.'
  ].join('\n');
  return callDeepSeek(systemPrompt, userMessage);
}

async function analyzeOrderFields(productQuery, requiredFields, knownSoFar, userMessage) {
  const systemPrompt = [
    `Estás ayudando a completar un pedido de "${productQuery}" en WhatsApp.`,
    `El sistema pide EXACTAMENTE estos campos (usa estos nombres tal cual, son los labels reales de bemovil): ${requiredFields.join(', ')}.`,
    `Ya se conoce: ${JSON.stringify(knownSoFar)}`,
    'Extrae del mensaje del usuario los valores para los campos que falten. Usa EXACTAMENTE esos nombres de campo como claves del objeto "fields".',
    'No inventes valores ni pidas datos que no estén en la lista de campos.',
    'RESPONDE SOLO JSON: {"fields": {"<nombre campo>": "valor"|null}, "reply_message": "texto pidiendo lo que falte, usando los nombres de campo reales"}'
  ].join('\n');
  return callDeepSeek(systemPrompt, userMessage);
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

// La IA a veces "olvida" datos ya conocidos y los devuelve en null en el
// mismo turno (confirmado en pruebas reales) — un merge ingenuo
// {...viejo, ...nuevo} borraría el dato bueno con ese null. Por eso solo
// sobreescribimos con valores no vacíos.
function mergeNonEmpty(base, incoming) {
  const merged = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v !== null && v !== undefined && v !== '') merged[k] = v;
  }
  return merged;
}

async function deleteContext(remoteJid) {
  await db.deleteConversation(remoteJid).catch(() => {});
  memoryConversations.delete(remoteJid);
}

// ============================================
// WEBHOOK
// ============================================

// Resuelve el nombre de servicio que dio el cliente/la IA contra el nombre
// EXACTO que usa bemovil, buscando en vivo (ver scraper.findBillService) en
// vez de asumir que el texto extraído ya es correcto — el buscador de
// bemovil es literal y tiene cientos de variantes regionales que ni el
// cliente ni la IA conocen de antemano.
async function resolveAndContinueBill(remoteJid, context, billData, message) {
  const query = billData.service;
  console.log(`[BILL] Resolviendo servicio "${query}" contra bemovil...`);
  const result = await scraper.findBillService(query);

  if (!result.success) {
    await sendWhatsAppMessage(remoteJid, `❌ ${result.error}`);
    await deleteContext(remoteJid);
    return;
  }

  if (result.candidates.length === 1) {
    const service = result.candidates[0];
    if (billData.reference) {
      const history = withHistory(context, message, `⏳ Consultando *${service}*...`);
      await saveContext(remoteJid, { intent: 'bill', bill_data: { service, serviceConfirmed: true, reference: billData.reference }, history });
      await runBillQuery(remoteJid, service, billData.reference, history);
    } else {
      const reply = `Perfecto, *${service}*. ¿Cuál es tu número de referencia (código de cliente o medidor)?`;
      const history = withHistory(context, message, reply);
      await saveContext(remoteJid, { intent: 'bill', bill_data: { service, serviceConfirmed: true }, history });
      await sendWhatsAppMessage(remoteJid, reply);
    }
    return;
  }

  // Varias coincidencias reales — preguntarle al cliente cuál es, en vez de
  // adivinar (mismo patrón que ya usa processOrder para elegir plan/tier).
  const reply = `Encontré varias coincidencias para *${query}*:\n\n${result.candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n¿Cuál es? (responde el número o el nombre, o escribe *cancelar*)`;
  const history = withHistory(context, message, reply);
  await saveContext(remoteJid, { pendingBillChoice: { candidates: result.candidates, reference: billData.reference || null }, history });
  await sendWhatsAppMessage(remoteJid, reply);
}

async function handlePendingBillChoice(remoteJid, text, context) {
  const pending = context.pendingBillChoice;

  if (text.toLowerCase() === 'cancelar') {
    await sendWhatsAppMessage(remoteJid, '🚫 Pedido cancelado.');
    await deleteContext(remoteJid);
    return;
  }

  const aiResponse = await analyzeTierChoice('el servicio que quieres pagar', pending.candidates, text);
  if (!aiResponse?.tierChoice) {
    const reply = aiResponse?.reply_message || '¿Cuál de esas opciones es? Responde el número o el nombre, o escribe *cancelar*.';
    await saveContext(remoteJid, { pendingBillChoice: pending, history: withHistory(context, text, reply) });
    await sendWhatsAppMessage(remoteJid, reply);
    return;
  }

  const service = aiResponse.tierChoice;
  if (pending.reference) {
    const history = withHistory(context, text, `⏳ Consultando *${service}*...`);
    await saveContext(remoteJid, { intent: 'bill', bill_data: { service, serviceConfirmed: true, reference: pending.reference }, history });
    await runBillQuery(remoteJid, service, pending.reference, history);
  } else {
    const reply = `Perfecto, *${service}*. ¿Cuál es tu número de referencia (código de cliente o medidor)?`;
    const history = withHistory(context, text, reply);
    await saveContext(remoteJid, { intent: 'bill', bill_data: { service, serviceConfirmed: true }, history });
    await sendWhatsAppMessage(remoteJid, reply);
  }
}

async function runBillQuery(remoteJid, service, reference, history) {
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
  await requestAdminConfirmation(remoteJid, {
    type: 'bill',
    data: { service, reference },
    summary: `📋 *${service}* (ref. ${reference})\n${(result.details || '').substring(0, 400)}`
  }, history);
}

app.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });

  let remoteJid;
  try {
    const extracted = extractMessage(req.body);
    if (!extracted) return;
    const { fromMe, text: message, timestamp } = extracted;
    remoteJid = extracted.remoteJid;
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

    // Si hay un pedido genérico ("order") a medio completar (elegir plan o
    // dar los campos que bemovil pide), este mensaje sigue ese flujo en vez
    // de re-clasificar la intención desde cero.
    if (context.pendingOrder) {
      await handlePendingOrder(remoteJid, message.trim(), context);
      return;
    }

    // Si bemovil tenía varios servicios parecidos al que el cliente pidió
    // (ver resolveAndContinueBill), este mensaje es la elección entre ellos.
    if (context.pendingBillChoice) {
      await handlePendingBillChoice(remoteJid, message.trim(), context);
      return;
    }

    // Si ya estábamos a medio "bill" (con servicio elegido, solo faltaba la
    // referencia) y el mensaje es un texto corto sin espacios CON AL MENOS
    // UN DÍGITO (cédula/cuenta/medidor real), lo tratamos como la referencia
    // directamente en vez de volver a preguntarle a la IA — DeepSeek a veces
    // clasifica un numero suelto como intent "unknown" en vez de reconocerlo
    // como dato pendiente del contexto, lo cual reinicia la conversación sin
    // avisar. Exigir un dígito evita el caso real donde el usuario respondía
    // con el nombre de una ciudad (ej. "Ibarra") para ACLARAR el servicio
    // ("Agua" -> "Agua Ibarra"), no para dar una referencia — un nombre de
    // ciudad nunca es una referencia real de bemovil.
    const looksLikeReference = /^(?=.*[0-9])[A-Za-z0-9-]{3,20}$/.test(message.trim());
    if (context.intent === 'bill' && context.bill_data?.serviceConfirmed && !context.bill_data?.reference && looksLikeReference) {
      const newContext = {
        ...context,
        bill_data: { ...context.bill_data, reference: message.trim() },
        history: withHistory(context, message, `Referencia recibida: ${message.trim()}`)
      };
      await saveContext(remoteJid, newContext);
      await runBillQuery(remoteJid, newContext.bill_data.service, newContext.bill_data.reference, newContext.history);
      return;
    }

    const aiResponse = await analyzeIntent(message, context);
    if (!aiResponse) {
      await sendWhatsAppMessage(remoteJid, '⚠️ Error interno. Intenta de nuevo.');
      return;
    }

    console.log(`[AI] ${aiResponse.intent} | completo:${aiResponse.is_complete}`);

    // Si la IA clasificó como saludo/desconocido pero en realidad ya había
    // un pedido a medias (bill con servicio sin referencia, o topup con
    // algún dato suelto), no lo tratamos como un reinicio de conversación
    // — le recordamos puntualmente qué falta en vez del mensaje genérico.
    const hasPendingBill = !!(context.bill_data?.serviceConfirmed && !context.bill_data?.reference);
    const topupPartial = context.topup_data && (context.topup_data.operator || context.topup_data.phone || context.topup_data.amount);
    const hasPendingTopup = !!(topupPartial && !(context.topup_data.operator && context.topup_data.phone && context.topup_data.amount));

    if ((aiResponse.intent === 'greeting' || aiResponse.intent === 'unknown') && (hasPendingBill || hasPendingTopup)) {
      const reply = hasPendingBill
        ? `Sigues con la consulta de *${context.bill_data.service}* — solo me falta la referencia/cédula/contrato. ¿La tienes, o prefieres *cancelar*?`
        : `Sigues con tu recarga${context.topup_data.operator ? ` a *${context.topup_data.operator}*` : ''} — me falta ${[!context.topup_data.operator && 'la operadora', !context.topup_data.phone && 'el número', !context.topup_data.amount && 'el monto'].filter(Boolean).join(' y ')}. ¿Lo tienes, o prefieres *cancelar*?`;
      await saveContext(remoteJid, { ...context, history: withHistory(context, message, reply) });
      await sendWhatsAppMessage(remoteJid, reply);
      return;
    }

    if (aiResponse.intent === 'greeting') {
      const reply = '👋 Hola! Soy el asistente de *RickTech/BeMovil*.\n\n📱 Recargas (Claro, Movistar, CNT, Tuenti)\n💡 Pagos (CNEL, CNT, Etapa, Agua Quito)\n\nEj: "Recarga $10 a Claro 0991234567"\n¿En qué te ayudo? 😊';
      await saveContext(remoteJid, { ...context, history: withHistory(context, message, reply) });
      await sendWhatsAppMessage(remoteJid, reply);
      return;
    }

    if (aiResponse.intent === 'unknown') {
      const reply = '🤔 No entendí. Puedes pedir:\n📱 "Recarga $5 a Claro 0991234567"\n💡 "Paga CNEL cédula 1234567890"';
      await saveContext(remoteJid, { ...context, history: withHistory(context, message, reply) });
      await sendWhatsAppMessage(remoteJid, reply);
      return;
    }

    if (aiResponse.intent === 'order') {
      const productQuery = aiResponse.order_data?.product_query;
      const history = withHistory(context, message, aiResponse.reply_message || '');
      if (!productQuery) {
        const reply = aiResponse.reply_message || '¿Qué producto deseas?';
        await saveContext(remoteJid, { ...context, history });
        await sendWhatsAppMessage(remoteJid, reply);
        return;
      }
      await startOrder(remoteJid, productQuery, aiResponse.order_data?.category || null, history);
      return;
    }

    // Actualizar contexto.
    const newContext = { ...context, intent: aiResponse.intent };
    if (aiResponse.topup_data) newContext.topup_data = mergeNonEmpty(newContext.topup_data, aiResponse.topup_data);
    if (aiResponse.bill_data) {
      const merged = mergeNonEmpty(newContext.bill_data, aiResponse.bill_data);
      // Si el servicio cambió de valor respecto al ya confirmado (el usuario
      // se corrigió o cambió de idea), hay que volver a resolverlo contra
      // bemovil — no heredar el "ya confirmado" del servicio anterior.
      if (aiResponse.bill_data.service && aiResponse.bill_data.service !== context.bill_data?.service) {
        merged.serviceConfirmed = false;
      }
      newContext.bill_data = merged;
    }

    // El buscador de bemovil es literal: ni el cliente ni la IA conocen el
    // nombre EXACTO del servicio (ej. "agua ibarra" vs el real "AGUA EMAPA -
    // IBARRA"). Antes de pedir la referencia, resolvemos el nombre en vivo
    // contra bemovil (ver resolveAndContinueBill) en vez de asumir que el
    // texto extraído ya es correcto.
    if (aiResponse.intent === 'bill' && newContext.bill_data?.service && !newContext.bill_data?.serviceConfirmed) {
      await resolveAndContinueBill(remoteJid, context, newContext.bill_data, message);
      return;
    }

    newContext.history = withHistory(context, message, aiResponse.reply_message || '');
    await saveContext(remoteJid, newContext);

    // No confiamos solo en el "is_complete" que devuelve la IA (puede decir
    // que falta un dato que en realidad ya teníamos en contexto, por el bug
    // de arriba) — lo calculamos nosotros mismos a partir del contexto ya
    // fusionado, que es la fuente de verdad real.
    const topupReady = aiResponse.intent === 'topup' &&
      !!(newContext.topup_data?.operator && newContext.topup_data?.phone && newContext.topup_data?.amount);
    const billReady = aiResponse.intent === 'bill' &&
      !!(newContext.bill_data?.serviceConfirmed && newContext.bill_data?.reference);

    if (!topupReady && !billReady) {
      await sendWhatsAppMessage(remoteJid, aiResponse.reply_message);
      return;
    }

    if (topupReady) {
      const { operator, phone, amount } = newContext.topup_data;
      // Las recargas no tienen un paso previo de "consultar monto": el monto
      // ya lo dio el usuario, así que pedimos el PIN directamente sobre eso.
      await requestAdminConfirmation(remoteJid, {
        type: 'topup',
        data: { operator, phone, amount },
        summary: `📱 Recarga de *$${amount}* a *${operator}* (${phone})`
      }, newContext.history);

    } else if (billReady) {
      await runBillQuery(remoteJid, newContext.bill_data.service, newContext.bill_data.reference, newContext.history);
    }
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    if (remoteJid) {
      await sendWhatsAppMessage(remoteJid, '❌ Tuve un error técnico procesando tu pedido. Por favor intenta de nuevo desde el inicio.').catch(() => {});
      await deleteContext(remoteJid).catch(() => {});
    }
  }
});

// ============================================
// CONFIRMACIÓN POR CÓDIGO (pago en efectivo/transferencia al administrador)
// ============================================
//
// El cliente NUNCA conoce el código de antemano. Flujo real:
//   1. El bot junta los datos (recarga o servicio) y genera un código de
//      4 dígitos NUEVO para ese pedido (uno distinto cada vez).
//   2. El código se envía SOLO al administrador (ADMIN_NUMBERS), junto con
//      el número del cliente y el detalle del pedido.
//   3. El cliente paga en efectivo o por transferencia directamente al
//      administrador (fuera del bot).
//   4. El administrador, ya con el pago en mano, le dicta el código al
//      cliente.
//   5. El cliente responde ese código por WhatsApp y AHÍ se ejecuta la
//      recarga/pago real en bemovil.

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

if (ADMIN_NUMBERS.length === 0) {
  console.warn('[ADMIN] ⚠️  ADMIN_NUMBERS no está configurado: no hay forma de confirmar pagos, los pedidos quedarán pendientes para siempre.');
}

function generateConfirmationCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

async function notifyAdmins(text) {
  for (const phone of ADMIN_NUMBERS) {
    await sendWhatsAppMessage(`${phone}@s.whatsapp.net`, text);
  }
}

async function requestAdminConfirmation(remoteJid, pending, history) {
  if (ADMIN_NUMBERS.length === 0) {
    await sendWhatsAppMessage(remoteJid, '⚠️ El sistema de pagos no está disponible en este momento. Intenta más tarde.');
    await deleteContext(remoteJid);
    return;
  }

  const code = generateConfirmationCode();
  await saveContext(remoteJid, { pendingConfirmation: { ...pending, code }, history: history || [] });

  const customerPhone = remoteJid.split('@')[0];
  await notifyAdmins(
    `🆕 Nuevo pedido de *${customerPhone}*\n${pending.summary}\n\n🔐 Código de confirmación: *${code}*\n\nEntrégaselo al cliente SOLO cuando confirmes que pagó (efectivo o transferencia).`
  );

  await sendWhatsAppMessage(
    remoteJid,
    `${pending.summary}\n\n💰 Para confirmar, realiza el pago en efectivo o por transferencia con nuestro administrador. Te dará un *código* — respóndelo aquí para procesar tu pedido, o escribe *cancelar*.`
  );
}

async function handlePendingConfirmation(remoteJid, text, context) {
  const pending = context.pendingConfirmation;

  if (text.toLowerCase() === 'cancelar') {
    await sendWhatsAppMessage(remoteJid, '🚫 Pedido cancelado.');
    await deleteContext(remoteJid);
    return;
  }

  if (text !== pending.code) {
    await sendWhatsAppMessage(remoteJid, '❌ Código incorrecto. Pide el código correcto a nuestro administrador, o escribe *cancelar*.');
    return;
  }

  await executeConfirmedAction(remoteJid, pending);
  await deleteContext(remoteJid);
}

// ============================================
// PEDIDOS GENÉRICOS ("order") — cualquier categoría que sellTopup/payBill
// no cubren. processOrder() descubre en vivo qué pedir (plan/tiers y
// campos reales), así que la conversación se adapta dinámicamente en vez
// de seguir un guion fijo por categoría.
// ============================================

async function startOrder(remoteJid, productQuery, category, history) {
  console.log(`[ORDER] Inspeccionando "${productQuery}"...`);
  const result = await scraper.processOrder(productQuery, { categoryHint: category, dryRun: true });

  if (!result.success && result.needsTierChoice) {
    await saveContext(remoteJid, {
      pendingOrder: { stage: 'need_tier', productQuery, category, tierOptions: result.tierOptions },
      history
    });
    await sendWhatsAppMessage(
      remoteJid,
      `Para *${productQuery}* hay varias opciones:\n\n${result.tierOptions.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n¿Cuál deseas? (responde el número, nombre o precio, o escribe *cancelar*)`
    );
    return;
  }

  if (!result.success) {
    await sendWhatsAppMessage(remoteJid, `❌ ${result.error || 'No encontré ese producto.'}`);
    return;
  }

  // dryRun exitoso: ya sabemos los campos reales que bemovil pide.
  await saveContext(remoteJid, {
    pendingOrder: {
      stage: 'need_fields',
      productQuery, category,
      requiredFields: result.requiredFields,
      fields: {}
    },
    history
  });
  await sendWhatsAppMessage(
    remoteJid,
    `Para *${productQuery}* necesito: ${result.requiredFields.join(', ')}.\n\nEnvíalos en tu próximo mensaje, o escribe *cancelar*.`
  );
}

async function handlePendingOrder(remoteJid, text, context) {
  const pending = context.pendingOrder;

  if (text.toLowerCase() === 'cancelar') {
    await sendWhatsAppMessage(remoteJid, '🚫 Pedido cancelado.');
    await deleteContext(remoteJid);
    return;
  }

  if (pending.stage === 'need_tier') {
    const aiResponse = await analyzeTierChoice(pending.productQuery, pending.tierOptions, text);
    if (!aiResponse?.tierChoice) {
      const reply = aiResponse?.reply_message || '¿Cuál opción eliges? Responde el número, nombre o precio.';
      await saveContext(remoteJid, { pendingOrder: pending, history: withHistory(context, text, reply) });
      await sendWhatsAppMessage(remoteJid, reply);
      return;
    }

    // Segunda inspección, ahora con el plan elegido, para descubrir los
    // campos que aparecen DESPUÉS de elegir (suelen ser los mismos para
    // cualquier plan del mismo producto, pero los descubrimos en vivo igual).
    const result = await scraper.processOrder(pending.productQuery, {
      categoryHint: pending.category,
      tierChoice: aiResponse.tierChoice,
      dryRun: true
    });

    if (!result.success) {
      await sendWhatsAppMessage(remoteJid, `❌ ${result.error || 'No pude continuar con esa opción.'}`);
      return;
    }

    const reply = `✅ ${aiResponse.tierChoice}\n\nAhora necesito: ${result.requiredFields.join(', ')}.\n\nEnvíalos en tu próximo mensaje, o escribe *cancelar*.`;
    await saveContext(remoteJid, {
      pendingOrder: {
        stage: 'need_fields',
        productQuery: pending.productQuery, category: pending.category,
        tierChoice: aiResponse.tierChoice,
        requiredFields: result.requiredFields,
        fields: {}
      },
      history: withHistory(context, text, reply)
    });
    await sendWhatsAppMessage(remoteJid, reply);
    return;
  }

  if (pending.stage === 'need_fields') {
    const aiResponse = await analyzeOrderFields(pending.productQuery, pending.requiredFields, pending.fields, text);
    if (!aiResponse) {
      await sendWhatsAppMessage(remoteJid, '⚠️ Error interno. Intenta de nuevo.');
      return;
    }

    const mergedFields = mergeNonEmpty(pending.fields, aiResponse.fields);
    const stillMissing = pending.requiredFields.filter(label => !mergedFields[label]);

    if (stillMissing.length > 0) {
      const reply = aiResponse.reply_message || `Todavía falta: ${stillMissing.join(', ')}.`;
      await saveContext(remoteJid, { pendingOrder: { ...pending, fields: mergedFields }, history: withHistory(context, text, reply) });
      await sendWhatsAppMessage(remoteJid, reply);
      return;
    }

    // Todos los campos están — llenar de verdad en bemovil y detenerse
    // justo antes de cobrar (processOrder con confirm:false).
    console.log(`[ORDER] Completando datos de "${pending.productQuery}"...`);
    const result = await scraper.processOrder(pending.productQuery, {
      categoryHint: pending.category,
      tierChoice: pending.tierChoice,
      fields: mergedFields,
      confirm: false
    });

    if (!result.success) {
      await sendWhatsAppMessage(remoteJid, `❌ ${result.error || 'No pude procesar el pedido.'}`);
      await deleteContext(remoteJid);
      return;
    }

    if (!result.pendingConfirm) {
      // No había nada que confirmar (ej. un botón de solo-consulta como
      // Lotería) — ya se ejecutó, no hay pago real pendiente.
      await sendWhatsAppMessage(remoteJid, `✅ Listo!\n${(result.details || '').substring(0, 400)}`);
      await deleteContext(remoteJid);
      return;
    }

    await requestAdminConfirmation(remoteJid, {
      type: 'order',
      data: { productQuery: pending.productQuery, category: pending.category, tierChoice: pending.tierChoice, fields: mergedFields },
      summary: result.details
    }, withHistory(context, text, result.details || ''));
  }
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
      await notifyAdmins(`✅ Pedido de ${remoteJid.split('@')[0]} completado: recarga $${amount} a ${operator} (${phone}).`);
    } else {
      await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Intenta de nuevo.`);
      await db.saveTransaction({ type: 'topup', operator, phone, amount, remoteJid, status: 'error', error: result?.error }).catch(() => {});
      await notifyAdmins(`❌ Pedido de ${remoteJid.split('@')[0]} FALLÓ (ya cobraste?): recarga $${amount} a ${operator} (${phone}).\nError: ${result?.error || 'desconocido'}`);
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
      await notifyAdmins(`✅ Pedido de ${remoteJid.split('@')[0]} completado: pago ${service} (ref. ${reference}).`);
    } else {
      await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Verifica datos.`);
      await db.saveTransaction({ type: 'bill', service, reference, remoteJid, status: 'error', error: result?.error }).catch(() => {});
      await notifyAdmins(`❌ Pedido de ${remoteJid.split('@')[0]} FALLÓ (ya cobraste?): pago ${service} (ref. ${reference}).\nError: ${result?.error || 'desconocido'}`);
    }

  } else if (pending.type === 'order') {
    const { productQuery, category, tierChoice, fields } = pending.data;
    console.log(`[SCRAPER] Pedido confirmado ${productQuery}${tierChoice ? ` (${tierChoice})` : ''}`);
    await sendWhatsAppMessage(remoteJid, `⏳ Procesando *${productQuery}*...`);
    await db.saveTransaction({ type: 'order', service: productQuery, reference: tierChoice || null, remoteJid, status: 'pending' }).catch(() => {});

    const result = await scraper.processOrder(productQuery, { categoryHint: category, tierChoice, fields, confirm: true });
    if (result?.success) {
      await sendWhatsAppMessage(remoteJid, `✅ Pedido realizado!\n📋 ${productQuery}${tierChoice ? `\n${tierChoice}` : ''}\n\nGracias 😊`);
      await db.saveTransaction({ type: 'order', service: productQuery, reference: tierChoice || null, remoteJid, status: 'success' }).catch(() => {});
      await db.incrementDailyCount(remoteJid).catch(() => {});
      await notifyAdmins(`✅ Pedido de ${remoteJid.split('@')[0]} completado: ${productQuery}${tierChoice ? ` (${tierChoice})` : ''}.`);
    } else {
      await sendWhatsAppMessage(remoteJid, `❌ Error: ${result?.error || 'desconocido'}. Verifica datos.`);
      await db.saveTransaction({ type: 'order', service: productQuery, reference: tierChoice || null, remoteJid, status: 'error', error: result?.error }).catch(() => {});
      await notifyAdmins(`❌ Pedido de ${remoteJid.split('@')[0]} FALLÓ (ya cobraste?): ${productQuery}${tierChoice ? ` (${tierChoice})` : ''}.\nError: ${result?.error || 'desconocido'}`);
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
