const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('session', 'postgres', 'Postgre@4551621', {
  host: 'localhost',
  port: 5432,
  dialect: 'postgres',
  logging: false, // disable logging
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
    console.log('✓ PostgreSQL connected successfully!');
  })
  .catch(err => {
    console.error('✗ PostgreSQL connection error:', err.message);
  });

module.exports = sequelize;