const mongoose = require("mongoose");
const crypto = require("crypto");

/**
 * Mongoose schema for IoT collar devices.
 * @typedef {Object} Device
 * @property {string} imei - 15-digit IMEI number (unique).
 * @property {string} passwordHash - SHA-256 hash of device secret.
 * @property {string} accessToken - Unique access token for authentication.
 * @property {boolean} isOn - Whether the device is active.
 * @property {Date} lastSeen - Last time the device communicated.
 * @property {Date} createdAt - Device creation timestamp.
 */
const deviceSchema = new mongoose.Schema({
    imei: {
        type: String,
        required: true,
        unique: true,
        match: /^[0-9]{15}$/ // IMEI is 15 digits
    },
    passwordHash: {
        type: String,
        required: true // SHA-256 hash of the device secret
    },
    accessToken: {
        type: String,
        required: true,
        unique: true
    },
    isOn: {
        type: Boolean,
        default: true
    },
    lastSeen: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

/**
 * Verifies the device password.
 * @param {string} secret - The device secret to verify.
 * @returns {boolean} True if password matches.
 */
deviceSchema.methods.verifyPassword = function(secret) {
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    return this.passwordHash === hash;
};

/**
 * Verifies the access token.
 * @param {string} token - The access token to verify.
 * @returns {boolean} True if token matches.
 */
deviceSchema.methods.verifyToken = function(token) {
    return this.accessToken === token;
};

/**
 * Creates a new device with hashed password and generated access token.
 * @param {string} imei - The 15-digit IMEI.
 * @param {string} secret - The device secret.
 * @returns {Promise<Device>} The created device.
 */
deviceSchema.statics.createDevice = async function(imei, secret) {
    const passwordHash = crypto.createHash('sha256').update(secret).digest('hex');
    const accessToken = crypto.randomBytes(32).toString('hex');
    
    const device = new this({
        imei,
        passwordHash,
        accessToken
    });
    
    await device.save();
    return device;
};

module.exports = mongoose.model('Device', deviceSchema);
