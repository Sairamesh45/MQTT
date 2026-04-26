const { DataTypes } = require('sequelize');
const sequelize = require('../db');

/**
 * Battery is no longer stored in a standalone table.
 * The NestJS backend tracks battery as a hot field on the `devices` table
 * (devices.battery_percentage) and never writes to a separate battery table.
 *
 * This stub keeps the module importable so existing require('./models/battery')
 * calls don't crash. All actual battery reads/writes go through the NestJS
 * backend via POST /api/devices/telemetry.
 */
const Battery = sequelize.define('Battery', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false },
  battery_level: { type: DataTypes.REAL, allowNull: true },
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'battery',
  timestamps: false
});

module.exports = Battery;
