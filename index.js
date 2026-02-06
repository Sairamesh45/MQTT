const mqtt = require("mqtt");
const express = require("express");
const bodyParser = require("body-parser");
const Location = require("./models/location");
const Device = require("./models/device");
const Battery = require("./models/battery");
const sequelize = require("./db");

// Load environment variables
require('dotenv').config();

// Connect to PostgreSQL and sync models
sequelize.authenticate()
    .then(() => {
        console.log("✓ PostgreSQL connected successfully!");
        return sequelize.sync(); // Sync models to database
    })
    .then(() => {
        console.log("✓ Database synced!");
        // Start Express server
        startExpressServer();
    })
    .catch(err => {
        console.error("✗ Database connection error:", err.message);
        process.exit(1);
    });

let mqttClient = null;

// Function to save location to PostgreSQL after validation
/**
 * Saves location data to PostgreSQL after validating device and coordinates.
 * @param {string} imei - The IMEI of the device.
 * @param {number} latitude - The latitude coordinate.
 * @param {number} longitude - The longitude coordinate.
 * @returns {Promise<boolean>} True if saved successfully, false otherwise.
 */
async function saveLocationToPostgres(imei, latitude, longitude) {
    console.log("\n--- Received Data ---");
    console.log("IMEI:", imei);
    console.log("Latitude:", latitude);
    console.log("Longitude:", longitude);

    // Only check device existence and status, not access token
    try {
        const device = await Device.findOne({ where: { imei } });
        if (!device) {
            console.log("✗ Device not found in database");
            return false;
        }

        if (!device.isOn) {
            console.log("✗ Device is not active");
            return false;
        }

        // Update last seen
        device.lastSeen = new Date();
        await device.save();

    } catch (err) {
        console.error("✗ Device validation error:", err.message);
        return false;
    }

    if (typeof latitude !== "number" || typeof longitude !== "number") {
        console.log("✗ Invalid input types - must be numbers");
        return false;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        console.log("✗ Invalid coordinate range");
        return false;
    }

    try {
        await Location.create({
            imei: imei,
            latitude,
            longitude
        });
        console.log("✓ Location saved successfully");
        return true;
    } catch (err) {
        console.error("✗ Error saving location:", err.message);
        return false;
    }
}

// Function to save battery to PostgreSQL after validation
/**
 * Saves battery data to PostgreSQL after validating device and battery level.
 * @param {string} imei - The IMEI of the device.
 * @param {number} batteryLevel - The battery level (0-100).
 * @returns {Promise<boolean>} True if saved successfully, false otherwise.
 */
async function saveBatteryToPostgres(imei, batteryLevel) {
    console.log("\n--- Received Battery Data ---");
    console.log("IMEI:", imei);
    console.log("Battery Level:", batteryLevel);

    // Only check device existence and status, not access token
    try {
        const device = await Device.findOne({ where: { imei } });
        if (!device) {
            console.log("✗ Device not found in database");
            return false;
        }

        if (!device.isOn) {
            console.log("✗ Device is not active");
            return false;
        }

        // Update last seen
        device.lastSeen = new Date();
        await device.save();

    } catch (err) {
        console.error("✗ Device validation error:", err.message);
        return false;
    }

    if (typeof batteryLevel !== "number" || batteryLevel < 0 || batteryLevel > 100) {
        console.log("✗ Invalid battery level - must be number between 0 and 100");
        return false;
    }

    try {
        await Battery.create({
            imei: imei,
            batteryLevel
        });
        console.log("✓ Battery saved successfully");
        return true;
    } catch (err) {
        console.error("✗ Error saving battery:", err.message);
        return false;
    }
}

