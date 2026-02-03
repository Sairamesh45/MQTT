const mongoose = require("mongoose")
const locationSchema = new mongoose.Schema({
    collarID:String,
    latitude:Number,
    longitude:Number,
    timestamp:{
        type:Date,
        default:Date.now
    }
})

module.exports = mongoose.model('location',locationSchema)