require('./logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sequelize = require('./db');
const Device = require('./models/device');
const { exec } = require('child_process');

require('dotenv').config();

// Dynamic Security configuration from environment
const MOSQUITTO_ADMIN_USER = process.env.MOSQUITTO_ADMIN_USER || 'admin';
const MOSQUITTO_ADMIN_PASS = process.env.MOSQUITTO_ADMIN_PASS || 'admin12';
const DYNAMIC_SECURITY_FILE = path.resolve(process.env.DYNAMIC_SECURITY_FILE || 'dynamic-security.json');

// Merge .new file left by Mosquitto dynamic-security plugin (Windows rename issues)
function mergeDynsecNewFile() {
    const newFile = DYNAMIC_SECURITY_FILE + '.new';
    if (fs.existsSync(newFile)) {
        try {
            fs.copyFileSync(newFile, DYNAMIC_SECURITY_FILE);
            fs.unlinkSync(newFile);
            console.log(`[DYNSEC] Merged ${path.basename(newFile)} into ${path.basename(DYNAMIC_SECURITY_FILE)}`);
        } catch (err) {
            console.error(`[DYNSEC] Failed to merge .new file:`, err.message);
        }
    }
}

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
        // Hash the secret to generate the password_hash
        const passwordHash = crypto.createHash('sha256').update(secret).digest('hex');

        // Create the device with the hashed password
        const device = await Device.create({
            imei,
            password_hash: passwordHash,
            access_token: crypto.randomBytes(16).toString('hex') // Generate a random access token
        });

        console.log(`✓ Device added successfully!`);
        console.log(`  IMEI: ${device.imei}`);
        console.log(`  Access Token: ${device.access_token}`);
        
        // Define Mosquitto user for the device (Dynamic Security)
        try {
            await defineMosquittoUser(imei, secret);
            console.log(`✓ MQTT credentials configured for ${imei}`);
        } catch (dynsecError) {
            console.error('✗ Failed to configure MQTT user:', dynsecError.message);
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
            console.log(`Token: ${device.access_token}`);
            console.log(`Active: ${device.is_on}`);
            console.log(`Walking: ${device.is_walking}`);
            console.log(`Last Seen: ${device.last_seen}`);
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

// Load environment for MQTT host/port
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || '1883';

// Helper to automate mosquitto_ctrl user+role assignment
defineMosquittoUser = (username, password) => {
    return new Promise((resolve, reject) => {
        // For existing clients, delete first then recreate to ensure password is updated
        const deleteCmd = `mosquitto_ctrl -h ${MQTT_HOST} -p ${MQTT_PORT} -u ${MOSQUITTO_ADMIN_USER} -P ${MOSQUITTO_ADMIN_PASS} dynsec deleteClient ${username}`;
        console.log(`[DYNSEC] Deleting client if exists: ${username}`);
        
        exec(deleteCmd, (delErr, delStdout, delStderr) => {
            // Ignore delete errors (client might not exist)
            if (delErr && !delStderr.includes('not found')) {
                console.log(`[DYNSEC] Delete note: ${delStderr || delErr.message}`);
            }
            
            // Create client with new password
            const createCmd = `mosquitto_ctrl -h ${MQTT_HOST} -p ${MQTT_PORT} -u ${MOSQUITTO_ADMIN_USER} -P ${MOSQUITTO_ADMIN_PASS} dynsec createClient ${username} -p ${password}`;
            console.log(`[DYNSEC] Creating client: ${username}`);
            
            exec(createCmd, (err, stdout, stderr) => {
                if (err) {
                    console.error('mosquitto_ctrl createClient error:', stderr || err.message);
                    reject(new Error(stderr || err.message));
                    return;
                }
                
                console.log(`✓ MQTT client ${username} created with new password`);
                
                // Assign role
                const roleCmd = `mosquitto_ctrl -h ${MQTT_HOST} -p ${MQTT_PORT} -u ${MOSQUITTO_ADMIN_USER} -P ${MOSQUITTO_ADMIN_PASS} dynsec addClientRole ${username} deviceRole`;
                exec(roleCmd, (err2, stdout2, stderr2) => {
                    if (err2) {
                        console.error('mosquitto_ctrl addClientRole error:', stderr2 || err2.message);
                        reject(new Error(stderr2 || err2.message));
                    } else {
                        console.log(`✓ MQTT user ${username} assigned to deviceRole`);
                            // Attempt to merge .new file that Mosquitto may have left behind
                            setTimeout(() => mergeDynsecNewFile(), 1500);
                            resolve();
                    }
                });
            });
        });
    });
};

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
