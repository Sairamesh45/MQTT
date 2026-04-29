require('./logger');
const mqtt = require("mqtt");
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const { QueryTypes } = require("sequelize");
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
// DB: either DB_HOST (AWS Aurora) or NEON_DB_URL (Neon) must be set — checked inside db.js
const requiredEnvVars = [
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

if (!process.env.DATABASE_HOST && !process.env.DB_HOST && !process.env.NEON_DB_URL) {
  console.error('✗ No database config: set DATABASE_HOST (AWS Aurora) or NEON_DB_URL (Neon) in .env');
  process.exit(1);
}

// Connect to PostgreSQL — no sync (schema is owned by NestJS migrations)
sequelize.authenticate()
    .then(() => {
        console.log("✓ PostgreSQL connected successfully!");
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

// Optional: set DEVICE_REGISTER_KEY to require x-register-key header for auto-creating new devices.
// Leave unset (or empty) to allow open registration.
const DEVICE_REGISTER_KEY = process.env.DEVICE_REGISTER_KEY || null;

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
    `collar/${username}/isLost`,
    `collar/${username}/ota/command`,
    FLEET_OTA_COMMAND_TOPIC
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

/**
 * Calculate battery percentage from voltage (mV) using Li-ion 1S curve.
 * Optimized for pet collar devices with load variations.
 * 
 * @param {number} voltageMv - Battery voltage in millivolts (e.g., 4226)
 * @returns {number} Battery percentage (0-100)
 */
function calculateBatteryPercentage(voltageMv) {
  const voltage = voltageMv / 1000; // Convert mV to V

  // Clamp to valid Li-ion range
  if (voltage >= 4.10) return 100;
  if (voltage <= 2.80) return 0;

  // Use nonlinear Li-ion discharge curve for accuracy
  // Based on typical Li-ion 1S (3.7V nominal, 4.1V full, 2.8V cutoff) characteristics
  const voltageMap = [
    { v: 4.10, p: 100 },
    { v: 4.05, p: 95 },
    { v: 4.00, p: 90 },
    { v: 3.95, p: 85 },
    { v: 3.90, p: 80 },
    { v: 3.85, p: 75 },
    { v: 3.80, p: 70 },
    { v: 3.75, p: 65 },
    { v: 3.70, p: 60 },
    { v: 3.65, p: 55 },
    { v: 3.60, p: 50 },
    { v: 3.55, p: 45 },
    { v: 3.50, p: 40 },
    { v: 3.45, p: 35 },
    { v: 3.40, p: 30 },
    { v: 3.35, p: 25 },
    { v: 3.30, p: 20 },
    { v: 3.25, p: 15 },
    { v: 3.20, p: 10 },
    { v: 3.10, p: 5 },
    { v: 2.80, p: 0 }
  ];

  // Find the two closest voltage points for interpolation
  for (let i = 0; i < voltageMap.length - 1; i++) {
    const current = voltageMap[i];
    const next = voltageMap[i + 1];

    if (voltage >= next.v && voltage <= current.v) {
      // Linear interpolation between two points
      const voltageDiff = current.v - next.v;
      const percentDiff = current.p - next.p;
      const ratio = (voltage - next.v) / voltageDiff;
      return Math.round(next.p + ratio * percentDiff);
    }
  }

  // Fallback to linear calculation if outside map range
  return Math.round(((voltage - 2.8) / (4.1 - 2.8)) * 100);
}

/**
 * Smooth battery percentage using a rolling average.
 * Prevents jitter from load variations (GPS, GSM, etc.).
 * 
 * @param {number} newPercentage - New battery percentage reading
 * @param {number} lastPercentage - Last recorded percentage
 * @param {number} smoothingFactor - Smoothing factor (0-1, default 0.3)
 * @returns {number} Smoothed battery percentage
 */
function smoothBatteryPercentage(newPercentage, lastPercentage, smoothingFactor = 0.3) {
  if (lastPercentage === null || lastPercentage === undefined) {
    return newPercentage;
  }
  // Exponential moving average: smooth out sudden drops/spikes
  return Math.round(lastPercentage * (1 - smoothingFactor) + newPercentage * smoothingFactor);
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
            console.error(`✗ [DB] Device not found: imei=${imei}`);
            return null;
        }
        device.last_seen = new Date();
        await device.save();
        console.log(`✓ [DB] Device validated & last_seen touched: imei=${imei} remark=${device.remark}`);
        return device;
    } catch (err) {
        console.error(`✗ [DB] Device validation error: imei=${imei} → ${err.message}`);
        return null;
    }
}

/**
 * Forward a location frame to the NestJS backend.
 * The backend owns all writes to device_locations and the devices hot fields.
 */
async function saveLocationToPostgres(imei, latitude, longitude, altitude, speed, timestamp) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`📍 [LOCATION] imei=${imei}`);
    console.log(`   lat=${latitude}  lng=${longitude}  alt=${altitude ?? 'N/A'}  speed=${speed ?? 'N/A'}`);
    console.log(`   device_ts=${timestamp || '(server time)'}`);

    const device = await validateAndTouchDevice(imei);
    if (!device) {
        console.error(`✗ [LOCATION] Dropped — device not in DB: imei=${imei}`);
        return false;
    }

    if (!validateCoordinates(latitude, longitude)) {
        console.error(`✗ [LOCATION] Invalid coordinates: lat=${latitude} lng=${longitude}`);
        return false;
    }

    try {
        const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:4000';
        const t0 = Date.now();
        // batteryLevel intentionally omitted from location frames — the value from
        // devices.battery_percentage can be stale (0) and would corrupt the WS stream.
        // Battery is updated by the dedicated /battery topic handler only.
        await axios.post(`${backendUrl}/api/devices/telemetry`, {
            type: 'location',
            imei,
            latitude,
            longitude,
            altitude,
            speed,
            timestamp: timestamp || new Date().toISOString(),
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        console.log(`✓ [LOCATION → DB] Saved via backend in ${Date.now() - t0}ms | imei=${imei} (${latitude}, ${longitude})`);
        return true;
    } catch (err) {
        console.error(`✗ [LOCATION → DB] Backend forward failed: imei=${imei} → ${err.message}`);
        return false;
    }
}

/**
 * Forward a battery reading to the NestJS backend.
 * Battery is stored as a hot field on devices — no standalone battery table.
 */
async function saveBatteryToPostgres(imei, batteryLevel) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`🔋 [BATTERY] imei=${imei}  level=${batteryLevel}%`);

    const device = await validateAndTouchDevice(imei);
    if (!device) {
        console.error(`✗ [BATTERY] Dropped — device not in DB: imei=${imei}`);
        return false;
    }

    if (typeof batteryLevel !== 'number' || batteryLevel < 0 || batteryLevel > 100) {
        console.error(`✗ [BATTERY] Invalid level=${batteryLevel} — must be 0–100`);
        return false;
    }

    const emoji = batteryLevel <= 10 ? '🪫' : batteryLevel <= 30 ? '🔴' : batteryLevel <= 60 ? '🟡' : '🟢';
    try {
        const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:4000';
        const t0 = Date.now();
        await axios.post(`${backendUrl}/api/devices/telemetry`, {
            type: 'battery',
            imei,
            batteryLevel,
            timestamp: new Date().toISOString(),
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        console.log(`✓ [BATTERY → DB] ${emoji} ${batteryLevel}% saved via backend in ${Date.now() - t0}ms | imei=${imei}`);
        return true;
    } catch (err) {
        console.error(`✗ [BATTERY → DB] Backend forward failed: imei=${imei} → ${err.message}`);
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
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!sessionId) {
      sessionId = generateSessionId();
      console.log(`[WS] ✓ New session: ${sessionId}  ip=${ip}`);
    } else {
      console.log(`[WS] ✓ Resumed session: ${sessionId}  ip=${ip}`);
    }

    sessions.set(sessionId, ws);
    ws.send(JSON.stringify({ type: 'session', sessionId }));
    console.log(`[WS] Active sessions: ${sessions.size}`);

    ws.on('message', (message) => {
      console.log(`[WS] ← ${sessionId}: ${message.toString().slice(0, 100)}`);
    });

    ws.on('close', () => {
      sessions.delete(sessionId);
      console.log(`[WS] ✗ Session closed: ${sessionId}  active=${sessions.size}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] ✗ Error on ${sessionId}: ${err.message}`);
    });
  });

  return wss;
}

