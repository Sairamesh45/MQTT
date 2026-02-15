const mqtt = require("mqtt");
const readline = require("readline");
require("dotenv").config();

// Configuration
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = process.env.MQTT_PORT;
const PUBLISH_INTERVAL = process.env.PUBLISH_INTERVAL || 5000;

let MQTT_USERNAME = "";
let MQTT_PASSWORD = "";
let ACCESS_TOKEN = "";
let publisherInterval = null;
let mqttClient = null;
let isPublishing = false;

function promptCredentials() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question('Enter MQTT Username (IMEI): ', (username) => {
        MQTT_USERNAME = username;
        rl.question('Enter MQTT Password: ', (password) => {
            MQTT_PASSWORD = password;
            rl.question('Enter Access Token: ', (accessToken) => {
                ACCESS_TOKEN = accessToken;
                rl.close();
                startClient();
            });
        });
    });
}

function startClient() {
    console.log("\n" + "=".repeat(70));
    console.log("[IOT-PUBLISHER] 🚀 Starting MQTT Client Connection");
    console.log("=".repeat(70));
    console.log("[IOT-PUBLISHER] Broker Host:", MQTT_HOST);
    console.log("[IOT-PUBLISHER] Broker Port:", MQTT_PORT);
    console.log("[IOT-PUBLISHER] Username (IMEI):", MQTT_USERNAME);
    console.log("[IOT-PUBLISHER] Password Length:", MQTT_PASSWORD.length, "chars");
    console.log("[IOT-PUBLISHER] Password:", MQTT_PASSWORD);
    console.log("[IOT-PUBLISHER] Access Token:", ACCESS_TOKEN ? ACCESS_TOKEN.substring(0, 10) + '...' : '(not set)');
    console.log("=".repeat(70));
    console.log("[IOT-PUBLISHER] ⏳ Attempting connection...\n");
    
    mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        console.log("\n" + "*".repeat(70));
        console.log(`[IOT-PUBLISHER] ✓✓✓ CONNECTION SUCCESSFUL ✓✓✓`);
        console.log("*".repeat(70));
        console.log(`[IOT-PUBLISHER] Connected to: ${MQTT_HOST}:${MQTT_PORT}`);
        console.log(`[IOT-PUBLISHER] Client ID: ${mqttClient.options.clientId}`);
        console.log(`[IOT-PUBLISHER] Authenticated as: ${MQTT_USERNAME}`);
        console.log("*".repeat(70) + "\n");
        
        // Subscribe to isOn and isWalking topics for this device
        const isOnTopic = `collar/${MQTT_USERNAME}/isOn`;
        const isWalkingTopic = `collar/${MQTT_USERNAME}/isWalking`;
        
        console.log(`[IOT-PUBLISHER] 📡 Subscribing to control topics...`);
        console.log(`[IOT-PUBLISHER] Topic 1: ${isOnTopic}`);
        mqttClient.subscribe(isOnTopic, (err, granted) => {
            if (err) {
                console.error(`[IOT-PUBLISHER] ✗✗✗ SUBSCRIBE FAILED: ${isOnTopic}`);
                console.error(`[IOT-PUBLISHER] Error:`, err.message);
                console.error(`[IOT-PUBLISHER] Full error:`, err);
            } else {
                console.log(`[IOT-PUBLISHER] ✓ Successfully subscribed to ${isOnTopic}`);
                console.log(`[IOT-PUBLISHER] Granted:`, granted);
            }
        });
        
        console.log(`[IOT-PUBLISHER] Topic 2: ${isWalkingTopic}`);
        mqttClient.subscribe(isWalkingTopic, (err, granted) => {
            if (err) {
                console.error(`[IOT-PUBLISHER] ✗✗✗ SUBSCRIBE FAILED: ${isWalkingTopic}`);
                console.error(`[IOT-PUBLISHER] Error:`, err.message);
                console.error(`[IOT-PUBLISHER] Full error:`, err);
            } else {
                console.log(`[IOT-PUBLISHER] ✓ Successfully subscribed to ${isWalkingTopic}`);
                console.log(`[IOT-PUBLISHER] Granted:`, granted);
            }
        });
        console.log(`[IOT-PUBLISHER] ⏳ Waiting for messages...\n`);
    });

    mqttClient.on('message', (topic, message) => {
        console.log(`\n[PUBLISHER] ========== MESSAGE RECEIVED ==========`);
        console.log(`[PUBLISHER] Topic: ${topic}`);
        console.log(`[PUBLISHER] Raw message: ${message.toString()}`);
        console.log(`[PUBLISHER] Expected IMEI: ${MQTT_USERNAME}`);
        
        if (topic === `collar/${MQTT_USERNAME}/isOn`) {
            try {
                const isOn = JSON.parse(message.toString());
                console.log(`[PUBLISHER] ✓ Parsed isOn: ${isOn} (type: ${typeof isOn})`);
                if (isOn && !isPublishing) {
                    isPublishing = true;
                    publisherInterval = setInterval(() => {
                        publishLocation(mqttClient);
                        publishBattery(mqttClient);
                    }, PUBLISH_INTERVAL);
                    console.log('[PUBLISHER] ✓ Started publishing data.');
                } else if (!isOn && isPublishing) {
                    clearInterval(publisherInterval);
                    isPublishing = false;
                    console.log('[PUBLISHER] ✓ Stopped publishing data.');
                } else {
                    console.log(`[PUBLISHER] No action taken. isOn=${isOn}, isPublishing=${isPublishing}`);
                }
            } catch (err) {
                console.error('[PUBLISHER] ✗ Error parsing isOn message:', err.message);
            }
        } else if (topic === `collar/${MQTT_USERNAME}/isWalking`) {
            try {
                const isWalking = JSON.parse(message.toString());
                console.log(`[PUBLISHER] ✓ Parsed isWalking: ${isWalking} (type: ${typeof isWalking})`);
                // Handle isWalking if needed
            } catch (err) {
                console.error('[PUBLISHER] ✗ Error parsing isWalking message:', err.message);
            }
        } else {
            console.log(`[PUBLISHER] ⚠ Received message on unexpected topic: ${topic}`);
        }
        console.log(`[PUBLISHER] ========================================\n`);
    });

    mqttClient.on('error', (err) => {
        console.error('\n[IOT-PUBLISHER] ✗✗✗ CONNECTION ERROR ✗✗✗');
        console.error('[IOT-PUBLISHER] Error Message:', err.message);
        console.error('[IOT-PUBLISHER] Error Code:', err.code);
        console.error('[IOT-PUBLISHER] Full Error:', err);
        console.error('[IOT-PUBLISHER] Credentials Used:');
        console.error('[IOT-PUBLISHER]   - Username:', MQTT_USERNAME);
        console.error('[IOT-PUBLISHER]   - Password:', MQTT_PASSWORD);
        console.error('[IOT-PUBLISHER]   - Host:', MQTT_HOST);
        console.error('[IOT-PUBLISHER]   - Port:', MQTT_PORT);
        console.error('');
    });

    mqttClient.on('offline', () => {
        console.log('[IOT-PUBLISHER] ⚠ MQTT client offline, attempting to reconnect...');
    });

    mqttClient.on('reconnect', () => {
        console.log('[IOT-PUBLISHER] ⟳ Reconnecting to MQTT broker...');
    });

    mqttClient.on('close', () => {
        console.log('[IOT-PUBLISHER] 🔌 MQTT connection closed');
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n[PUBLISHER] Disconnecting from MQTT broker...');
        mqttClient.end(true);
        process.exit(0);
    });
}

