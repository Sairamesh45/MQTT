const { DataTypes } = require('sequelize');
const sequelize = require('../db');

/**
 * Sequelize model for storing device location data.
 * @typedef {Object} Location
 * @property {number} id - Auto-incrementing primary key.
 * @property {string} imei - The IMEI of the collar device.
 * @property {number} latitude - Latitude coordinate.
 * @property {number} longitude - Longitude coordinate.
 * @property {Date} date - Timestamp of the location record (auto-generated).
 */
const Location = sequelize.define('Location', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false },
  latitude: { type: DataTypes.DOUBLE, allowNull: false },
  longitude: { type: DataTypes.DOUBLE, allowNull: false },
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'location',
  timestamps: false
});

module.exports = Location;