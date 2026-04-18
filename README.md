# MQTT IoT Collar System

Node.js backend for managing IoT collar devices with real-time location tracking, battery monitoring, and WebSocket streaming.

This README reflects the current codebase and endpoints implemented in `index.js` (Express + WebSocket + MQTT client).

## Quick summary

- REST API and WebSocket server run on the same Express server (default port `3000`).
- MQTT broker is external and configured via environment variables; device credentials are managed using the Mosquitto Dynamic Security plugin and are created on-demand by the backend via `mosquitto_ctrl`.
- Telemetry is persisted to PostgreSQL (Neon or other) via Sequelize models in `models/`.

## Defaults (example values in `.env` in this repo)

- Public IP: `35.154.64.66` (example)
- REST API / WebSocket: `http://35.154.64.66:3000`
- MQTT Broker: `mqtt://35.154.64.66:1883`

## Environment variables (required)

The server validates these on startup. Set them in `.env` or your environment.

Required:

```
NEON_DB_URL                # PostgreSQL connection string (Neon or other)
MOSQUITTO_ADMIN_USER       # DynSec admin user (used by mosquitto_ctrl)
MOSQUITTO_ADMIN_PASS       # DynSec admin password
MQTT_HOST                  # Broker host/IP
MQTT_PORT                  # Broker port (e.g. 1883)
MQTT_USERNAME              # Backend MQTT username (used by this service to publish)
MQTT_PASSWORD              # Backend MQTT password
```

Optional / helpful:

```
DYNAMIC_SECURITY_FILE      # path to dynamic-security.json (default relative path)
APP_API_URL                # URL called when `isLost` is received (used by backend)
API_HOST                   # Express host (default 0.0.0.0)
PORT                       # Express port (default 3000)
```

## Endpoints

All endpoints are mounted on the Express server (default `http://<host>:3000`):

- GET `/health`
  - Basic health/status for ALB/monitoring. Returns JSON with uptime, database and MQTT connectivity status.

- POST `/test-gps`
  - Body: `{ appLatitude, appLongitude, collarLatitude, collarLongitude }` (all numbers)
  - Returns: `{ verified: true, distance_meters, threshold_meters }` when within 10 m, otherwise 422 with distance data.

- POST `/view`
  - Body: `{ imei }` (string, 15 digits)
  - Returns full telemetry history and latest location/battery data for the given IMEI.
  - Response includes: latitude, longitude, altitude, speed, device_timestamp, and server_timestamp for each location record.

- POST `/imei`
  - Body: `{ imei }` (string, 15 digits)
  - Idempotent: looks up the device, regenerates MQTT credentials, registers the client and per-device role via Mosquitto Dynamic Security, updates DB with password hash and access token.
  - Returns: `{ success: true, imei, mqtt_username, mqtt_password, access_token, remark }` on success.

- POST `/isOn`
  - Body: `{ imei, isOn }` (IMEI 15 chars, `isOn` boolean)
  - Updates the `is_on` flag in DB and publishes retained MQTT message to `collar/{imei}/isOn`.
  - Returns `{ success: true }` on success.

- POST `/isWalking`
  - Body: `{ imei, isWalking }` (IMEI 15 chars, `isWalking` boolean)
  - Updates the `is_walking` flag in DB and publishes retained MQTT message to `collar/{imei}/isWalking`.
  - Returns `{ success: true }` on success.

Notes: Input validation is strict: IMEI must be a 15-digit string; boolean fields must be true/false.

## WebSocket

- The backend accepts WebSocket upgrades on the same Express port (e.g. `ws://<host>:3000?sessionId=optional`).
- On connect the server sends `{ type: 'session', sessionId }` and later broadcasts messages:
  - `{ type: 'location', imei, latitude, longitude, timestamp }`
  - `{ type: 'battery', imei, batteryLevel, timestamp }`

Client example:

```javascript
const ws = new WebSocket("ws://35.154.64.66:3000");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg);
};
```

## MQTT topics

