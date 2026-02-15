const mqtt = require("mqtt");
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const Location = require("./models/location");
const Device = require("./models/device");
const Battery = require("./models/battery");
const sequelize = require("./db");
const axios = require("axios");
const readline = require("readline");
const crypto = require("crypto");
const fs = require("fs");
const { execFile } = require("child_process");

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
const sessions = new Map(); // sessionId -> ws connection
const MOSQUITTO_PASSWD_CMD = process.env.MOSQUITTO_PASSWD_CMD || "mosquitto_passwd";
const MOSQUITTO_PASSWD_FILE = process.env.MOSQUITTO_PASSWD_FILE || "D:\\mqtt\\mosquitto_passwords.txt";

function updateMosquittoPassword(username, password) {
  return new Promise((resolve, reject) => {
    const shouldCreate = !fs.existsSync(MOSQUITTO_PASSWD_FILE);
    const args = shouldCreate
      ? ["-c", "-b", MOSQUITTO_PASSWD_FILE, username, password]
      : ["-b", MOSQUITTO_PASSWD_FILE, username, password];

    execFile(MOSQUITTO_PASSWD_CMD, args, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || stdout || error.message));
      }
      resolve();
    });
  });
}

// Utility functions for validation
function validateIMEI(imei) {
  return typeof imei === 'string' && imei.length === 15;
}

function validateCoordinates(latitude, longitude) {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

// Function to save location to PostgreSQL after validation
async function saveLocationToPostgres(imei, latitude, longitude) {
    console.log("\n--- Received Data ---");
    console.log("IMEI:", imei);
    console.log("Latitude:", latitude);
    console.log("Longitude:", longitude);

    // Check device existence and status
    try {
        const device = await Device.findOne({ where: { imei } });
        if (!device) {
            console.log("✗ Device not found in database");
            return false;
        }

        if (!device.is_on) {
            console.log("✗ Device is not active");
            return false;
        }

        // Update last seen
        device.last_seen = new Date();
        await device.save();

    } catch (err) {
        console.error("✗ Device validation error:", err.message);
        return false;
    }

    if (!validateCoordinates(latitude, longitude)) {
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
async function saveBatteryToPostgres(imei, batteryLevel) {
    console.log("\n--- Received Battery Data ---");
    console.log("IMEI:", imei);
    console.log("Battery Level:", batteryLevel);

    // Check device existence and status
    try {
        const device = await Device.findOne({ where: { imei } });
        if (!device) {
            console.log("✗ Device not found in database");
            return false;
        }

        if (!device.is_on) {
            console.log("✗ Device is not active");
            return false;
        }

        // Update last seen
        device.last_seen = new Date();
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
            battery_level: batteryLevel
        });
        console.log("✓ Battery saved successfully");
        return true;
    } catch (err) {
        console.error("✗ Error saving battery:", err.message);
        return false;
    }
}

// Reusable MQTT client setup
function setupMQTTClient() {
  const client = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
  });

  client.on('close', () => {
    console.log('[MQTT] Connection closed');
  });

  return client;
}

