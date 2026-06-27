// ============================================
// db.js - Conexión a MySQL
// ============================================
const mysql = require('mysql2/promise');

let pool = null;

async function getPool() {
  if (pool) return pool;

  const DB_ENABLED = process.env.DB_ENABLED !== 'false';

  if (!DB_ENABLED) {
    console.log('[DB] Base de datos deshabilitada. Usando modo memoria.');
    return null;
  }

  try {
    // Auto-detectar si estamos en Docker o local
    const fs = require('fs');
    const inDocker = fs.existsSync('/.dockerenv');
    const dbHost = process.env.DB_HOST || (inDocker ? 'mysql' : '127.0.0.1');

    pool = mysql.createPool({
      host: dbHost,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'ricktech_user',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'ricktech',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000
    });

    // Probar conexión
    const conn = await pool.getConnection();
    console.log('[DB] Conectado a MySQL exitosamente');
    conn.release();
    return pool;
  } catch (err) {
    console.log('[DB] No se pudo conectar a MySQL:', err.message);
    console.log('[DB] Usando modo memoria como fallback.');
    pool = null;
    return null;
  }
}

// ============================================
// Función helper para consultas
// ============================================
async function query(sql, params) {
  const p = await getPool();
  if (!p) return null;
  try {
    const [rows] = await p.execute(sql, params);
    return rows;
  } catch (err) {
    console.error('[DB] Error en query:', err.message);
    return null;
  }
}

// ============================================
// Conversaciones
// ============================================
async function getConversation(remoteJid) {
  const rows = await query(
    'SELECT context, last_message FROM conversations WHERE remote_jid = ?',
    [remoteJid]
  );
  if (rows && rows.length > 0) {
    // La columna "context" es de tipo JSON en MySQL: mysql2 la devuelve ya
    // parseada como objeto/array, no como string. Si en algún momento
    // llegara como string (otro driver, columna TEXT en una BD vieja),
    // igual la parseamos. Antes esto SIEMPRE intentaba JSON.parse() sobre
    // un objeto ya parseado, lo cual lanza una excepción silenciosa
    // (catch vacío) y reseteaba el contexto a {} en cada lectura — el bot
    // "olvidaba" todo entre turnos aunque el guardado funcionara bien.
    let context = {};
    const raw = rows[0].context;
    if (raw && typeof raw === 'object') {
      context = raw;
    } else if (typeof raw === 'string') {
      try { context = JSON.parse(raw || '{}'); } catch (e) {}
    }
    return {
      context,
      lastMessage: new Date(rows[0].last_message).getTime()
    };
  }
  return null;
}

async function saveConversation(remoteJid, context) {
  const contextStr = JSON.stringify(context);
  const result = await query(
    'INSERT INTO conversations (remote_jid, context, last_message) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE context = ?, last_message = NOW()',
    [remoteJid, contextStr, contextStr]
  );
  return result;
}

async function deleteConversation(remoteJid) {
  await query('DELETE FROM conversations WHERE remote_jid = ?', [remoteJid]);
}

async function cleanOldConversations() {
  await query(
    'DELETE FROM conversations WHERE last_message < NOW() - INTERVAL 30 MINUTE'
  );
}

// ============================================
// Transacciones
// ============================================
async function saveTransaction(data) {
  const result = await query(
    `INSERT INTO transactions (type, operator, phone, amount, service, reference, remote_jid, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.type || 'topup',
      data.operator || null,
      data.phone || null,
      data.amount || null,
      data.service || null,
      data.reference || null,
      data.remoteJid || null,
      data.status || 'pending',
      data.error || null
    ]
  );
  return result;
}

async function getStats() {
  const rows = await query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type='topup' THEN 1 ELSE 0 END) as total_topups,
      SUM(CASE WHEN type='topup' AND status='success' THEN 1 ELSE 0 END) as success_topups,
      SUM(CASE WHEN type='topup' AND status='error' THEN 1 ELSE 0 END) as failed_topups,
      SUM(CASE WHEN type='bill' THEN 1 ELSE 0 END) as total_bills,
      SUM(CASE WHEN type='bill' AND status='success' THEN 1 ELSE 0 END) as success_bills,
      SUM(CASE WHEN type='bill' AND status='error' THEN 1 ELSE 0 END) as failed_bills
    FROM transactions
  `);

  // Últimas 10
  const last10 = await query(
    'SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10'
  );

  // Transacciones por día (últimos 7 días)
  const byDay = await query(`
    SELECT DATE(created_at) as date, COUNT(*) as count, 
           SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success
    FROM transactions 
    WHERE created_at >= NOW() - INTERVAL 7 DAY
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `);

  // Top operadoras
  const topOperators = await query(`
    SELECT operator, COUNT(*) as count 
    FROM transactions 
    WHERE type='topup' AND operator IS NOT NULL
    GROUP BY operator 
    ORDER BY count DESC 
    LIMIT 5
  `);

  return { summary: rows ? rows[0] : null, last10: last10 || [], byDay: byDay || [], topOperators: topOperators || [] };
}

// ============================================
// Números autorizados
// ============================================
async function isAuthorized(remoteJid) {
  const AUTHORIZED_NUMBERS = process.env.AUTHORIZED_NUMBERS || '*';
  if (AUTHORIZED_NUMBERS === '*') return true;

  // Primero revisar variable de entorno
  const numbers = AUTHORIZED_NUMBERS.split(',').map(n => n.trim());
  const phone = remoteJid.split('@')[0];
  if (numbers.includes(phone)) return true;

  // Luego revisar BD
  const rows = await query(
    'SELECT id FROM authorized_numbers WHERE phone = ? AND is_active = TRUE',
    [phone]
  );
  return rows && rows.length > 0;
}

// ============================================
// Límites diarios
// ============================================
async function checkDailyLimit(remoteJid) {
  const phone = remoteJid.split('@')[0];
  const rows = await query(
    'SELECT transaction_count FROM daily_limits WHERE phone = ? AND date = CURDATE()',
    [phone]
  );
  const count = (rows && rows[0]) ? rows[0].transaction_count : 0;
  
  // Obtener límite del usuario
  const userLimit = await query(
    'SELECT max_daily_transactions FROM authorized_numbers WHERE phone = ?',
    [phone]
  );
  const maxLimit = (userLimit && userLimit[0]) ? userLimit[0].max_daily_transactions : 10;
  
  return { current: count, max: maxLimit, allowed: count < maxLimit };
}

async function incrementDailyCount(remoteJid) {
  const phone = remoteJid.split('@')[0];
  await query(
    `INSERT INTO daily_limits (phone, date, transaction_count) 
     VALUES (?, CURDATE(), 1) 
     ON DUPLICATE KEY UPDATE transaction_count = transaction_count + 1`,
    [phone]
  );
}

// ============================================
// Inicialización (crear tablas si no existen)
// ============================================
async function initDatabase() {
  const p = await getPool();
  if (!p) return false;

  try {
    // Las tablas ya fueron creadas por init.sql en Docker
    // Pero por si acaso, verificamos
    const [tables] = await p.execute("SHOW TABLES");
    console.log('[DB] Tablas disponibles:', tables.map(t => Object.values(t)[0]).join(', '));
    return true;
  } catch (err) {
    console.error('[DB] Error en init:', err.message);
    return false;
  }
}

module.exports = {
  getPool,
  query,
  getConversation,
  saveConversation,
  deleteConversation,
  cleanOldConversations,
  saveTransaction,
  getStats,
  isAuthorized,
  checkDailyLimit,
  incrementDailyCount,
  initDatabase
};
