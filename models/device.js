const { DataTypes } = require('sequelize');
const sequelize = require('../db');
const crypto = require('crypto');

/**
 * Sequelize model for IoT collar devices.
 * @property {number} id - Auto-incrementing primary key.
 * @property {string} imei - 15-digit IMEI number (unique).
 * @property {string} passwordHash - SHA-256 hash of device secret.
 * @property {string} accessToken - Unique access token for authentication.
 * @property {boolean} isOn - Whether the device is active.
 * @property {boolean} isWalking - Whether the device is in walking mode.
 * @property {Date} lastSeen - Last time the device communicated.
 * @property {Date} createdAt - Device creation timestamp.
 */
let Device = sequelize.models.Device || sequelize.define('Device', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  imei: { type: DataTypes.STRING(15), allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  accessToken: { type: DataTypes.STRING, allowNull: false, unique: true },
  isOn: { type: DataTypes.BOOLEAN, defaultValue: true },
  isWalking: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastSeen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
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
  return this.passwordHash === hash;
};

/**
 * Verifies the access token.
 * @param {string} token - The access token to verify.
 * @returns {boolean} True if token matches.
 */
Device.prototype.verifyToken = function(token) {
  return this.accessToken === token;
};

/**
 * Creates a new device with hashed password and generated access token.
 * @param {string} imei - The 15-digit IMEI.
 * @param {string} secret - The device secret.
 * @returns {Promise<Device>} The created device.
 */
Device.createDevice = async function(imei, secret) {
  const passwordHash = crypto.createHash('sha256').update(secret).digest('hex');
  const accessToken = crypto.randomBytes(32).toString('hex');

  const device = await this.create({
    imei,
    passwordHash,
    accessToken
  });
  return device;
};

module.exports = Device;