function publishLocation(client) {
    /**
     * Publishes simulated location data to MQTT topic.
     * @param {object} client - MQTT client instance.
     */
    const latitude = getGPSLatitude();
    const longitude = getGPSLongitude();
    const message = [latitude, longitude];
    const topic = `collar/${MQTT_USERNAME}/location`;
    client.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
            console.error('[PUBLISHER] Publish failed:', err.message);
        } else {
            console.log(`[PUBLISHER] Published to ${topic}: ${JSON.stringify(message)}`);
        }
    });
}

function publishBattery(client) {
    /**
     * Publishes simulated battery data to MQTT topic.
     * @param {object} client - MQTT client instance.
     */
    const batteryLevel = getBatteryLevel();
    const message = [batteryLevel];
    const topic = `collar/${MQTT_USERNAME}/battery`;
    client.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
            console.error('[PUBLISHER] Publish failed:', err.message);
        } else {
            console.log(`[PUBLISHER] Published to ${topic}: ${JSON.stringify(message)}`);
        }
    });
}

// Simulated GPS functions - REPLACE WITH ACTUAL GPS MODULE CODE
/**
 * Simulates GPS latitude with small random variation.
 * @returns {number} Latitude coordinate.
 */
function getGPSLatitude() {
    const baseLatitude = 37.7749;
    const variation = (Math.random() - 0.5) * 0.01;
    return parseFloat((baseLatitude + variation).toFixed(6));
}

/**
 * Simulates GPS longitude with small random variation.
 * @returns {number} Longitude coordinate.
 */
function getGPSLongitude() {
    const baseLongitude = -122.4194;
    const variation = (Math.random() - 0.5) * 0.01;
    return parseFloat((baseLongitude + variation).toFixed(6));
}

/**
 * Simulates battery level as a floating point number.
 * @returns {number} Battery level between 0 and 100.
 */
function getBatteryLevel() {
    // Simulate battery level between 0 and 100 as float
    return parseFloat((Math.random() * 100).toFixed(2));
}

// Prompt for credentials and start
promptCredentials();