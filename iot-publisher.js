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
    console.log("[PUBLISHER] Connecting to MQTT broker...");
    mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        console.log(`[PUBLISHER] Connected to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}`);
        // Subscribe to isOn and isWalking topics for this device
        const isOnTopic = `collar/${MQTT_USERNAME}/isOn`;
        const isWalkingTopic = `collar/${MQTT_USERNAME}/isWalking`;
        mqttClient.subscribe(isOnTopic, (err) => {
            if (err) {
                console.error(`[PUBLISHER] Failed to subscribe to ${isOnTopic}:`, err.message);
            } else {
                console.log(`[PUBLISHER] Subscribed to ${isOnTopic}`);
            }
        });
        mqttClient.subscribe(isWalkingTopic, (err) => {
            if (err) {
                console.error(`[PUBLISHER] Failed to subscribe to ${isWalkingTopic}:`, err.message);
            } else {
                console.log(`[PUBLISHER] Subscribed to ${isWalkingTopic}`);
            }
        });
    });

    mqttClient.on('message', (topic, message) => {
        if (topic === `collar/${MQTT_USERNAME}/isOn`) {
            try {
                const isOn = JSON.parse(message.toString());
                console.log(`[PUBLISHER] Received isOn: ${isOn}`);
                if (isOn && !isPublishing) {
                    isPublishing = true;
                    publisherInterval = setInterval(() => {
                        publishLocation(mqttClient);
                        publishBattery(mqttClient);
                    }, PUBLISH_INTERVAL);
                    console.log('[PUBLISHER] Started publishing data.');
                } else if (!isOn && isPublishing) {
                    clearInterval(publisherInterval);
                    isPublishing = false;
                    console.log('[PUBLISHER] Stopped publishing data.');
                }
            } catch (err) {
                console.error('[PUBLISHER] Error parsing isOn message:', err.message);
            }
        } else if (topic === `collar/${MQTT_USERNAME}/isWalking`) {
            try {
                const isWalking = JSON.parse(message.toString());
                console.log(`[PUBLISHER] Received isWalking: ${isWalking}`);
                // Handle isWalking if needed
            } catch (err) {
                console.error('[PUBLISHER] Error parsing isWalking message:', err.message);
            }
        }
    });

    mqttClient.on('error', (err) => {
        console.error('[PUBLISHER] MQTT Connection Error:', err.message);
    });

    mqttClient.on('offline', () => {
        console.log('[PUBLISHER] MQTT client offline, attempting to reconnect...');
    });

    mqttClient.on('reconnect', () => {
        console.log('[PUBLISHER] Reconnecting to MQTT broker...');
    });

    mqttClient.on('close', () => {
        console.log('[PUBLISHER] MQTT connection closed');
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