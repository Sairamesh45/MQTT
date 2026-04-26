const { DataTypes } = require('sequelize');
const sequelize = require('../db');
const crypto = require('crypto');

/**
 * Sequelize model for IoT collar devices.
 * Maps to the 'devices' table managed by the NestJS backend.
 */
let Device = sequelize.models.Device || sequelize.define('Device', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING, allowNull: false },
  access_token: { type: DataTypes.STRING, allowNull: false, unique: true },
  is_on: { type: DataTypes.BOOLEAN, defaultValue: true },
  is_walking: { type: DataTypes.BOOLEAN, defaultValue: false },
  is_lost: { type: DataTypes.BOOLEAN, defaultValue: false },
  walk_started_at: { type: DataTypes.DATE, allowNull: true },
  walk_ended_at: { type: DataTypes.DATE, allowNull: true },
  lost_at: { type: DataTypes.DATE, allowNull: true },
  remark: {
    type: DataTypes.ENUM('unregistered', 'registered', 'deregistered', 'reregistered'),
    defaultValue: 'unregistered'
  },
  last_seen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  // Hot fields — updated on every MQTT frame by the NestJS backend
  latitude: { type: DataTypes.DECIMAL(10, 6), allowNull: true },
  longitude: { type: DataTypes.DECIMAL(10, 6), allowNull: true },
  battery_percentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  location_updated_at: { type: DataTypes.DATE, allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'devices',
  timestamps: false
});

Device.prototype.verifyPassword = function(secret) {
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return this.password_hash === hash;
};

Device.prototype.verifyToken = function(token) {
  return this.access_token === token;
};

Device.createDevice = async function(imei, secret) {
  const password_hash = crypto.createHash('sha256').update(secret).digest('hex');
  const access_token = crypto.randomBytes(32).toString('hex');
  return this.create({ imei, password_hash, access_token });
};

module.exports = Device;
