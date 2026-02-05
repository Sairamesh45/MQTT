const mongoose = require('mongoose');

/**
 * Mongoose schema for device session states.
 * @typedef {Object} Session
 * @property {string} imei - The IMEI of the device.
 * @property {boolean} isOn - Whether the device session is active.
 * @property {boolean} isWalking - Whether the device is in walking mode.
 * @property {Date} createdAt - Session creation timestamp.
 * @property {Date} updatedAt - Session last update timestamp.
 */
const sessionSchema = new mongoose.Schema({
  imei: { type: String, required: true, unique: true },
  isOn: { type: Boolean, required: true },
  isWalking: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);