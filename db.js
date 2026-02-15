const { Sequelize } = require('sequelize');
const dotenv = require("dotenv");
dotenv.config();

// Use environment variables for the Neon DB connection string
// Append sslmode=require to the connection string if not present
const dbUrl = process.env.NEON_DB_URL;
const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: false, // Disable logging for production
  dialectOptions: {
    ssl: {
      require: true, // Enforce SSL for NeonDB
      rejectUnauthorized: false // Allow self-signed certificates
    }
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

// Test the connection
sequelize.authenticate()
  .then(() => {
    console.log('✓ Connected to NeonDB successfully!');
  })
  .catch(err => {
    console.error('✗ NeonDB connection error:', err.message);
  });

module.exports = sequelize;