- Devices publish telemetry to these topics:
  - `collar/{imei}/location` -> payload: JSON object `{lat, lng, speed, alt, ts}` or array `[latitude, longitude]`
  - `collar/{imei}/battery` -> payload: JSON array `[batteryLevel]`
  - `collar/{imei}/isLost` -> payload: boolean (true/false) or string
  - `collar/{imei}/ota/status` -> device → server: OTA progress JSON, e.g. `{ "state": "downloading", "percent": 42, "version": "1.2.0" }`
  - `collar/{imei}/ota/ack` -> optional device ack after applying update (any JSON)

- Server (backend) publishes retained control topics:
  - `collar/{imei}/isOn` -> payload: boolean (retained)
  - `collar/{imei}/isWalking` -> payload: boolean (retained)
  - `collar/{imei}/ota/command` -> **per-device** retained OTA manifest (single collar). Same JSON shape. Use `POST /otaCommand` on the Express API (`body: { imei, command }`).
  - `fleet/ota/command` -> **all devices** retained manifest — every collar should also subscribe here for fleet rollouts. Use `POST /otaCommandFleet` (`body: { command }` only, no `imei`).

**Firmware:** subscribe to **both** `collar/{imei}/ota/command` and `fleet/ota/command`. Recommended policy: if both retained messages exist, prefer **per-device** `collar/{imei}/ota/command` over fleet when versions differ, or ignore fleet when a device-specific command is newer.

Dynamic Security: the shared `deviceRole` must allow devices to **publish** to `collar/+/ota/status` and `collar/+/ota/ack`, and **receive** `collar/%u/ota/command` and `fleet/ota/command` (see `dynamic-security.json`). New devices registered via `POST /imei` get subscribe ACLs for `collar/{imei}/ota/command` and `fleet/ota/command` on the per-device role.

Example publish (using mosquitto_pub):

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 -u <imei> -P <password> \
  -t "collar/123456789012345/location" -m '[37.7749, -122.4194]'
```

## Dynamic Security

- The project uses the Mosquitto Dynamic Security plugin. Device users/roles are created by the backend via `mosquitto_ctrl` when `/imei` is called.
- Keep `DYNAMIC_SECURITY_FILE` accessible and writeable by the user running Mosquitto (or owned by `mosquitto:mosquitto`). The backend attempts to merge `.new` files created by the plugin.

## Deployment notes

1. Install runtime and dependencies on the server:

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs mosquitto mosquitto-clients
npm install
```

2. Configure `.env` with required variables (see above).

3. Ensure `dynamic-security.json` exists and the Mosquitto Dynamic Security plugin path in your Mosquitto config points to the plugin binary (e.g. `/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so`).

4. Start the backend (example using systemd shown in repo):

```bash
sudo systemctl enable mqtt-backend
sudo systemctl start mqtt-backend
```

5. If you need to run Mosquitto with your custom config, either update the system Mosquitto unit or create a custom unit that calls `/usr/sbin/mosquitto -c /home/ubuntu/mqtt/mosquitto-custom.conf -d` (the repo includes an example unit).

## Testing

- Run the device simulator:

```bash
node iot-publisher.js
```

- Monitor MQTT topics:

```bash
mosquitto_sub -h 35.154.64.66 -p 1883 -t 'collar/#' -v
```

- Use the API to register devices and control them:

```bash
curl -X POST http://35.154.64.66:3000/imei -H 'Content-Type: application/json' -d '{"imei":"123456789012345"}'
curl -X POST http://35.154.64.66:3000/isOn -H 'Content-Type: application/json' -d '{"imei":"123456789012345","isOn":true}'
```

## Troubleshooting

- If Mosquitto fails to start, run it in the foreground to see configuration/plugin errors:

```bash
sudo /usr/sbin/mosquitto -c /etc/mosquitto/mosquitto.conf -v
```

- Check backend logs:

```bash
sudo journalctl -u mqtt-backend -f
```

## Files of interest

- `index.js` — main server (Express + WebSocket + MQTT client)
- `iot-publisher.js` — device simulator
- `device-manager.js` — device registration helper
- `models/` — Sequelize models (`device`, `location`, `battery`)

---

**Status**: Matches current codebase | **Last Updated**: Feb 16, 2026
