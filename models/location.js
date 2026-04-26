const { DataTypes } = require('sequelize');
const sequelize = require('../db');

/**
 * Sequelize model for device location history.
 * Maps to the 'device_locations' table managed by the NestJS backend.
 * The MQTT app no longer writes to this table directly —
 * all writes go through the NestJS backend via POST /api/devices/telemetry.
 * This model is kept for legacy /view and /latest reads only.
 */
const Location = sequelize.define('Location', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false },
  latitude: { type: DataTypes.DECIMAL(10, 6), allowNull: false },
  longitude: { type: DataTypes.DECIMAL(10, 6), allowNull: false },
  battery_percentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  location_timestamp: { type: DataTypes.DATE, allowNull: true },
  battery_timestamp: { type: DataTypes.DATE, allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'device_locations',
  timestamps: false
});

module.exports = Location;
