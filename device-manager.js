const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Device = require('./models/device');

// Connect to MongoDB
const mongoUri = "mongodb+srv://sairamesh4551621_db_user:7eu1kp022ZgjLhyf@cluster0.buhtzae.mongodb.net/test";
mongoose.connect(mongoUri)
    .then(() => console.log("✓ MongoDB connected"))
    .catch(err => {
        console.error("✗ MongoDB connection error:", err.message);
        process.exit(1);
    });

// Function to add a device
async function addDevice(imei, secret) {
    try {
        const device = await Device.createDevice(imei, secret);
        console.log(`✓ Device added successfully!`);
        console.log(`  IMEI: ${device.imei}`);
        console.log(`  Access Token: ${device.accessToken}`);
        
        // Add to Mosquitto password file
        const passwordHash = crypto.createHash('sha256').update(secret).digest('hex');
        const passwordEntry = `${imei}:${passwordHash}\n`;
        fs.appendFileSync('mosquitto_passwords.txt', passwordEntry);
        console.log(`✓ Added to mosquitto password file`);
        
        return device;
    } catch (err) {
        console.error("✗ Error adding device:", err.message);
    }
}

// Function to list all devices
async function listDevices() {
    try {
        const devices = await Device.find({});
        console.log(`\n✓ Total devices: ${devices.length}\n`);
        devices.forEach(device => {
            console.log(`IMEI: ${device.imei}`);
            console.log(`Token: ${device.accessToken}`);
            console.log(`Active: ${device.isActive}`);
            console.log(`Last Seen: ${device.lastSeen}`);
            console.log('---');
        });
    } catch (err) {
        console.error("✗ Error listing devices:", err.message);
    }
}

// Function to verify token
async function verifyToken(imei, token) {
    try {
        const device = await Device.findOne({ imei });
        if (!device) {
            console.log(`✗ Device not found: ${imei}`);
            return false;
        }
        
        const isValid = device.verifyToken(token);
        console.log(`Token valid: ${isValid}`);
        return isValid;
    } catch (err) {
        console.error("✗ Error verifying token:", err.message);
        return false;
    }
}

// Command line interface
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

async function main() {
    if (command === 'add' && arg1 && arg2) {
        await addDevice(arg1, arg2);
    } else if (command === 'list') {
        await listDevices();
    } else if (command === 'verify' && arg1 && arg2) {
        await verifyToken(arg1, arg2);
    } else {
        console.log('Usage:');
        console.log('  node device-manager.js add <IMEI> <secret>     - Add new device');
        console.log('  node device-manager.js list                    - List all devices');
        console.log('  node device-manager.js verify <IMEI> <token>   - Verify access token');
    }
    
    mongoose.disconnect();
}

main();
