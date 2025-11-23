// src/utils/Logger.js
/**
 * Logger utility for ToolManager
 * Simplified logging system similar to JSON Scanner pattern
 */
const fs = require('fs');
const path = require('path');

class Logger {
  static logLevel = 'info';
  static logFile = null;
  static consoleEnabled = true;
  static projectName = 'ToolManager';
  
  // Color codes
  static colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
  };

  /**
   * Initialize logger with configuration
   * @param {Object} config - Logger configuration
   */
  static initialize(config = {}) {
    Logger.logLevel = config.level || 'info';
    Logger.consoleEnabled = config.console !== false;
    
    if (config.file) {
      Logger.logFile = config.file;
      Logger.ensureLogDirectory();
    }
  }

  /**
   * Ensure log directory exists
   */
  static ensureLogDirectory() {
    if (Logger.logFile) {
      const logDir = path.dirname(Logger.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
  }

  /**
   * Get formatted timestamp
   * @returns {string} - Formatted timestamp
   */
  static getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }

  /**
   * Write log message
   * @param {string} level - Log level
   * @param {string} message - Log message
   */
  static writeLog(level, message) {
    const timestamp = Logger.getTimestamp();
    const plainMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    
    // Console output - plain text, start-all.js adds colors
    if (Logger.consoleEnabled) {
      process.stdout.write(`[${timestamp}] [${level.toUpperCase()}] ${message}\n`);
    }
    
    // File output (no color codes)
    if (Logger.logFile) {
      try {
        fs.appendFileSync(Logger.logFile, plainMessage + '\n', 'utf8');
      } catch (error) {
        process.stderr.write(`Failed to write to log file: ${error.message}\n`);
      }
    }
  }

  /**
   * Log info message
   * @param {string} message - Message to log
   */
  static info(message) {
    Logger.writeLog('info', message);
    return '';
  }

  /**
   * Log error message
   * @param {string} message - Message to log
   */
  static error(message) {
    Logger.writeLog('error', message);
    return '';
  }

  /**
   * Log warning message
   * @param {string} message - Message to log
   */
  static warn(message) {
    Logger.writeLog('warn', message);
    return '';
  }

  /**
   * Log debug message
   * @param {string} message - Message to log
   */
  static debug(message) {
    if (Logger.logLevel === 'debug') {
      Logger.writeLog('debug', message);
    }
    return '';
  }

  /**
   * Setup file naming with date-based log files
   */
  static setupFileNaming() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const logDir = 'logs';
    const logFileName = `tool-manager-${dateStr}.log`;
    
    Logger.initialize({
      level: 'info',
      file: path.join(logDir, logFileName),
      console: true
    });
    
    Logger.info('Logger initialized with file: ' + logFileName);
  }
}

module.exports = Logger;