const mqtt = require("mqtt");
const express = require("express");
const bodyParser = require("body-parser");
const Location = require("./models/location");
const Device = require("./models/device");
const Session = require("./models/session");
const mongoose = require("mongoose");

// Explicitly set the database name
require('dotenv').config();
const mongoUri = process.env.MONGO_URI;

// Connect to MongoDB first
mongoose.connect(mongoUri)
    .then(() => {
        console.log("✓ MongoDB connected successfully!");
        console.log("✓ Database: test");
        console.log("✓ Collection: locations");

        // Start Express server
        startExpressServer();
    })
    .catch(err => {
        console.error("✗ MongoDB connection error:", err.message);
        process.exit(1);
    });

let mqttClient = null;

// Function to save location to MongoDB after validation
async function saveLocationToMongo(imei, latitude, longitude) {
    console.log("\n--- Received Data ---");
    console.log("IMEI:", imei);
    console.log("Latitude:", latitude);
    console.log("Longitude:", longitude);

    // Only check device existence and status, not access token
    try {
        const device = await Device.findOne({ imei });
        if (!device) {
            console.log("✗ Device not found in database");
            return false;
        }

        if (!device.isActive) {
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

    const location = new Location({
        collarID: imei,
        latitude,
        longitude
    });

    try {
        await location.save();
        console.log("✓ Location saved successfully to MongoDB!");
        return true;
    } catch (err) {
        console.error("✗ Error saving location:", err.message);
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
        console.log("[MQTT] Message received");
        console.log("[MQTT] Topic:", topic);
        console.log("[MQTT] Raw message:", message.toString());

        const parts = topic.split("/");
        const imei = parts[1];
        console.log("[MQTT] Parsed IMEI:", imei);

        let data;
        try {
            data = JSON.parse(message.toString());
            console.log("[MQTT] Parsed JSON:", data);
            if (typeof data.latitude !== "undefined" && typeof data.longitude !== "undefined") {
                console.log(`[MQTT] Received latitude: ${data.latitude}, longitude: ${data.longitude}`);
            }
        } catch (err) {
            console.log("[MQTT] Invalid JSON format:", err.message);
            return;
        }

        // Check isOn state in MongoDB before saving
        try {
            const session = await Session.findOne({ imei });
            if (!session || !session.isOn) {
                console.log("[MQTT] isOn is false or session not found for IMEI:", imei);
                return;
            }
        } catch (err) {
            console.error("[MQTT] Error checking isOn state:", err.message);
            return;
        }

        // Use the helper function for validation and saving (no accessToken)
        await saveLocationToMongo(imei, data.latitude, data.longitude);
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
            // Upsert session
            await Session.findOneAndUpdate(
                { imei },
                { isOn },
                { upsert: true, new: true }
            );

            // Publish MQTT command to collar/{imei}/command
            if (mqttClient && mqttClient.connected) {
                const commandTopic = `collar/${imei}/command`;
                const payloadObj = { action: isOn ? 'start' : 'stop' };
                const payload = JSON.stringify(payloadObj);
                mqttClient.publish(commandTopic, payload, { retain: true }, (err) => {
                    if (err) {
                        console.error('✗ Failed to publish command:', err.message);
                    } else {
                        console.log(`✓ Published command to ${commandTopic} (retained):`, payload);
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
            // Upsert session
            await Session.findOneAndUpdate(
                { imei },
                { isWalking },
                { upsert: true, new: true }
            );

            // Publish MQTT command to collar/{imei}/command
            if (mqttClient && mqttClient.connected) {
                const commandTopic = `collar/${imei}/command`;
                const payloadObj = { action: "isWalking", value: isWalking };
                const payload = JSON.stringify(payloadObj);
                mqttClient.publish(commandTopic, payload, { retain: true }, (err) => {
                    if (err) {
                        console.error('✗ Failed to publish isWalking command:', err.message);
                    } else {
                        console.log(`✓ Published isWalking command to ${commandTopic} (retained):`, payload);
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
    app.listen(port, () => {
        console.log(`\n✓ Express server running on port ${port}`);
        // Only connect to MQTT after Express is ready
        startMQTTClient();
    });
}