const fs = require('fs');
const path = require('path');
const util = require('util');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
try {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
} catch (e) {
  // If we can't create logs dir, continue without file logging
}

const logFile = path.join(logsDir, 'app.log');

// IST timezone offset (GMT+5:30)
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

/**
 * Format date to IST string: YYYY-MM-DD HH:mm:ss.SSS IST
 */
function formatToIST(date = new Date()) {
  const istDate = new Date(date.getTime() + IST_OFFSET);
  
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  const hours = String(istDate.getUTCHours()).padStart(2, '0');
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(istDate.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(istDate.getUTCMilliseconds()).padStart(3, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds} IST`;
}

// Preserve original console methods
const _orig = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
};

function writeToFile(text) {
  try {
    fs.appendFileSync(logFile, text + '\n');
  } catch (e) {
    // Ignore file write errors to avoid crashing the app
  }
}

['log', 'error', 'warn', 'info', 'debug'].forEach((level) => {
  console[level] = function(...args) {
    const ts = formatToIST();
    const message = util.format.apply(null, args);
    const line = `${ts} [${level.toUpperCase()}] ${message}`;
    // Write to file (best-effort)
    writeToFile(line);
    // Also call original to keep console output
    _orig[level](line);
  };
});

module.exports = {};