function startMQTTClient() {
    console.log("[MQTT] Connecting to broker:", `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
    mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`, {
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        console.log("[MQTT] Connected to broker");
        mqttClient.subscribe("collar/+/location", (err, granted) => {
            if (err) {
                console.error("[MQTT] Subscribe error:", err.message);
            } else {
                console.log("[MQTT] Subscribed to: collar/+/location", granted);
            }
        });
        mqttClient.subscribe("collar/+/battery", (err, granted) => {
            if (err) {
                console.error("[MQTT] Subscribe error:", err.message);
            } else {
                console.log("[MQTT] Subscribed to: collar/+/battery", granted);
            }
        });
        console.log("[MQTT] Waiting for messages...");
    });

    mqttClient.on('reconnect', () => {
        console.log("[MQTT] Reconnecting to broker...");
    });

    mqttClient.on('close', () => {
        console.log("[MQTT] Connection closed");
    });

    mqttClient.on('offline', () => {
        console.log("[MQTT] Client is offline");
    });

    mqttClient.on('error', (err) => {
        console.error("[MQTT] Error:", err.message);
    });

    mqttClient.on('end', () => {
        console.log("[MQTT] Client ended");
    });

    mqttClient.on('message', async (topic, message) => {
        /**
         * Handles incoming MQTT messages for location and battery topics.
         * Parses topic to determine type, validates session, and saves data.
         */
        console.log("[MQTT] Message received");
        console.log("[MQTT] Topic:", topic);
        console.log("[MQTT] Raw message:", message.toString());

        const parts = topic.split("/");
        const imei = parts[1];
        const topicType = parts[2];
        console.log("[MQTT] Parsed IMEI:", imei);
        console.log("[MQTT] Topic type:", topicType);

        let data;
        try {
            data = JSON.parse(message.toString());
            console.log("[MQTT] Parsed JSON:", data);
        } catch (err) {
            console.log("[MQTT] Invalid JSON format:", err.message);
            return;
        }

        // Check isOn state in Device before saving
        try {
            const device = await Device.findOne({ where: { imei } });
            if (!device || !device.isOn) {
                console.log("[MQTT] isOn is false or device not found for IMEI:", imei);
                return;
            }
        } catch (err) {
            console.error("[MQTT] Error checking isOn state:", err.message);
            return;
        }

        if (topicType === "location") {
            if (Array.isArray(data) && data.length >= 2) {
                const latitude = data[0];
                const longitude = data[1];
                console.log(`[MQTT] Received latitude: ${latitude}, longitude: ${longitude}`);
                await saveLocationToPostgres(imei, latitude, longitude);
            } else {
                console.log("[MQTT] Invalid location data format - expected array [latitude, longitude]");
            }
        } else if (topicType === "battery") {
            if (Array.isArray(data) && data.length >= 1) {
                const batteryLevel = data[0];
                console.log(`[MQTT] Received battery level: ${batteryLevel}`);
                await saveBatteryToPostgres(imei, batteryLevel);
            } else {
                console.log("[MQTT] Invalid battery data format - expected array [batteryLevel]");
            }
        } else {
            console.log("[MQTT] Unknown topic type:", topicType);
        }
    });
}

function startExpressServer() {
    const app = express();
    app.use(bodyParser.json());

    // POST /isOn endpoint
    app.post('/isOn', async (req, res) => {
        const { imei, isOn } = req.body;
        if (!imei || typeof isOn !== 'boolean') {
            return res.status(400).json({ error: 'imei and isOn(boolean) are required' });
        }
        try {
            // Update device isOn
            const [affectedRows] = await Device.update(
                { isOn },
                { where: { imei } }
            );
            if (affectedRows === 0) {
                return res.status(404).json({ error: 'Device not found' });
            }

            // Publish MQTT message to collar/{imei}/isOn
            if (mqttClient && mqttClient.connected) {
                const isOnTopic = `collar/${imei}/isOn`;
                const payload = JSON.stringify(isOn);
                mqttClient.publish(isOnTopic, payload, { retain: true }, (err) => {
                    if (err) {
                        console.error('✗ Failed to publish isOn:', err.message);
                    } else {
                        console.log(`✓ Published isOn to ${isOnTopic} (retained):`, payload);
                    }
                });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('✗ Error in /isOn:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /isWalking endpoint
    app.post('/isWalking', async (req, res) => {
        const { imei, isWalking } = req.body;
        if (!imei || typeof isWalking !== 'boolean') {
            return res.status(400).json({ error: 'imei and isWalking(boolean) are required' });
        }
        try {
            // Update device isWalking
            const [affectedRows] = await Device.update(
                { isWalking },
                { where: { imei } }
            );
            if (affectedRows === 0) {
                return res.status(404).json({ error: 'Device not found' });
            }

            // Publish MQTT message to collar/{imei}/isWalking
            if (mqttClient && mqttClient.connected) {
                const isWalkingTopic = `collar/${imei}/isWalking`;
                const payload = JSON.stringify(isWalking);
                mqttClient.publish(isWalkingTopic, payload, { retain: true }, (err) => {
                    if (err) {
                        console.error('✗ Failed to publish isWalking:', err.message);
                    } else {
                        console.log(`✓ Published isWalking to ${isWalkingTopic} (retained):`, payload);
                    }
                });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('✗ Error in /isWalking:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Start Express server
    const port = process.env.PORT || 3000;
    const host = process.env.API_HOST || 'localhost';
    app.listen(port, host, () => {
        console.log(`\n✓ Express server running on http://${host}:${port}`);
        console.log(`✓ isOn endpoint available at: http://${host}:${port}/isOn`);
        console.log(`✓ isWalking endpoint available at: http://${host}:${port}/isWalking`);
        // Only connect to MQTT after Express is ready
        startMQTTClient();
    });
}