const mongoose = require("mongoose")
/**
 * Mongoose schema for storing device battery data.
 * @typedef {Object} Battery
 * @property {string} collarID - The IMEI of the collar device.
 * @property {number} batteryLevel - Battery level as a percentage (0-100).
 * @property {Date} timestamp - Timestamp of the battery record (auto-generated).
 */
const batterySchema = new mongoose.Schema({
    imei:String,
    batteryLevel:Number,
    timestamp:{
        type:Date,
        default:Date.now
    }
})

module.exports = mongoose.model('battery',batterySchema)