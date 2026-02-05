const mongoose = require("mongoose")
/**
 * Mongoose schema for storing device location data.
 * @typedef {Object} Location
 * @property {string} imei - The IMEI of the collar device.
 * @property {number} latitude - Latitude coordinate.
 * @property {number} longitude - Longitude coordinate.
 * @property {Date} timestamp - Timestamp of the location record (auto-generated).
 */
const locationSchema = new mongoose.Schema({
    imei:String,
    latitude:Number,
    longitude:Number,
    timestamp:{
        type:Date,
        default:Date.now
    }
})

module.exports = mongoose.model('location',locationSchema)