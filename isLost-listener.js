const mqtt = require("mqtt");
const dotenv = require("dotenv")
const readline = require('readline');
const axios = require("axios");

dotenv.config()
// Configuration
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = process.env.MQTT_PORT
const APP_API_URL = process.env.APP_API_URL || "http://localhost:3001";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let MQTT_USERNAME, MQTT_PASSWORD;

function promptCredentials() {
    rl.question('Enter MQTT Username: ', (username) => {
        MQTT_USERNAME = username;
        rl.question('Enter MQTT Password: ', (password) => {
            MQTT_PASSWORD = password;
            rl.close();
            startListener();
        });
    });
}

promptCredentials();

function startListener() {
    const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD
    });

    const topic = `collar/${MQTT_USERNAME}/isLost`;

    client.on('connect', () => {
        console.log(`✓ Connected to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}`);
        client.subscribe(topic, (err) => {
            if (err) {
                console.error('✗ Subscribe failed:', err.message);
            } else {
                console.log(`✓ Subscribed to topic: ${topic}`);
            }
        });
    });

    client.on('message', async (topic, message) => {
        try {
            // Expecting a boolean value (true/false) as string or JSON
            let isLost;
            try {
                isLost = JSON.parse(message.toString());
            } catch {
                isLost = message.toString() === "true";
            }
            console.log(`Received isLost status: ${isLost}`);
            if (isLost) {
                try {
                    await axios.post(`${APP_API_URL}/isLost`, { imei: MQTT_USERNAME, isLost });
                    console.log("Notified app of isLost status");
                } catch (error) {
                    console.error("Error notifying app API:", error.message);
                }
            }
        } catch (e) {
            console.error('✗ Error parsing message:', e.message);
        }
    });

    client.on('error', (err) => {
        console.error('✗ MQTT Connection Error:', err.message);
    });

    client.on('offline', () => {
        console.log('⚠ MQTT client offline, attempting to reconnect...');
    });

    client.on('reconnect', () => {
        console.log('⟳ Reconnecting to MQTT broker...');
    });

    process.on('SIGINT', () => {
        console.log('\n\n✓ Disconnecting from MQTT broker...');
        client.end(true);
        process.exit(0);
    });
}
