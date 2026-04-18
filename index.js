require('./logger');
const mqtt = require("mqtt");
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const Location = require("./models/location");
const Device = require("./models/device");
const Battery = require("./models/battery");
const sequelize = require("./db");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// Load environment variables
require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'NEON_DB_URL',
  'MOSQUITTO_ADMIN_USER',
  'MOSQUITTO_ADMIN_PASS',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('✗ Missing required environment variables:', missingVars.join(', '));
  console.error('✗ Please check your .env file or environment configuration');
  process.exit(1);
}

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
// Recent MQTT messages cache to suppress near-duplicate deliveries
const recentMessages = new Map(); // key -> timestamp

// Dynamic Security configuration from environment
const MOSQUITTO_ADMIN_USER = process.env.MOSQUITTO_ADMIN_USER ;
const MOSQUITTO_ADMIN_PASS = process.env.MOSQUITTO_ADMIN_PASS ;
const DYNAMIC_SECURITY_FILE = path.resolve(process.env.DYNAMIC_SECURITY_FILE || 'dynamic-security.json');

// Helper to run a single mosquitto_ctrl command as a promise
function dynsecCmd(cmd) {
  const mqttHost = process.env.MQTT_HOST || 'localhost';
  const mqttPort = process.env.MQTT_PORT || '1883';
  const full = `mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${MOSQUITTO_ADMIN_USER} -P ${MOSQUITTO_ADMIN_PASS} ${cmd}`;
  return new Promise((resolve, reject) => {
    exec(full, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// Helper to automate mosquitto_ctrl user+role assignment
const defineMosquittoUser = async (username, password) => {
  const deviceRoleName = `device_${username}`;

  // 1. Delete client if exists (ignore errors)
  console.log(`[DYNSEC] Deleting client if exists: ${username}`);
  await dynsecCmd(`dynsec deleteClient ${username}`).catch(() => {});

  // 2. Delete per-device role if exists (ignore errors)
  await dynsecCmd(`dynsec deleteRole ${deviceRoleName}`).catch(() => {});

  // 3. Create client with new password
  console.log(`[DYNSEC] Creating client: ${username}`);
  await dynsecCmd(`dynsec createClient ${username} -p ${password}`);
  console.log(`✓ MQTT client ${username} created with new password`);

  // 4. Assign shared deviceRole (publish permissions)
  await dynsecCmd(`dynsec addClientRole ${username} deviceRole`);
  console.log(`✓ MQTT user ${username} assigned to deviceRole`);

  // 5. Create per-device role with subscribeLiteral ACLs
  //    (subscribePattern %u is broken in this Mosquitto build)
  await dynsecCmd(`dynsec createRole ${deviceRoleName}`);
  const subTopics = [
    `collar/${username}/isOn`,
    `collar/${username}/isWalking`,
    `collar/${username}/isLost`
  ];
  for (const topic of subTopics) {
    await dynsecCmd(`dynsec addRoleACL ${deviceRoleName} subscribeLiteral ${topic} allow`);
  }

  // 6. Assign per-device role to client
  await dynsecCmd(`dynsec addClientRole ${username} ${deviceRoleName}`);
  console.log(`✓ MQTT user ${username} assigned to ${deviceRoleName} (subscribe permissions)`);

  // Clean up .new file that Mosquitto leaves behind on Windows
  setTimeout(() => mergeDynsecNewFile(), 1500);
};

/**
 * Mosquitto dynamic security plugin on Windows often writes changes to a .new
 * file but fails to rename it over the original. This helper merges it automatically.
 */
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

// Utility functions for validation
function validateIMEI(imei) {
  return typeof imei === 'string' && /^\d{15}$/.test(imei);
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 't') return true;
    if (v === 'false' || v === '0' || v === 'f') return false;
  }
  return false;
}

/** Payload on `collar/{imei}/isLost` may be boolean, JSON string, or `{"isLost":true}` object. */
function parseMqttIsLostPayload(data) {
  if (typeof data === 'boolean') return data;
  if (typeof data === 'number') return data === 1;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    if (Object.prototype.hasOwnProperty.call(data, 'isLost')) {
      return normalizeBoolean(data.isLost);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'lost')) {
      return normalizeBoolean(data.lost);
    }
  }
  if (typeof data === 'string') {
    const t = data.trim();
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t);
        return parseMqttIsLostPayload(o);
      } catch (e) { /* fall through */ }
    }
    const cleaned = t.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
    if (cleaned === 'true' || cleaned === '1') return true;
    if (cleaned === 'false' || cleaned === '0') return false;
  }
  return normalizeBoolean(data);
}

