const { DataTypes } = require('sequelize');
const sequelize = require('../db');

/**
 * Sequelize model for storing device battery data.
 * @typedef {Object} Battery
 * @property {number} id - Auto-incrementing primary key.
 * @property {string} imei - The IMEI of the collar device.
 * @property {number} batteryLevel - Battery level as a percentage (0-100).
 * @property {Date} date - Timestamp of the battery record (auto-generated).
 */
const Battery = sequelize.define('Battery', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false },
  battery_level: { type: DataTypes.REAL }, // Updated to match database schema
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'battery',
  timestamps: false
});

module.exports = Battery;