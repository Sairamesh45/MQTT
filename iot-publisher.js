const mqtt = require("mqtt");

// Configuration
const MQTT_BROKER = "10.104.74.45"; // Your MQTT broker IP
const MQTT_PORT = 1883;
const COLLAR_ID = "123456789012345"; // Change this for each device
const ACCESS_TOKEN = "9d69741dfa16c7b1e4b306e9fcb3e1047a8ce9235b664705875cc826d313067a"; // <-- Set the correct access token here
const MQTT_USERNAME = "123456789012345"; // Use device IMEI or ID as username if required
const MQTT_PASSWORD = "my-device-secret"; // Set the device secret if broker requires it
const PUBLISH_INTERVAL = 5000; // Send data every 5 seconds (5000ms)

// Connect to MQTT broker with authentication
const client = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD
});

client.on('connect', () => {
    console.log(`✓ Connected to MQTT broker at ${MQTT_BROKER}:${MQTT_PORT}`);
    console.log(`✓ Publishing to topic: collar/${COLLAR_ID}/location`);
    console.log(`✓ Interval: ${PUBLISH_INTERVAL}ms\n`);
    
    // Start publishing location data
    setInterval(() => {
        publishLocation();
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

function publishLocation() {
    // Replace this with actual GPS data from your device
    // For testing, we'll use random coordinates around a base point
    const latitude = getGPSLatitude();
    const longitude = getGPSLongitude();
    
    const message = {
        latitude: latitude,
        longitude: longitude,
        accessToken: ACCESS_TOKEN // <-- Add access token to payload
    };
    
    const topic = `collar/${COLLAR_ID}/location`;
    
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

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n✓ Disconnecting from MQTT broker...');
    client.end(true);
    process.exit(0);
});