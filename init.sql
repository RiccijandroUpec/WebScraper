-- ============================================
-- Inicialización de base de datos para RickTech
-- ============================================

CREATE DATABASE IF NOT EXISTS ricktech;
USE ricktech;

-- Tabla de conversaciones (persistencia)
CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    remote_jid VARCHAR(100) NOT NULL UNIQUE,
    context JSON,
    last_message TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_remote_jid (remote_jid),
    INDEX idx_last_message (last_message)
);

-- Tabla de transacciones
CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('topup', 'bill') NOT NULL,
    operator VARCHAR(50),
    phone VARCHAR(20),
    amount VARCHAR(20),
    service VARCHAR(50),
    reference VARCHAR(50),
    remote_jid VARCHAR(100),
    status ENUM('success', 'error', 'pending') NOT NULL DEFAULT 'pending',
    error TEXT,
    screenshot_path VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_type (type),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
);

-- Tabla de números autorizados
CREATE TABLE IF NOT EXISTS authorized_numbers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    max_daily_transactions INT DEFAULT 10,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_phone (phone)
);

-- Tabla de límites diarios
CREATE TABLE IF NOT EXISTS daily_limits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    date DATE NOT NULL,
    transaction_count INT DEFAULT 0,
    UNIQUE KEY unique_phone_date (phone, date),
    INDEX idx_phone_date (phone, date)
);