/** POST /view returns only `latest` (no history arrays) so payloads stay tiny. */
const VIEW_LATEST_LIMIT = 1;

/** All collars subscribe here for the same retained manifest (fleet rollouts). */
const FLEET_OTA_COMMAND_TOPIC = 'fleet/ota/command';

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
      return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    }

    try {
      const device = await Device.findOne({ where: { imei } });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Only `latest` rows — no `locations` / `batteries` arrays (those were multi‑MB with huge tables).
      const [latestLocRows, latestBatRows] = await Promise.all([
        sequelize.query(
          `SELECT latitude, longitude,
                  location_timestamp AS device_timestamp,
                  created_at AS server_timestamp,
                  battery_percentage
             FROM device_locations
            WHERE imei = :imei
            ORDER BY created_at DESC NULLS LAST
            LIMIT :lim`,
          {
            replacements: { imei, lim: VIEW_LATEST_LIMIT },
            type: QueryTypes.SELECT
          }
        ),
        // Battery is a hot field on devices — read it directly
        sequelize.query(
          `SELECT battery_percentage AS battery_level, location_updated_at AS ts
             FROM devices
            WHERE imei = :imei
            LIMIT 1`,
          {
            replacements: { imei },
            type: QueryTypes.SELECT
          }
        )
      ]);

      const latestLoc = latestLocRows[0] || null;
      const latestBat = latestBatRows[0] || null;

      if (!latestLoc && !latestBat) {
        return res.status(404).json({ error: 'No telemetry data found for this IMEI' });
      }

      res.setHeader('X-View-Mode', 'latest-only');

      return res.json({
        imei,
        device: {
          isOn: normalizeBoolean(device.is_on),
          lastSeen: device.last_seen,
          isLost: normalizeBoolean(device.is_lost)
        },
        latest: {
          latitude: latestLoc ? latestLoc.latitude : null,
          longitude: latestLoc ? latestLoc.longitude : null,
          altitude: null,
          speed: null,
          device_timestamp: latestLoc ? latestLoc.device_timestamp : null,
          location_server_timestamp: latestLoc ? latestLoc.server_timestamp : null,
          battery_percentage: latestBat ? latestBat.battery_level : null,
          battery_timestamp: latestBat ? latestBat.ts : null
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
      return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    }

    try {
      const device = await Device.findOne({ where: { imei } });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const [latestLocation, latestDevice] = await Promise.all([
        Location.findOne({ where: { imei }, order: [['created_at', 'DESC']] }),
        // Re-fetch device for hot fields (battery already on device row)
        Device.findOne({ where: { imei } })
      ]);

      return res.json({
        imei,
        isLost: normalizeBoolean(device.is_lost),
        isWalking: normalizeBoolean(device.is_walking),
        latitude: latestLocation ? latestLocation.latitude : null,
        longitude: latestLocation ? latestLocation.longitude : null,
        battery: latestDevice ? latestDevice.battery_percentage : null,
        locationTimestamp: latestLocation ? latestLocation.location_timestamp : null,
        batteryTimestamp: latestDevice ? latestDevice.location_updated_at : null
      });
    } catch (err) {
      console.error('[/latest] ✗ Error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/imei', async (req, res) => {
    const { imei } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    console.log(`\n[/imei] ← Collar registration  imei=${imei}  ip=${ip}`);

    if (!imei) {
      console.error('[/imei] ✗ IMEI missing in request body');
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      console.error(`[/imei] ✗ Invalid IMEI format: "${imei}"`);
      return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    }

    try {
      const [rows] = await sequelize.query(
        'SELECT id, imei, remark, password_hash, access_token FROM devices WHERE imei = :imei LIMIT 1',
        { replacements: { imei } }
      );

      let deviceRow = null;
      let currentRemark = '';
      let isNewDevice = false;

      if (!rows.length) {
        isNewDevice = true;
        currentRemark = '';
        console.log(`[/imei] ℹ Device not found in DB — imei=${imei}`);
      } else {
        deviceRow = rows[0];
        currentRemark = String(deviceRow.remark || '').toLowerCase();
        console.log(`[/imei] ✓ Found device: id=${deviceRow.id}  remark=${currentRemark}`);
      }

      let nextRemark = currentRemark;
      if (!currentRemark || currentRemark === '') nextRemark = 'registered';
      else if (currentRemark === 'unregistered')   nextRemark = 'registered';
      else if (currentRemark === 'deregistered')   nextRemark = 'reregistered';
      else if (currentRemark === 'registered')     nextRemark = 'registered';
      else if (currentRemark === 'reregistered')   nextRemark = 'reregistered';
      else nextRemark = currentRemark || 'unregistered';

      const shouldGenerateCredentials = isNewDevice || ['unregistered', 'deregistered'].includes(currentRemark);
      console.log(`[/imei] remark: ${currentRemark || '(empty)'} → ${nextRemark}  newCreds=${shouldGenerateCredentials}`);

      // Fail-fast auth check before any expensive crypto work: when DEVICE_REGISTER_KEY is
      // set, new-device requests must supply a matching x-register-key header.
      if (isNewDevice && DEVICE_REGISTER_KEY) {
        const providedKey = req.headers['x-register-key'];
        // Reject immediately if the header is absent or not a plain string.
        if (typeof providedKey !== 'string' || !providedKey) {
          console.error(`[/imei] ✗ Auto-creation rejected — x-register-key header missing: imei=${imei}`);
          return res.status(403).json({ error: 'Device auto-creation requires a valid x-register-key header' });
        }
        const keyBuf = Buffer.from(DEVICE_REGISTER_KEY);
        const providedBuf = Buffer.from(providedKey);
        // Use timing-safe comparison to prevent timing-based enumeration of the key.
        if (providedBuf.length !== keyBuf.length || !crypto.timingSafeEqual(providedBuf, keyBuf)) {
          console.error(`[/imei] ✗ Auto-creation rejected — invalid x-register-key: imei=${imei}`);
          return res.status(403).json({ error: 'Device auto-creation requires a valid x-register-key header' });
        }
      }

      const mqttUsername = imei;
      let passwordHash = deviceRow ? deviceRow.password_hash : null;
      let accessToken = deviceRow ? deviceRow.access_token : null;
      let generatedNewCredentials = false;

      if (shouldGenerateCredentials || !accessToken) {
        accessToken = crypto.randomBytes(32).toString('hex');
        generatedNewCredentials = true;
        console.log(`[/imei] 🔑 New access_token generated for imei=${imei}`);
      }

      const mqttPassword = deriveDevicePassword(imei, accessToken, 10);
      passwordHash = crypto.createHash('sha256').update(mqttPassword).digest('hex');
      console.log(`[/imei] 🔐 MQTT password derived (10 chars) for imei=${imei}`);

      if (isNewDevice) {
        // INSERT the new device row. Handle a race where two requests arrive for the
        // same new IMEI simultaneously: catch unique-constraint violations, re-select,
        // and continue as an existing-device flow.
        console.log(`[/imei] ℹ Auto-creating new device row for imei=${imei}`);
        try {
          await sequelize.query(
            `INSERT INTO devices (imei, password_hash, access_token, remark, last_seen)
             VALUES (:imei, :passwordHash, :accessToken, :remark, NOW())`,
            { replacements: { imei, passwordHash, accessToken, remark: nextRemark } }
          );
          console.log(`[/imei] ✓ New device row inserted: imei=${imei}  remark=${nextRemark}`);
        } catch (insertErr) {
          // 23505 = PostgreSQL unique_violation — another request beat us to the INSERT.
          // Sequelize v6 exposes the pg error as both .original and .parent; check both.
          const pgCode = insertErr.original?.code ?? insertErr.parent?.code;
          if (pgCode === '23505') {
            console.warn(`[/imei] ⚠ Race: duplicate INSERT for imei=${imei} — re-selecting existing row`);
            const [raceRows] = await sequelize.query(
              'SELECT id, imei, remark, password_hash, access_token FROM devices WHERE imei = :imei LIMIT 1',
              { replacements: { imei } }
            );
            if (!raceRows.length) {
              console.error(`[/imei] ✗ Re-select after race failed for imei=${imei}`);
              return res.status(500).json({ error: 'Internal server error' });
            }
            // Fall through as existing-device flow
            deviceRow = raceRows[0];
            const existingRemark = String(deviceRow.remark || '').toLowerCase();
            accessToken = deviceRow.access_token;
            const raceMqttPassword = deriveDevicePassword(imei, accessToken, 10);
            passwordHash = crypto.createHash('sha256').update(raceMqttPassword).digest('hex');

            try {
              await defineMosquittoUser(mqttUsername, raceMqttPassword);
            } catch (dynsecErr) {
              console.error(`[/imei] ✗ Mosquitto user setup failed (race path): ${dynsecErr.message}`);
              return res.status(500).json({ error: 'Failed to configure MQTT credentials' });
            }

            console.log(`[/imei] ✓ Registration complete (race path): imei=${imei}  remark=${existingRemark}`);
            return res.json({ success: true, imei, remark: existingRemark, mqtt_username: mqttUsername, mqtt_password: raceMqttPassword, access_token: accessToken });
          }
          // Any other DB error
          console.error(`[/imei] ✗ DB insert failed: ${insertErr.message}`);
          return res.status(500).json({ error: 'Failed to create device record' });
        }
      }

      // Always sync dynsec — ensures password stays in sync even if access_token changed
      console.log(`[/imei] ⚙ Syncing Mosquitto user for imei=${imei}…`);
      try {
        await defineMosquittoUser(mqttUsername, mqttPassword);
        console.log(`[/imei] ✓ Mosquitto user configured: imei=${imei}`);
      } catch (dynsecError) {
        console.error(`[/imei] ✗ Mosquitto user setup failed: ${dynsecError.message}`);
        return res.status(500).json({ error: 'Failed to configure MQTT credentials' });
      }

      if (!isNewDevice) {
        try {
          if (generatedNewCredentials) {
            await sequelize.query(
              `UPDATE devices SET remark = :remark, password_hash = :passwordHash, access_token = :accessToken WHERE id = :id`,
              { replacements: { remark: nextRemark, passwordHash, accessToken, id: deviceRow.id } }
            );
            console.log(`[/imei] ✓ DB updated: new credentials + remark=${nextRemark}`);
          } else {
            await sequelize.query(
              `UPDATE devices SET remark = :remark WHERE id = :id`,
              { replacements: { remark: nextRemark, id: deviceRow.id } }
            );
            console.log(`[/imei] ✓ DB updated: remark=${nextRemark}`);
          }
        } catch (dbErr) {
          console.error(`[/imei] ✗ DB update failed: ${dbErr.message}`);
          return res.status(500).json({ error: 'Failed to update device record' });
        }
      }

      console.log(`[/imei] ✓ Registration complete: imei=${imei}  remark=${nextRemark}  mqtt_user=${mqttUsername}`);
      return res.json({ success: true, imei, remark: nextRemark, mqtt_username: mqttUsername, mqtt_password: mqttPassword, access_token: accessToken });
    } catch (err) {
      console.error(`[/imei] ✗ Unexpected error: ${err.message}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // /refresh-mqtt endpoint removed: MQTT credential refresh is now handled
  // via the idempotent /imei handler which always (re)generates credentials.

  app.post('/isOn', async (req, res) => {
    const { imei, isOn } = req.body;
    console.log(`\n[/isOn] ← imei=${imei}  isOn=${isOn}`);

    if (!imei)                    return res.status(400).json({ error: 'IMEI is required' });
    if (!validateIMEI(imei))      return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    if (typeof isOn !== 'boolean') return res.status(400).json({ error: 'isOn must be a boolean' });

    try {
      const [updated] = await Device.update({ is_on: isOn }, { where: { imei } });
      if (!updated) {
        console.error(`[/isOn] ✗ Device not found: imei=${imei}`);
        return res.status(404).json({ error: 'Device not found' });
      }
      console.log(`[/isOn] ✓ DB updated: imei=${imei}  is_on=${isOn}`);

      if (mqttClient && mqttClient.connected) {
        const topic = `collar/${imei}/isOn`;
        mqttClient.publish(topic, JSON.stringify(isOn), { retain: true }, (err) => {
          if (err) console.error(`[/isOn] ✗ MQTT publish failed: ${err.message}`);
          else     console.log(`[/isOn] ✓ Published → ${topic} (retained)  payload=${isOn}`);
        });
      } else {
        console.warn(`[/isOn] ⚠ MQTT not connected — collar ${imei} won't get the command until reconnect`);
      }

      broadcastToSessions({ type: 'isOn', imei, isOn, timestamp: new Date() });
      return res.json({ success: true });
    } catch (err) {
      console.error(`[/isOn] ✗ Error: ${err.message}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/isWalking', async (req, res) => {
    const { imei, isWalking } = req.body;
    console.log(`\n[/isWalking] ← imei=${imei}  isWalking=${isWalking}`);

    if (!imei)                         return res.status(400).json({ error: 'IMEI is required' });
    if (!validateIMEI(imei))           return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    if (typeof isWalking !== 'boolean') return res.status(400).json({ error: 'isWalking must be a boolean' });

    try {
      const [updated] = await Device.update({ is_walking: isWalking }, { where: { imei } });
      if (!updated) {
        console.error(`[/isWalking] ✗ Device not found: imei=${imei}`);
        return res.status(404).json({ error: 'Device not found' });
      }
      console.log(`[/isWalking] ✓ DB updated: imei=${imei}  is_walking=${isWalking}`);

      if (mqttClient && mqttClient.connected) {
        const topic = `collar/${imei}/isWalking`;
        mqttClient.publish(topic, JSON.stringify(isWalking), { retain: true }, (err) => {
          if (err) console.error(`[/isWalking] ✗ MQTT publish failed: ${err.message}`);
          else     console.log(`[/isWalking] ✓ Published → ${topic} (retained)  payload=${isWalking}`);
        });
      } else {
        console.warn(`[/isWalking] ⚠ MQTT not connected — collar ${imei} won't get the command until reconnect`);
      }

      broadcastToSessions({ type: 'isWalking', imei, isWalking, timestamp: new Date() });
      return res.json({ success: true });
    } catch (err) {
      console.error(`[/isWalking] ✗ Error: ${err.message}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * Publish retained OTA manifest to the collar. Device subscribes to `collar/{imei}/ota/command`.
   * Body: { imei, command: { url, version, sha256?, force?, size? } }
   */
  app.post('/otaCommand', async (req, res) => {
    const { imei, command } = req.body || {};

    if (!imei) {
      return res.status(400).json({ error: 'IMEI is required' });
    }
    if (!validateIMEI(imei)) {
      return res.status(400).json({ error: 'IMEI must be a 15-digit string' });
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({
        error: 'command must be a JSON object (e.g. url, version, sha256)'
      });
    }

    try {
      const device = await Device.findOne({ where: { imei } });
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT broker not connected' });
      }

      const topic = `collar/${imei}/ota/command`;
      const payload = JSON.stringify(command);

      mqttClient.publish(topic, payload, { retain: true }, (err) => {
        if (err) console.error(`[/otaCommand] ✗ Publish failed: ${err.message}`);
        else     console.log(`[/otaCommand] ✓ OTA command published → ${topic}  version=${command.version ?? '?'}`);
      });

      broadcastToSessions({
        type: 'otaCommand',
        imei,
        command,
        timestamp: new Date()
      });

      return res.json({ success: true, topic, scope: 'device' });
    } catch (err) {
      console.error('[/otaCommand] ✗ Error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/otaCommandFleet', async (req, res) => {
    const { command } = req.body || {};

    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return res.status(400).json({ error: 'command must be a JSON object (e.g. url, version, sha256)' });
    }

    try {
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT broker not connected' });
      }

      const payload = JSON.stringify(command);
      mqttClient.publish(FLEET_OTA_COMMAND_TOPIC, payload, { retain: true }, (err) => {
        if (err) console.error(`[/otaCommandFleet] ✗ Publish failed: ${err.message}`);
        else     console.log(`[/otaCommandFleet] ✓ Fleet OTA published → ${FLEET_OTA_COMMAND_TOPIC}  version=${command.version ?? '?'}`);
      });

      broadcastToSessions({ type: 'otaFleetCommand', command, timestamp: new Date() });
      return res.json({ success: true, topic: FLEET_OTA_COMMAND_TOPIC, scope: 'fleet' });
    } catch (err) {
      console.error(`[/otaCommandFleet] ✗ Error: ${err.message}`);
      return res.status(500).json({ error: 'Internal server error' });
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
        console.log('\n' + '╔' + '═'.repeat(53) + '╗');
        console.log('║  MyPerro MQTT Bridge — started                      ║');
        console.log('╠' + '═'.repeat(53) + '╣');
        console.log(`║  HTTP  http://${host}:${port}`.padEnd(54) + '║');
        console.log(`║  DB    ${process.env.DATABASE_HOST || process.env.DB_HOST || 'Neon'}`.padEnd(54) + '║');
        console.log(`║  MQTT  ${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`.padEnd(54) + '║');
        console.log(`║  Backend ${process.env.BACKEND_API_URL || 'http://localhost:4000'}`.padEnd(54) + '║');
        console.log('╚' + '═'.repeat(53) + '╝\n');
        // Start WebSocket server
        startWebSocketServer(server);
        // Only connect to MQTT after Express is ready
        startMQTTClient();
    });
}

function startMQTTClient() {
    console.log('\n' + '═'.repeat(55));
    console.log('[MQTT] Connecting to broker…');
    console.log(`[MQTT]   url=mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
    console.log(`[MQTT]   user=${process.env.MQTT_USERNAME}`);
    console.log('═'.repeat(55) + '\n');
    
    mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`, {
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        console.log('\n' + '★'.repeat(55));
        console.log('[MQTT] ✓ Connected to broker');
        console.log(`[MQTT]   host=${process.env.MQTT_HOST}:${process.env.MQTT_PORT}  clientId=${mqttClient.options.clientId}`);
        console.log('★'.repeat(55) + '\n');
        
        const topics = ['collar/+/location', 'collar/+/battery', 'collar/+/isLost', 'collar/+/ota/status', 'collar/+/ota/ack'];
        topics.forEach(t => {
            mqttClient.subscribe(t, (err, granted) => {
                if (err) console.error(`[MQTT] ✗ Subscribe failed: ${t} → ${err.message}`);
                else     console.log(`[MQTT] ✓ Subscribed: ${t}  qos=${granted?.[0]?.qos ?? '?'}`);
            });
        });
        console.log('[MQTT] ⏳ Waiting for collar messages…\n');
    });

    mqttClient.on('reconnect', () => {
        console.log('[MQTT] ⟳ Reconnecting to broker…');
    });

    mqttClient.on('close', () => {
        console.log('[MQTT] ✗ Connection closed');
    });

    mqttClient.on('offline', () => {
        console.log('[MQTT] ⚠ Client offline');
    });

    mqttClient.on('error', (err) => {
        console.error(`[MQTT] ✗ Error: ${err.message}  (code=${err.code ?? 'N/A'})`);
    });

    mqttClient.on('message', async (topic, message, packet) => {
      const rawMsg = message.toString();

      // De-duplication: ignore identical messages on the same topic within 1 second
      try {
        const key = `${topic}|${rawMsg}`;
        const now = Date.now();
        const last = recentMessages.get(key) || 0;
        if (now - last < 1000) {
          console.log(`[MQTT] ⏭  Dedup — skipping duplicate: ${topic}`);
          return;
        }
        recentMessages.set(key, now);
        setTimeout(() => recentMessages.delete(key), 5000);
      } catch (e) {}

        const parts = topic.split('/');
        if (parts.length < 3 || parts[0] !== 'collar') {
            console.log(`[MQTT] ⚠ Ignoring unexpected topic: ${topic}`);
            return;
        }
        const imei = parts[1];
        let topicType;
        if (parts.length === 3) {
            topicType = parts[2];
        } else if (parts.length === 4 && parts[2] === 'ota') {
            topicType = `ota/${parts[3]}`;
        } else {
            console.log(`[MQTT] ⚠ Ignoring unexpected topic structure: ${topic}`);
            return;
        }

        let data;
        try {
            data = JSON.parse(rawMsg);
        } catch (err) {
            data = rawMsg;
        }

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`[MQTT] ▶ ${topic}  qos=${packet?.qos ?? '?'}  retain=${packet?.retain ?? '?'}`);
        console.log(`[MQTT]   payload=${rawMsg.length > 120 ? rawMsg.slice(0, 120) + '…' : rawMsg}`);

        if (topicType === 'location') {
            let latitude, longitude, altitude, speed, timestamp;
            
            if (Array.isArray(data) && data.length >= 2) {
                latitude = data[0];
                longitude = data[1];
            } else if (typeof data === 'object' && data !== null) {
                latitude  = data.lat  ?? data.latitude;
                longitude = data.lng  ?? data.longitude;
                altitude  = data.alt  ?? data.altitude;
                speed     = data.speed;
                timestamp = data.ts   ?? data.timestamp;
            }
            
            if (typeof latitude === 'number' && typeof longitude === 'number') {
                const saved = await saveLocationToPostgres(imei, latitude, longitude, altitude, speed, timestamp);
                if (saved) {
                    broadcastToSessions({ type: 'location', imei, latitude, longitude, altitude, speed, timestamp, date: new Date() });
                    console.log(`📡 [WS] Location broadcast → ${sessions.size} session(s)`);
                }
            } else {
                console.error(`✗ [LOCATION] Bad payload — expected [lat,lng] or {lat,lng}: ${rawMsg}`);
            }
        } else if (topicType === 'battery') {
            let batteryLevel = null;
            let voltageMv = null;
            let currentMa = null;
            let powerMw = null;
            
            if (Array.isArray(data) && data.length >= 1) {
                batteryLevel = data[0];
            } else if (typeof data === 'object' && data !== null) {
                batteryLevel = data.level ?? data.battery ?? data.batteryLevel;
                voltageMv    = data.voltage_mv ?? data.voltage;
                currentMa    = data.current_ma ?? data.current;
                powerMw      = data.power_mw   ?? data.power;
                if (batteryLevel == null && voltageMv) {
                    batteryLevel = calculateBatteryPercentage(voltageMv);
                    console.log(`🔋 [BATTERY] Calculated from voltage: ${voltageMv}mV → ${batteryLevel}%`);
                }
            }
            
            if (batteryLevel !== null && typeof batteryLevel === 'number') {
                batteryLevel = Math.max(0, Math.min(100, batteryLevel));
                if (voltageMv) {
                    console.log(`⚡ [BATTERY] V=${voltageMv}mV  I=${currentMa ?? 'N/A'}mA  P=${powerMw ?? 'N/A'}mW`);
                }
                const saved = await saveBatteryToPostgres(imei, batteryLevel);
                if (saved) {
                    broadcastToSessions({ type: 'battery', imei, batteryLevel, voltage: voltageMv, current: currentMa, power: powerMw, timestamp: new Date() });
                    console.log(`📡 [WS] Battery broadcast → ${sessions.size} session(s)`);
                }
            } else {
                console.error(`✗ [BATTERY] Bad payload — no valid level or voltage_mv: ${rawMsg}`);
            }
        } else if (topicType === 'isLost') {
            const isLost = parseMqttIsLostPayload(data);
            const emoji = isLost ? '🚨' : '✅';
            console.log(`${emoji} [isLost] imei=${imei}  isLost=${isLost}  (raw="${rawMsg}")`);

            broadcastToSessions({ type: 'isLost', imei, isLost, timestamp: new Date() });
            console.log(`📡 [WS] isLost broadcast → ${sessions.size} session(s)`);

            // All DB writes, lost_status_history, and FCM notifications handled by NestJS backend
            try {
                const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:4000';
                const t0 = Date.now();
                const response = await axios.post(`${backendUrl}/api/devices/is-lost`, { imei, isLost }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 8000
                });
                console.log(`${emoji} [isLost → Backend] Done in ${Date.now() - t0}ms | imei=${imei} isLost=${isLost} → ${JSON.stringify(response.data)}`);
                if (isLost) {
                    console.log(`🔔 [FCM] Lost notification triggered for imei=${imei}`);
                } else {
                    console.log(`🔔 [FCM] Safe notification triggered for imei=${imei}`);
                }
            } catch (error) {
                console.error(`✗ [isLost → Backend] Failed: imei=${imei} → ${error.message}`);
                if (error.response) {
                    console.error(`   HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
                }
            }
        } else if (topicType === 'ota/status') {
            const statusPayload = typeof data === 'object' && data !== null ? data : { raw: String(data) };
            const statusStr = statusPayload.status || (typeof statusPayload === 'string' ? statusPayload : JSON.stringify(statusPayload));
            const statusEmoji = { downloading: '⬇️', installing: '⚙️', success: '✅', error: '❌', rebooting: '🔄' }[statusStr] || '📡';
            console.log(`${statusEmoji} [OTA STATUS] imei=${imei}  status=${statusStr}`);
            if (statusPayload.progress != null) console.log(`   progress=${statusPayload.progress}%`);
            broadcastToSessions({ type: 'otaStatus', ...statusPayload, imei, timestamp: new Date() });

        } else if (topicType === 'ota/ack') {
            const ackPayload = typeof data === 'object' && data !== null ? data : { value: data };
            console.log(`🤝 [OTA ACK] imei=${imei}  ack=${JSON.stringify(ackPayload)}`);
            broadcastToSessions({ type: 'otaAck', ...ackPayload, imei, timestamp: new Date() });

        } else {
            console.log(`[MQTT] ⚠ Unknown topicType="${topicType}" for imei=${imei} — ignored`);
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
