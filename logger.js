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
    const ts = new Date().toISOString();
    const message = util.format.apply(null, args);
    const line = `${ts} [${level.toUpperCase()}] ${message}`;
    // Write to file (best-effort)
    writeToFile(line);
    // Also call original to keep console output
    _orig[level](line);
  };
});

module.exports = {};