// Modularized WebSocket handling
function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      sessionId = generateSessionId();
      console.log(`[WS] New session created: ${sessionId}`);
    } else {
      console.log(`[WS] Resuming session: ${sessionId}`);
    }

    sessions.set(sessionId, ws);
    ws.send(JSON.stringify({ type: 'session', sessionId }));

    ws.on('message', (message) => {
      console.log(`[WS] Message from session ${sessionId}:`, message.toString());
    });

    ws.on('close', () => {
      console.log(`[WS] Session ${sessionId} disconnected`);
      sessions.delete(sessionId);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error for session ${sessionId}:`, err.message);
    });
  });

  return wss;
}

// Modularized Express routes
function setupExpressRoutes(app) {
  app.post('/test-gps', async (req, res) => {
    const {
      appLatitude,
      appLongitude,
      collarLatitude,
      collarLongitude
    } = req.body;

    const valuesAreNumbers = [
      appLatitude,
      appLongitude,
      collarLatitude,
      collarLongitude
    ].every((v) => typeof v === 'number' && Number.isFinite(v));

    if (!valuesAreNumbers) {
      return res.status(400).json({
        error: 'appLatitude, appLongitude, collarLatitude, collarLongitude must be numbers'
      });
    }

    if (!validateCoordinates(appLatitude, appLongitude) || !validateCoordinates(collarLatitude, collarLongitude)) {
      return res.status(400).json({ error: 'Invalid coordinate range' });
    }

    const distanceMeters = calculateDistanceMeters(
      appLatitude,
      appLongitude,
      collarLatitude,
      collarLongitude
    );

    if (distanceMeters < 10) {
      return res.json({
        verified: true,
        message: 'location verified',
        distance_meters: Number(distanceMeters.toFixed(2)),
        threshold_meters: 10
      });
    }

    return res.status(422).json({
      verified: false,
      error: 'location not verified',
      distance_meters: Number(distanceMeters.toFixed(2)),
      threshold_meters: 10
    });
  });

  app.post('/view', async (req, res) => {
    const { imei } = req.body;

    if (!imei) {
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }

    try {
      const device = await Device.findOne({ where: { imei } });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const [latestLocation, latestBattery] = await Promise.all([
        Location.findOne({
          where: { imei },
          order: [['date', 'DESC']]
        }),
        Battery.findOne({
          where: { imei },
          order: [['date', 'DESC']]
        })
      ]);

      if (!latestLocation && !latestBattery) {
        return res.status(404).json({ error: 'No telemetry data found for this IMEI' });
      }

      return res.json({
        imei,
        latitude: latestLocation ? latestLocation.latitude : null,
        longitude: latestLocation ? latestLocation.longitude : null,
        battery_percentage: latestBattery ? latestBattery.battery_level : null,
        location_timestamp: latestLocation ? latestLocation.date : null,
        battery_timestamp: latestBattery ? latestBattery.date : null
      });
    } catch (err) {
      console.error('✗ Error in /view:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/imei', async (req, res) => {
    const { imei } = req.body;

    if (!imei) {
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }

    try {
      const [rows] = await sequelize.query(
        'SELECT id, imei, remark FROM device WHERE imei = :imei LIMIT 1',
        { replacements: { imei } }
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'IMEI not found' });
      }

      const deviceRow = rows[0];
      const currentRemark = String(deviceRow.remark || '').toLowerCase();

      // Make /imei idempotent: always (re)generate credentials and update dynamic-security.
      // Map current remarks to the next remark state; default to 'registered' when empty or unknown.
      let nextRemark = currentRemark;
      if (!currentRemark || currentRemark === '') {
        nextRemark = 'registered';
      } else if (currentRemark === 'unregistered') {
        nextRemark = 'registered';
      } else if (currentRemark === 'degregistered' || currentRemark === 'deregistered') {
        nextRemark = 'reregistered';
      } else if (currentRemark === 'registered') {
        // Device is already registered: treat this as re-registration to refresh credentials
        nextRemark = 'reregistered';
      } else if (currentRemark === 'reregistered') {
        nextRemark = 'reregistered';
      } else {
        // For any other remark, keep it but still attempt to refresh credentials
        nextRemark = currentRemark || 'registered';
      }

      const mqttUsername = imei;
      const mqttPassword = crypto.randomBytes(12).toString('hex');
      const passwordHash = crypto.createHash('sha256').update(mqttPassword).digest('hex');
      const accessToken = crypto.randomBytes(32).toString('hex');


      // Automatically create MQTT user and assign role in Mosquitto Dynamic Security
      try {
        await defineMosquittoUser(mqttUsername, mqttPassword);
        console.log(`✓ MQTT credentials configured for ${mqttUsername}`);
      } catch (dynsecError) {
        console.error('✗ Failed to configure MQTT user:', dynsecError.message);
        return res.status(500).json({ error: 'Failed to configure MQTT credentials' });
      }

      await sequelize.query(
        `UPDATE device
         SET remark = :remark, password_hash = :passwordHash, access_token = :accessToken
         WHERE id = :id`,
        {
          replacements: {
            remark: nextRemark,
            passwordHash,
            accessToken,
            id: deviceRow.id
          }
        }
      );

      return res.json({
        success: true,
        imei,
        remark: nextRemark,
        mqtt_username: mqttUsername,
        mqtt_password: mqttPassword,
        access_token: accessToken
      });
    } catch (err) {
      console.error('✗ Error in /imei:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/isOn', async (req, res) => {
    const { imei, isOn } = req.body;
    
    if (!imei) {
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }
    if (typeof isOn !== 'boolean') {
      return res.status(400).json({ error: 'isOn must be a boolean (true or false)' });
    }

    try {
      const [updated] = await Device.update({ is_on: isOn }, { where: { imei } });
      if (!updated) {
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

  app.post('/isWalking', async (req, res) => {
    const { imei, isWalking } = req.body;
    
    if (!imei) {
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }
    if (typeof isWalking !== 'boolean') {
      return res.status(400).json({ error: 'isWalking must be a boolean (true or false)' });
    }

    try {
      const [updated] = await Device.update({ is_walking: isWalking }, { where: { imei } });
      if (!updated) {
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
}

function startExpressServer() {
    const app = express();
    app.use(bodyParser.json());

    setupExpressRoutes(app);

    // Start Express server
    const port = process.env.PORT || 3000;
    const host = process.env.API_HOST || 'localhost';
    const server = app.listen(port, host, () => {
        console.log(`\n✓ Express server running on http://${host}:${port}`);
        console.log(`✓ GPS test endpoint available at: http://${host}:${port}/test-gps`);
        console.log(`✓ View endpoint available at: http://${host}:${port}/view`);
        console.log(`✓ IMEI endpoint available at: http://${host}:${port}/imei`);
        console.log(`✓ isOn endpoint available at: http://${host}:${port}/isOn`);
        console.log(`✓ isWalking endpoint available at: http://${host}:${port}/isWalking`);
        // Start WebSocket server
        startWebSocketServer(server);
        // Only connect to MQTT after Express is ready
        startMQTTClient();
    });
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

    mqttClient.on('message', async (topic, message) => {
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

        if (topicType === "location") {
            if (Array.isArray(data) && data.length >= 2) {
                const latitude = data[0];
                const longitude = data[1];
                console.log(`[MQTT] Received latitude: ${latitude}, longitude: ${longitude}`);
                const saved = await saveLocationToPostgres(imei, latitude, longitude);
                if (saved) {
                    broadcastToSessions({
                        type: 'location',
                        imei,
                        latitude,
                        longitude,
                        timestamp: new Date()
                    });
                }
            } else {
                console.log("[MQTT] Invalid location data format - expected array [latitude, longitude]");
            }
        } else if (topicType === "battery") {
            if (Array.isArray(data) && data.length >= 1) {
                const batteryLevel = data[0];
                console.log(`[MQTT] Received battery level: ${batteryLevel}`);
                const saved = await saveBatteryToPostgres(imei, batteryLevel);
                if (saved) {
                    broadcastToSessions({
                        type: 'battery',
                        imei,
                        batteryLevel,
                        timestamp: new Date()
                    });
                }
            } else {
                console.log("[MQTT] Invalid battery data format - expected array [batteryLevel]");
            }
        } else {
            console.log("[MQTT] Unknown topic type:", topicType);
        }
    });
}

