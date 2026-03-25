const { DataTypes } = require('sequelize');
const sequelize = require('../db');
const crypto = require('crypto');

/**
 * Sequelize model for IoT collar devices.
 * @property {number} id - Auto-incrementing primary key.
 * @property {string} imei - 15-digit IMEI number (unique).
 * @property {string} password_hash - SHA-256 hash of device secret.
 * @property {string} accessToken - Unique access token for authentication.
 * @property {boolean} isOn - Whether the device is active.
 * @property {boolean} isWalking - Whether the device is in walking mode.
 * @property {Date} lastSeen - Last time the device communicated.
 * @property {Date} createdAt - Device creation timestamp.
 */
let Device = sequelize.models.Device || sequelize.define('Device', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING, allowNull: false },
  access_token: { type: DataTypes.STRING, allowNull: false, unique: true },
  is_on: { type: DataTypes.BOOLEAN, defaultValue: true },
  is_walking: { type: DataTypes.BOOLEAN, defaultValue: false },
  is_lost: { type: DataTypes.BOOLEAN, defaultValue: false },
  last_seen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'device',
  timestamps: false
});

/**
 * Verifies the device password.
 * @param {string} secret - The device secret to verify.
 * @returns {boolean} True if password matches.
 */
Device.prototype.verifyPassword = function(secret) {
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return this.password_hash === hash;
};

/**
 * Verifies the access token.
 * @param {string} token - The access token to verify.
 * @returns {boolean} True if token matches.
 */
Device.prototype.verifyToken = function(token) {
  return this.access_token === token;
};

/**
 * Creates a new device with hashed password and generated access token.
 * @param {string} imei - The 15-digit IMEI.
 * @param {string} secret - The device secret.
 * @returns {Promise<Device>} The created device.
 */
Device.createDevice = async function(imei, secret) {
  const password_hash = crypto.createHash('sha256').update(secret).digest('hex');
  const access_token = crypto.randomBytes(32).toString('hex');

  const device = await this.create({
    imei,
    password_hash,
    access_token
  });
  return device;
};

module.exports = Device;
