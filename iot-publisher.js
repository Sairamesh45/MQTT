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
        // Subscribe to command topic for this device
        const commandTopic = `collar/${MQTT_USERNAME}/command`;
        mqttClient.subscribe(commandTopic, (err) => {
            if (err) {
                console.error(`[PUBLISHER] Failed to subscribe to ${commandTopic}:`, err.message);
            } else {
                console.log(`[PUBLISHER] Subscribed to ${commandTopic}`);
            }
        });
    });

    mqttClient.on('message', (topic, message) => {
        if (topic === `collar/${MQTT_USERNAME}/command`) {
            console.log('[PUBLISHER] Received command message:', message.toString());
            try {
                const cmd = JSON.parse(message.toString());
                console.log('[PUBLISHER] Parsed command:', cmd);
                if (cmd.action === 'start') {
                    if (!isPublishing) {
                        isPublishing = true;
                        publisherInterval = setInterval(() => {
                            publishLocation(mqttClient);
                        }, PUBLISH_INTERVAL);
                        console.log('[PUBLISHER] Received start command. Started publishing data.');
                    }
                } else if (cmd.action === 'stop') {
                    if (isPublishing) {
                        clearInterval(publisherInterval);
                        isPublishing = false;
                        console.log('[PUBLISHER] Received stop command. Stopped publishing data.');
                    }
                } else if (cmd.action === 'getData') {
                    publishLocation(mqttClient);
                    console.log('[PUBLISHER] Received getData command. Published location data.');
                } else if (cmd.action === 'isWalking') {
                    console.log(`[PUBLISHER] Received isWalking command: ${cmd.value}`);
                }
            } catch (err) {
                console.error('[PUBLISHER] Error parsing command message:', err.message);
                console.error('[PUBLISHER] Raw message bytes:', Buffer.from(message).toString('hex'));
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
    const latitude = getGPSLatitude();
    const longitude = getGPSLongitude();
    const message = {
        latitude: latitude,
        longitude: longitude,
        accessToken: ACCESS_TOKEN
    };
    const topic = `collar/${MQTT_USERNAME}/location`;
    client.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
            console.error('[PUBLISHER] Publish failed:', err.message);
        } else {
            console.log(`[PUBLISHER] Published to ${topic}: ${JSON.stringify(message)}`);
        }
    });
}

// Simulated GPS functions - REPLACE WITH ACTUAL GPS MODULE CODE
function getGPSLatitude() {
    const baseLatitude = 37.7749;
    const variation = (Math.random() - 0.5) * 0.01;
    return parseFloat((baseLatitude + variation).toFixed(6));
}

function getGPSLongitude() {
    const baseLongitude = -122.4194;
    const variation = (Math.random() - 0.5) * 0.01;
    return parseFloat((baseLongitude + variation).toFixed(6));
}

// Prompt for credentials and start
promptCredentials();