function startWebSocketServer(server) {
    const wss = setupWebSocketServer(server);
    console.log("✓ WebSocket server initialized");
}

function generateSessionId() {
    return 'session_' + Math.random().toString(36).substr(2, 9);
}

function broadcastToSessions(data) {
    sessions.forEach((ws, sessionId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        } else {
            // Remove stale connections
            sessions.delete(sessionId);
        }
    });
}

// Start the isLost listener
function startIsLostListener() {
    const client = setupMQTTClient();

    const topic = `collar/+/isLost`; // Use wildcard to listen for all IMEIs

    client.on("connect", () => {
        console.log(`Connected to MQTT broker at mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
        client.subscribe(topic, (err) => {
            if (err) {
                console.error("✗ Subscribe failed:", err.message);
            } else {
                console.log(`✓ Subscribed to topic: ${topic}`);
            }
        });
    });

    client.on("message", async (topic, message) => {
        try {
            const imei = topic.split("/")[1]; // Extract IMEI from the topic
            let isLost;
            try {
                isLost = JSON.parse(message.toString());
            } catch {
                isLost = message.toString() === "true";
            }
            console.log(`Received isLost status for IMEI ${imei}: ${isLost}`);
            if (isLost) {
                try {
                    await axios.post(APP_API_URL, { imei, isLost });
                    console.log(`Notified app of isLost status for IMEI ${imei}`);
                } catch (error) {
                    console.error("Error notifying app API:", error.message);
                }
            }
        } catch (e) {
            console.error("✗ Error parsing message:", e.message);
        }
    });

    client.on("error", (err) => {
        console.error("✗ MQTT Connection Error:", err.message);
    });

    client.on("offline", () => {
        console.log("⚠ MQTT client offline, attempting to reconnect...");
    });

    client.on("reconnect", () => {
        console.log("⟳ Reconnecting to MQTT broker...");
    });

    process.on("SIGINT", () => {
        console.log("\n\n✓ Disconnecting from MQTT broker...");
        client.end(true);
        process.exit(0);
    });
}

const APP_API_URL = process.env.APP_API_URL || `http://${process.env.DUMMY_APP_HOST}:${process.env.DUMMY_APP_PORT}/isLost`;

startIsLostListener();
