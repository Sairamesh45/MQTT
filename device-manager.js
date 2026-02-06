const fs = require('fs');
const crypto = require('crypto');
const sequelize = require('./db');
const Device = require('./models/device');

require('dotenv').config();

// Connect to PostgreSQL
sequelize.authenticate()
    .then(() => console.log("✓ PostgreSQL connected"))
    .catch(err => {
        console.error("✗ PostgreSQL connection error:", err.message);
        process.exit(1);
    });

// Function to add a device
async function addDevice(imei, secret) {
    try {
        const device = await Device.createDevice(imei, secret);
        console.log(`✓ Device added successfully!`);
        console.log(`  IMEI: ${device.imei}`);
        console.log(`  Access Token: ${device.accessToken}`);
        
        // Add to Mosquitto password file using mosquitto_passwd
        const { execSync } = require('child_process');
        try {
            execSync(`mosquitto_passwd -b mosquitto_passwords.txt ${imei} ${secret}`);
            console.log(`✓ Added to mosquitto password file (hashed)`);
        } catch (err) {
            console.error(`✗ Failed to hash password with mosquitto_passwd:`, err.message);
        }
        
        return device;
    } catch (err) {
        console.error("✗ Error adding device:", err.message);
    }
}

// Function to list all devices
async function listDevices() {
    try {
        const devices = await Device.findAll();
        console.log(`\n✓ Total devices: ${devices.length}\n`);
        devices.forEach(device => {
            console.log(`IMEI: ${device.imei}`);
            console.log(`Token: ${device.accessToken}`);
            console.log(`Active: ${device.isOn}`);
            console.log(`Walking: ${device.isWalking}`);
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
    
    
}

main();
