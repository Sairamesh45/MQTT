const mongoose = require("mongoose");
const crypto = require("crypto");

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
    isActive: {
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

// Method to verify password
deviceSchema.methods.verifyPassword = function(secret) {
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    return this.passwordHash === hash;
};

// Method to verify access token
deviceSchema.methods.verifyToken = function(token) {
    return this.accessToken === token;
};

// Static method to create device with hashed password
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
