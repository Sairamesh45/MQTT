const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  imei: { type: String, required: true, unique: true },
  isOn: { type: Boolean, required: true },
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);