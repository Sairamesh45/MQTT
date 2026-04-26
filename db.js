require('./logger');
const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
dotenv.config();

// Accepts both DATABASE_HOST (NestJS backend convention) and DB_HOST (short form).
// Falls back to NEON_DB_URL if neither is set.
const dbHost     = process.env.DATABASE_HOST     || process.env.DB_HOST;
const dbPort     = process.env.DATABASE_PORT     || process.env.DB_PORT     || '5432';
const dbUser     = process.env.DATABASE_USER     || process.env.DB_USER     || 'postgres';
const dbPassword = process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || '';
const dbName     = process.env.DATABASE_NAME     || process.env.DB_NAME     || 'postgres';

let sequelize;

if (dbHost) {
  // ── AWS Aurora / RDS (individual params) ─────────────────────────────────
  const sslOptions = { rejectUnauthorized: false };

  // Load Aurora CA bundle if present
  const caPath = path.resolve(process.env.DB_SSL_CA || '../my-perro-backend/global-bundle.pem');
  if (fs.existsSync(caPath)) {
    sslOptions.ca = fs.readFileSync(caPath).toString();
  }

  sequelize = new Sequelize(dbName, dbUser, dbPassword, {
    host:    dbHost,
    port:    parseInt(dbPort, 10),
    dialect: 'postgres',
    logging: false,
    dialectOptions: { ssl: sslOptions },
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  });

  sequelize.authenticate()
    .then(() => console.log(`✓ Connected to AWS Aurora (${dbHost}) successfully!`))
    .catch(err => console.error('✗ Aurora connection error:', err.message));

} else if (process.env.NEON_DB_URL) {
  // ── Neon / full connection URL (fallback) ─────────────────────────────────
  sequelize = new Sequelize(process.env.NEON_DB_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  });

  sequelize.authenticate()
    .then(() => console.log('✓ Connected to NeonDB successfully!'))
    .catch(err => console.error('✗ NeonDB connection error:', err.message));

} else {
  console.error('✗ No database config. Set DATABASE_HOST (AWS Aurora) or NEON_DB_URL (Neon) in .env');
  process.exit(1);
}

module.exports = sequelize;