// Derive a deterministic, fixed-length device password from IMEI and access token.
// Uses HMAC-SHA256 keyed by accessToken over imei, encodes as base64url, then truncates.
function deriveDevicePassword(imei, accessToken, length = 10) {
  const h = crypto.createHmac('sha256', accessToken).update(imei).digest('base64');
  const b64url = h.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64url.slice(0, length);
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

/**
 * Validate device exists, is active, and update last_seen.
 * Returns the device instance on success, or null on failure.
 */
async function validateAndTouchDevice(imei) {
    try {
        const device = await Device.findOne({ where: { imei } });
        if (!device) {
            console.log("✗ Device not found in database");
            return null;
        }
    // Allow storing telemetry even when device reports `is_on` = false.
    // Previously this returned null when device was not active,
    // preventing location/battery records from being saved.
    device.last_seen = new Date();
    await device.save();
    return device;
    } catch (err) {
        console.error("✗ Device validation error:", err.message);
        return null;
    }
}

// Function to save location to PostgreSQL after validation
async function saveLocationToPostgres(imei, latitude, longitude, altitude, speed, timestamp) {
    console.log("\n--- Received Data ---");
    console.log("IMEI:", imei);
    console.log("Latitude:", latitude);
    console.log("Longitude:", longitude);
    console.log("Altitude:", altitude);
    console.log("Speed:", speed);
    console.log("Timestamp:", timestamp);

    const device = await validateAndTouchDevice(imei);
    if (!device) return false;

    if (!validateCoordinates(latitude, longitude)) {
        console.log("✗ Invalid coordinate range");
        return false;
    }

    try {
        await Location.create({
            imei: imei,
            latitude,
            longitude,
            altitude,
            speed,
            timestamp
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

    const device = await validateAndTouchDevice(imei);
    if (!device) return false;

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
  // Health check endpoint for AWS ALB/ECS
  app.get('/health', async (req, res) => {
    const health = {
      uptime: process.uptime(),
      timestamp: Date.now(),
      status: 'ok'
    };

    // Check MQTT connection
    if (!mqttClient || !mqttClient.connected) {
      health.mqtt = 'disconnected';
      health.status = 'degraded';
    } else {
      health.mqtt = 'connected';
    }

    // Check database connection
    try {
      await sequelize.authenticate();
      health.database = 'connected';
      res.status(health.status === 'ok' ? 200 : 503).json(health);
    } catch (err) {
      health.database = 'disconnected';
      health.status = 'unhealthy';
      res.status(503).json(health);
    }
  });

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

  async function handleCollarView(req, res) {
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

      const [recentLocationsDesc, batteries, latestLocation, latestBattery] = await Promise.all([
        Location.findAll({
          where: { imei },
          order: [['date', 'DESC']],
          limit: VIEW_LOCATION_HISTORY_LIMIT
        }),
        Battery.findAll({ where: { imei }, order: [['date', 'ASC']] }),
        Location.findOne({ where: { imei }, order: [['date', 'DESC']] }),
        Battery.findOne({ where: { imei }, order: [['date', 'DESC']] })
      ]);

      const locations = [...recentLocationsDesc].reverse();

      if ((locations.length === 0) && (batteries.length === 0)) {
        return res.status(404).json({ error: 'No telemetry data found for this IMEI' });
      }

      return res.json({
        imei,
        device: {
          isOn: normalizeBoolean(device.is_on),
          isWalking: normalizeBoolean(device.is_walking),
          lastSeen: device.last_seen,
          isLost: normalizeBoolean(device.is_lost)
        },
        locations: locations.map(l => ({ 
          latitude: l.latitude, 
          longitude: l.longitude, 
          altitude: l.altitude,
          speed: l.speed,
          device_timestamp: l.timestamp,
          server_timestamp: l.date 
        })),
        batteries: batteries.map(b => ({ battery_percentage: b.battery_level, timestamp: b.date })),
        latest: {
          latitude: latestLocation ? latestLocation.latitude : null,
          longitude: latestLocation ? latestLocation.longitude : null,
          altitude: latestLocation ? latestLocation.altitude : null,
          speed: latestLocation ? latestLocation.speed : null,
          device_timestamp: latestLocation ? latestLocation.timestamp : null,
          location_server_timestamp: latestLocation ? latestLocation.date : null,
          battery_percentage: latestBattery ? latestBattery.battery_level : null,
          battery_timestamp: latestBattery ? latestBattery.date : null
        }
      });
    } catch (err) {
      console.error('✗ Error in /view:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  app.post('/view', handleCollarView);
  app.post('/imei/view', handleCollarView);

  app.post('/latest', async (req, res) => {
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
        Location.findOne({ where: { imei }, order: [['date', 'DESC']] }),
        Battery.findOne({ where: { imei }, order: [['date', 'DESC']] })
      ]);

      return res.json({
        imei,
        isLost: normalizeBoolean(device.is_lost),
        isWalking: normalizeBoolean(device.is_walking),
        latitude: latestLocation ? latestLocation.latitude : null,
        longitude: latestLocation ? latestLocation.longitude : null,
        battery: latestBattery ? latestBattery.battery_level : null,
        locationTimestamp: latestLocation ? latestLocation.date : null,
        batteryTimestamp: latestBattery ? latestBattery.date : null
      });
    } catch (err) {
      console.error('Error in /latest:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/imei', async (req, res) => {
    const { imei } = req.body;

    console.log('[\/imei] Request received:', { body: req.body, ip: req.ip, time: new Date().toISOString() });

    if (!imei) {
      console.log('[/imei] ✗ IMEI missing in request body');
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      console.log('[/imei] ✗ Invalid IMEI format:', imei);
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }

    try {
      const [rows] = await sequelize.query(
        'SELECT id, imei, remark, password_hash, access_token FROM device WHERE imei = :imei LIMIT 1',
        { replacements: { imei } }
      );

      console.log(`[/imei] DB query returned ${rows.length} row(s)`);

      let deviceRow = null;
      let currentRemark = '';
      let isNewDevice = false;

      if (!rows.length) {
        // Treat a missing IMEI as a new, unregistered device
        isNewDevice = true;
        currentRemark = '';
      } else {
        deviceRow = rows[0];
        currentRemark = String(deviceRow.remark || '').toLowerCase();
      }

      console.log('[/imei] deviceRow:', deviceRow ? { id: deviceRow.id, imei: deviceRow.imei, remark: deviceRow.remark } : null);

      // Map current remarks to the next remark state; default to 'unregistered' when empty or unknown.
      let nextRemark = currentRemark;
      if (!currentRemark || currentRemark === '') {
        // If remark is empty, treat it as already registered to avoid
        // a two-step credential generation (blank -> unregistered -> registered).
        // Generate credentials once and mark as 'registered'.
        nextRemark = 'registered';
      } else if (currentRemark === 'unregistered') {
        nextRemark = 'registered';
      } else if (currentRemark === 'deregistered') {
        nextRemark = 'reregistered';
      } else if (currentRemark === 'registered') {
        // Keep registered devices as 'registered' (do not move to reregistered)
        nextRemark = 'registered';
      } else if (currentRemark === 'reregistered') {
        nextRemark = 'reregistered';
      } else {
        nextRemark = currentRemark || 'unregistered';
      }

      // Decide whether to generate new credentials.
      // Only generate when the device is new OR currently 'unregistered' OR 'deregistered'.
      // Keep existing credentials for 'registered' and 'reregistered' devices.
      const shouldGenerateCredentials = isNewDevice || ['unregistered', 'deregistered'].includes(currentRemark);

      console.log(`[/imei] isNewDevice=${isNewDevice}, currentRemark='${currentRemark}', shouldGenerateCredentials=${shouldGenerateCredentials}`);

      const mqttUsername = imei;
      let passwordHash = deviceRow ? deviceRow.password_hash : null;
      let accessToken = deviceRow ? deviceRow.access_token : null;
      let generatedNewCredentials = false;

      // Generate a new access_token only when appropriate (new/unregistered/deregistered)
      // or when an access_token is missing in the DB.
      if (shouldGenerateCredentials || !accessToken) {
        accessToken = crypto.randomBytes(32).toString('hex');
        generatedNewCredentials = true;
        console.log('[/imei] Generated new access_token (hidden)');
      }

      // Deterministic MQTT password (10 chars) derived from IMEI + access_token
      const mqttPassword = deriveDevicePassword(imei, accessToken, 10);
      console.log(`[/imei] Derived mqtt_password (10 chars)='${mqttPassword}' for imei=${imei}`);
      passwordHash = crypto.createHash('sha256').update(mqttPassword).digest('hex');

      // If device didn't exist, create it now using the determined credentials (generated or placeholders)
      if (isNewDevice) {
        // Creation of new device rows is disabled per request.
        // The original code inserted a new row here when an IMEI was not found:
        /*
        try {
          const insertReplacements = {
            imei,
            remark: nextRemark,
            passwordHash,
            accessToken
          };
          // Use RETURNING to get the inserted row (Postgres)
          const [inserted] = await sequelize.query(
            `INSERT INTO device (imei, remark, password_hash, access_token, is_on, is_walking, last_seen, created_at)
             VALUES (:imei, :remark, :passwordHash, :accessToken, false, false, NULL, NOW())
             RETURNING id, imei, remark, password_hash, access_token`,
            { replacements: insertReplacements }
          );
          deviceRow = inserted[0];
        } catch (insertErr) {
          console.error('✗ Failed to create new device row:', insertErr.message);
          return res.status(500).json({ error: 'Failed to create device record' });
        }
        */
        // Leaving deviceRow as null for missing IMEIs
        // Return error for new/unregistered devices
        console.log('✗ IMEI not found in database - device must be registered first');
        return res.status(404).json({ error: 'Device not found. IMEI must be registered in the database first.' });
      }


      // (Re)create MQTT user when we generated new credentials so the broker
      // has an up-to-date client entry in the dynamic security plugin.
      if (generatedNewCredentials) {
        console.log(`[/imei] Calling defineMosquittoUser for ${mqttUsername}`);
        try {
          await defineMosquittoUser(mqttUsername, mqttPassword);
          console.log(`[/imei] ✓ MQTT credentials configured for ${mqttUsername}`);
        } catch (dynsecError) {
          console.error('[/imei] ✗ Failed to configure MQTT user:', dynsecError.message);
          return res.status(500).json({ error: 'Failed to configure MQTT credentials' });
        }
      } else {
        console.log('[/imei] [DYNSEC] Skipping mosquitto user creation - credentials unchanged');
      }

      // Persist changes: if new credentials were generated, update password_hash and access_token.
      try {
        if (!isNewDevice) {
          if (generatedNewCredentials) {
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
            console.log('[/imei] Updated device row with new credentials');
          } else {
            await sequelize.query(
              `UPDATE device
               SET remark = :remark
               WHERE id = :id`,
              {
                replacements: {
                  remark: nextRemark,
                  id: deviceRow.id
                }
              }
            );
            console.log('[/imei] Updated device remark only');
          }
        }
      } catch (dbErr) {
        console.error('✗ Failed to update device record:', dbErr.message);
        return res.status(500).json({ error: 'Failed to update device record' });
      }

      const resp = {
        success: true,
        imei,
        remark: nextRemark,
        mqtt_username: mqttUsername,
        mqtt_password: mqttPassword,
        access_token: accessToken
      };
      console.log('[/imei] Responding with:', { imei: resp.imei, remark: resp.remark, mqtt_username: resp.mqtt_username, mqtt_password: resp.mqtt_password });
      return res.json(resp);
    } catch (err) {
      console.error('✗ Error in /imei:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // /refresh-mqtt endpoint removed: MQTT credential refresh is now handled
  // via the idempotent /imei handler which always (re)generates credentials.

  app.post('/isOn', async (req, res) => {
    console.log('\n[/isOn] Request received:', req.body);
    const { imei, isOn } = req.body;
    
    if (!imei) {
      console.log('[/isOn] ✗ IMEI missing in request');
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      console.log('[/isOn] ✗ Invalid IMEI format:', imei);
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }
    if (typeof isOn !== 'boolean') {
      console.log('[/isOn] ✗ isOn must be boolean, got:', typeof isOn, isOn);
      return res.status(400).json({ error: 'isOn must be a boolean (true or false)' });
    }

    console.log(`[/isOn] Processing for IMEI: ${imei}, isOn: ${isOn}`);

    try {
      const [updated] = await Device.update({ is_on: isOn }, { where: { imei } });
      if (!updated) {
        console.log('[/isOn] ✗ Device not found in database:', imei);
        return res.status(404).json({ error: 'Device not found' });
      }
      
      console.log(`[/isOn] ✓ Database updated for ${imei}`);

      // Publish MQTT message to collar/{imei}/isOn
      console.log(`\n[/isOn PUBLISH] ========================================`);
      console.log(`[/isOn PUBLISH] Checking MQTT client status...`);
      console.log(`[/isOn PUBLISH] mqttClient exists: ${!!mqttClient}`);
      console.log(`[/isOn PUBLISH] mqttClient.connected: ${mqttClient ? mqttClient.connected : 'N/A'}`);
      
      if (mqttClient && mqttClient.connected) {
        const isOnTopic = `collar/${imei}/isOn`;
        const payload = JSON.stringify(isOn);
        console.log(`[/isOn PUBLISH] ✓ MQTT client is connected`);
        console.log(`[/isOn PUBLISH] Topic: ${isOnTopic}`);
        console.log(`[/isOn PUBLISH] Payload: ${payload}`);
        console.log(`[/isOn PUBLISH] Retain: true`);
        console.log(`[/isOn PUBLISH] 🚀 Publishing now...`);
        
        mqttClient.publish(isOnTopic, payload, { retain: true }, (err) => {
          if (err) {
            console.error('[/isOn PUBLISH] ✗✗✗ PUBLISH FAILED:', err.message);
            console.error('[/isOn PUBLISH] Error details:', err);
          } else {
            console.log(`[/isOn PUBLISH] ✓✓✓ SUCCESSFULLY PUBLISHED to ${isOnTopic}`);
            console.log(`[/isOn PUBLISH] Message is retained and should be received by subscribers`);
          }
        });
      } else {
        console.log('[/isOn PUBLISH] ✗✗✗ MQTT client NOT CONNECTED!');
        console.log('[/isOn PUBLISH] Status:', mqttClient ? 'exists but disconnected' : 'null');
      }
      console.log(`[/isOn PUBLISH] ========================================\n`);

      broadcastToSessions({
        type: 'isOn',
        imei,
        isOn,
        timestamp: new Date()
      });

      console.log('[/isOn] Sending success response\n');
      res.json({ success: true });
    } catch (err) {
      console.error('[/isOn] ✗ Error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/isWalking', async (req, res) => {
    console.log('\n[/isWalking] Request received:', req.body);
    const { imei, isWalking } = req.body;
    
    if (!imei) {
      console.log('[/isWalking] ✗ IMEI missing in request');
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      console.log('[/isWalking] ✗ Invalid IMEI format:', imei);
      return res.status(400).json({ error: 'IMEI must be a 15-character string' });
    }
    if (typeof isWalking !== 'boolean') {
      console.log('[/isWalking] ✗ isWalking must be boolean, got:', typeof isWalking, isWalking);
      return res.status(400).json({ error: 'isWalking must be a boolean (true or false)' });
    }

    console.log(`[/isWalking] Processing for IMEI: ${imei}, isWalking: ${isWalking}`);

    try {
      const [updated] = await Device.update({ is_walking: isWalking }, { where: { imei } });
      if (!updated) {
        console.log('[/isWalking] ✗ Device not found in database:', imei);
        return res.status(404).json({ error: 'Device not found' });
      }
      
      console.log(`[/isWalking] ✓ Database updated for ${imei}`);

      // Publish MQTT message to collar/{imei}/isWalking
      if (mqttClient && mqttClient.connected) {
        console.log(`[/isWalking] MQTT client connected, publishing...`);
        const isWalkingTopic = `collar/${imei}/isWalking`;
        const payload = JSON.stringify(isWalking);
        mqttClient.publish(isWalkingTopic, payload, { retain: true }, (err) => {
          if (err) {
            console.error('[/isWalking] ✗ Failed to publish to MQTT:', err.message);
          } else {
            console.log(`[/isWalking] ✓ Published to ${isWalkingTopic} (retained): ${payload}`);
          }
        });
      } else {
        console.log('[/isWalking] ✗ MQTT client not connected! Status:', mqttClient ? 'exists but disconnected' : 'null');
      }

      broadcastToSessions({
        type: 'isWalking',
        imei,
        isWalking,
        timestamp: new Date()
      });

      console.log('[/isWalking] Sending success response\n');
      res.json({ success: true });
    } catch (err) {
      console.error('[/isWalking] ✗ Error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

function startExpressServer() {
    const app = express();
    
    // Limit request body size to prevent DoS attacks
    app.use(bodyParser.json({ limit: '1mb' }));
    
    // Trust proxy for correct client IPs behind ALB
    app.set('trust proxy', true);

    setupExpressRoutes(app);

    // Start Express server
    const port = process.env.PORT || 3000;
    // Use 0.0.0.0 to listen on all interfaces in container environments
    const host = process.env.API_HOST || '0.0.0.0';
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
    console.log("\n" + "=".repeat(60));
    console.log("[MQTT BACKEND] Initializing MQTT Client Connection");
    console.log("=".repeat(60));
    console.log("[MQTT BACKEND] Broker:", `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
    console.log("[MQTT BACKEND] Username:", process.env.MQTT_USERNAME);
    console.log("[MQTT BACKEND] Password:", process.env.MQTT_PASSWORD ? '***' + process.env.MQTT_PASSWORD.slice(-4) : 'NOT SET');
    console.log("=".repeat(60) + "\n");
    
    mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`, {
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        console.log("\n" + "*".repeat(60));
        console.log("[MQTT BACKEND] ✓✓✓ Successfully Connected to Broker ✓✓✓");
        console.log("[MQTT BACKEND] Client ID:", mqttClient.options.clientId);
        console.log("*".repeat(60) + "\n");
        
        console.log("[MQTT BACKEND] Subscribing to: collar/+/location");
        mqttClient.subscribe("collar/+/location", (err, granted) => {
            if (err) {
                console.error("[MQTT BACKEND] ✗ Subscribe error (location):", err.message);
            } else {
                console.log("[MQTT BACKEND] ✓ Subscribed to: collar/+/location", granted);
            }
        });
        
        console.log("[MQTT BACKEND] Subscribing to: collar/+/battery");
        mqttClient.subscribe("collar/+/battery", (err, granted) => {
            if (err) {
                console.error("[MQTT BACKEND] ✗ Subscribe error (battery):", err.message);
            } else {
                console.log("[MQTT BACKEND] ✓ Subscribed to: collar/+/battery", granted);
            }
        });
        
        console.log("[MQTT BACKEND] Subscribing to: collar/+/isLost");
        mqttClient.subscribe("collar/+/isLost", (err, granted) => {
            if (err) {
                console.error("[MQTT BACKEND] ✗ Subscribe error (isLost):", err.message);
            } else {
                console.log("[MQTT BACKEND] ✓ Subscribed to: collar/+/isLost", granted);
            }
        });
        console.log("[MQTT BACKEND] ⏳ Waiting for messages...\n");
    });

    mqttClient.on('reconnect', () => {
        console.log("[MQTT BACKEND] ⟳ Reconnecting to broker...");
    });

    mqttClient.on('close', () => {
        console.log("[MQTT BACKEND] ✗ Connection closed");
    });

    mqttClient.on('offline', () => {
        console.log("[MQTT BACKEND] ⚠ Client is offline");
    });

    mqttClient.on('error', (err) => {
        console.error("[MQTT BACKEND] ✗✗✗ ERROR:", err.message);
        console.error("[MQTT BACKEND] Error code:", err.code);
        console.error("[MQTT BACKEND] Full error:", err);
    });

    mqttClient.on('message', async (topic, message, packet) => {
      console.log("[MQTT] Message received");
      console.log("[MQTT] Topic:", topic);
      console.log("[MQTT] Raw message:", message.toString());
      // Log packet metadata (helps diagnose duplicate deliveries)
      try {
        console.log('[MQTT] Packet info:', {
          messageId: packet && packet.messageId,
          qos: packet && packet.qos,
          dup: packet && packet.dup,
          retain: packet && packet.retain
        });
      } catch (e) {}

      // Simple de-duplication: ignore identical messages on the same topic
      // if received within 1 second of the previous identical payload.
      try {
        const payload = message.toString();
        const key = `${topic}|${payload}`;
        const now = Date.now();
        const last = recentMessages.get(key) || 0;
        if (now - last < 1000) {
          console.log('[MQTT] ✗ Ignoring near-duplicate message for', topic);
          return;
        }
        recentMessages.set(key, now);
        // schedule cleanup
        setTimeout(() => recentMessages.delete(key), 5000);
      } catch (e) {}

        const parts = topic.split("/");
        if (parts.length !== 3 || parts[0] !== "collar") {
            console.log("[MQTT] Ignoring unexpected topic structure:", topic);
            return;
        }
        const imei = parts[1];
        const topicType = parts[2];
        console.log("[MQTT] Parsed IMEI:", imei);
        console.log("[MQTT] Topic type:", topicType);

        const rawMessage = message.toString();
        let data;
        try {
            data = JSON.parse(rawMessage);
            console.log("[MQTT] Parsed as JSON:", data);
        } catch (err) {
            // Not valid JSON - will be handled by individual topic handlers
            data = rawMessage;
            console.log("[MQTT] Not JSON, using raw string:", data);
        }

        if (topicType === "location") {
            let latitude, longitude, altitude, speed, timestamp;
            
            if (Array.isArray(data) && data.length >= 2) {
                latitude = data[0];
                longitude = data[1];
            } else if (typeof data === 'object' && data !== null) {
                latitude = data.lat;
                longitude = data.lng;
                altitude = data.alt;
                speed = data.speed;
                timestamp = data.ts;
            }
            
            if (typeof latitude === 'number' && typeof longitude === 'number') {
                console.log(`[MQTT] Received latitude: ${latitude}, longitude: ${longitude}, altitude: ${altitude}, speed: ${speed}, timestamp: ${timestamp}`);
                const saved = await saveLocationToPostgres(imei, latitude, longitude, altitude, speed, timestamp);
                if (saved) {
                    broadcastToSessions({
                        type: 'location',
                        imei,
                        latitude,
                        longitude,
                        altitude,
                        speed,
                        timestamp,
                        date: new Date()
                    });
                }
            } else {
                console.log("[MQTT] Invalid location data format - expected array [latitude, longitude] or object with lat/lng properties");
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
        } else if (topicType === "isLost") {
            const isLost = parseMqttIsLostPayload(data);
            console.log(`[MQTT] Received isLost status for IMEI ${imei}: ${isLost} (raw type: ${typeof data})`);
            const [updated] = await Device.update({ is_lost: isLost }, { where: { imei } });
            if (!updated) {
                console.error(`[MQTT] Device ${imei} not found while updating is_lost`);
                return;
            }
            console.log(`[MQTT] Updated device.is_lost for IMEI ${imei} to ${isLost}`);

            const wsPayload = {
                type: 'isLost',
                imei,
                isLost,
                timestamp: new Date()
            };
            broadcastToSessions(wsPayload);
            console.log(`[MQTT] WS broadcast isLost → ${sessions.size} session(s):`, JSON.stringify(wsPayload));

            if (isLost) {
                try {
                    // Fetch device access token from database
                    const device = await Device.findOne({ where: { imei } });
                    if (!device || !device.access_token) {
                        console.error(`[MQTT] Device ${imei} not found or has no access token`);
                        return;
                    }
                    
                    await axios.post(APP_API_URL, { 
                        imei, 
                        isLost,
                        accessToken: device.access_token 
                    });
                    console.log(`[MQTT] Notified app API of isLost for IMEI ${imei}`);
                } catch (error) {
                    console.error("[MQTT] Error notifying app API:", error.message);
                }
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

const APP_API_URL = process.env.APP_API_URL
  || `http://${process.env.DUMMY_APP_HOST || 'localhost'}:${process.env.DUMMY_APP_PORT || '3001'}/isLost`;

// Graceful shutdown handler for AWS ECS/EKS (SIGTERM) and local development (SIGINT)
const gracefulShutdown = (signal) => {
  console.log(`\n\n✓ Received ${signal}, shutting down gracefully...`);
  
  // Close MQTT connection
  if (mqttClient) {
    console.log('✓ Closing MQTT connection...');
    mqttClient.end(true);
  }
  
  // Close database connection
  sequelize.close()
    .then(() => {
      console.log('✓ Database connection closed');
      console.log('✓ Graceful shutdown complete');
      process.exit(0);
    })
    .catch(err => {
      console.error('✗ Error closing database:', err.message);
      process.exit(1);
    });
  
  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('✗ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

// Handle both SIGTERM (AWS) and SIGINT (Ctrl+C)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
