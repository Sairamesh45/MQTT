const mqtt = require("mqtt");

// Configuration

const readline = require('readline');
const MQTT_BROKER = "10.104.74.45"; // Your MQTT broker IP
const MQTT_PORT = 1883;
const PUBLISH_INTERVAL = 5000; // Send data every 5 seconds (5000ms)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});


let ACCESS_TOKEN, MQTT_USERNAME, MQTT_PASSWORD;

function promptCredentials() {
    rl.question('Enter MQTT Username: ', (username) => {
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

promptCredentials();

function startClient() {
    // Connect to MQTT broker with authentication
    const client = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD
    });

    client.on('connect', () => {
        console.log(`✓ Connected to MQTT broker at ${MQTT_BROKER}:${MQTT_PORT}`);
        console.log(`✓ Publishing to topic: collar/${MQTT_USERNAME}/location`);
        console.log(`✓ Interval: ${PUBLISH_INTERVAL}ms\n`);
        setInterval(() => {
            publishLocation(client);
        }, PUBLISH_INTERVAL);
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

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n✓ Disconnecting from MQTT broker...');
        client.end(true);
        process.exit(0);
    });
}



function publishLocation(client) {
    // Replace this with actual GPS data from your device
    // For testing, we'll use random coordinates around a base point
    const latitude = getGPSLatitude();
    const longitude = getGPSLongitude();
    const message = {
        latitude: latitude,
        longitude: longitude,
        accessToken: ACCESS_TOKEN // <-- Add access token to payload
    };
    const topic = `collar/${MQTT_USERNAME}/location`;
    client.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
            console.error('✗ Publish failed:', err.message);
        } else {
            console.log(`✓ Published: ${JSON.stringify(message)}`);
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

