# MQTT IoT Collar System

Node.js backend for managing IoT collar devices with real-time location tracking, battery monitoring, and WebSocket streaming.

## MQTT Authentication & Authorization

This project uses the Mosquitto Dynamic Security Plugin for MQTT user and topic access management. Device credentials are created and assigned roles automatically when a device is registered (via the `/imei` endpoint). No password or ACL files are used; all permissions are managed dynamically.

**User/role management is fully automated.**

## Production Deployment (AWS)

- **Public IP**: `35.154.64.66`
- **REST API**: `http://35.154.64.66:3000`
- **WebSocket**: `ws://35.154.64.66:3000`
- **MQTT Broker**: `mqtt://35.154.64.66:1883`

**Open Ports**: 3000 (API/WebSocket), 1883 (MQTT)

## Architecture

```
IoT Devices  MQTT  Mosquitto Broker
  (Collars)
  Topics:                         Subscribe
  - collar/+/location
  - collar/+/battery      Node.js Backend  Neon DB
  - collar/+/isLost       (Express + WS)     (PostgreSQL)
```

**Stack**: Node.js, Express, MQTT, WebSocket, Neon DB (Serverless PostgreSQL), Mosquitto

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with Neon DB connection string

# Run
mosquitto -c mosquitto-custom.conf &
node index.js
```

## Configuration

Required environment variables in `.env`:

```env
# Neon DB (get from https://console.neon.tech)
DATABASE_URL=postgresql://user:password@ep-xxx.aws.neon.tech/dbname?sslmode=require


# MQTT Broker
MQTT_HOST=35.154.64.66
MQTT_PORT=1883
# Device credentials are generated and managed automatically. No password file is used.

# API Server
API_HOST=0.0.0.0
PORT=3000

# Mosquitto Dynamic Security Admin Credentials
MOSQUITTO_ADMIN_USER=admin
MOSQUITTO_ADMIN_PASS=admin12
DYNAMIC_SECURITY_FILE=dynamic-security.json
```

## MQTT Topics

| Topic                     | Direction     | Payload      | Description         |
| ------------------------- | ------------- | ------------ | ------------------- |
| `collar/{imei}/location`  | Device Server | `[lat, lng]` | GPS coordinates     |
| `collar/{imei}/battery`   | Device Server | `[level]`    | Battery % (0-100)   |
| `collar/{imei}/isLost`    | Device Server | `true/false` | Lost status         |
| `collar/{imei}/isOn`      | Server Device | `true/false` | Activate/deactivate |
| `collar/{imei}/isWalking` | Server Device | `true/false` | Walking mode        |

**Example - Publish Location:**

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 -u imei -P pass \
  -t "collar/123456789012345/location" -m '[37.7749, -122.4194]'
```

## REST API

**Base URL**: `http://35.154.64.66:3000`

### POST /isOn

Control device active state (publishes to MQTT with retain).

```bash
curl -X POST http://35.154.64.66:3000/isOn \
  -H "Content-Type: application/json" \
  -d '{"imei":"123456789012345","isOn":true}'
```

**Response**: `{"success": true}`

**Validation**: IMEI must be 15 chars, isOn must be boolean, device must exist.

### POST /isWalking

Control device walking mode (publishes to MQTT with retain).

```bash
curl -X POST http://35.154.64.66:3000/isWalking \
  -H "Content-Type: application/json" \
  -d '{"imei":"123456789012345","isWalking":true}'
```

## WebSocket API

**Connect**: `ws://35.154.64.66:3001?sessionId=optional`

**Messages from server:**

```javascript
// Session ID
{"type":"session","sessionId":"session_abc123"}

// Location update
{"type":"location","imei":"123...","latitude":37.7,"longitude":-122.4,"timestamp":"..."}

// Battery update
{"type":"battery","imei":"123...","batteryLevel":85.5,"timestamp":"..."}
```

**Client Example:**

```javascript
const ws = new WebSocket("ws://35.154.64.66:3001");
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === "location") console.log(data.latitude, data.longitude);
};
```

## Database Schema (Neon DB)

**Devices**: `imei` (VARCHAR 15, unique), `is_on` (BOOLEAN), `is_walking` (BOOLEAN), `last_seen` (TIMESTAMP)

**Locations**: `imei` (VARCHAR 15), `latitude` (DECIMAL), `longitude` (DECIMAL), `created_at` (TIMESTAMP)

**Batteries**: `imei` (VARCHAR 15), `battery_level` (DECIMAL 0-100), `created_at` (TIMESTAMP)

Auto-created via Sequelize on first run.

## AWS EC2 Deployment

### Prerequisites

```bash
# SSH to instance
ssh -i key.pem ubuntu@35.154.64.66

# Install dependencies
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs mosquitto mosquitto-clients
```

### Mosquitto Dynamic Security Plugin Setup

**On Ubuntu/Debian**, the plugin is typically at `/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so`.

1. **Create Mosquitto config** (`mosquitto-custom.conf`):

```conf
listener 1883 0.0.0.0
allow_anonymous false
plugin /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so
plugin_opt_config_file /home/ubuntu/mqtt/dynamic-security.json
```

2. **Initialize Dynamic Security**:

```bash
cd /home/ubuntu/mqtt
mosquitto_ctrl dynsec init dynamic-security.json admin admin12
```

3. **Create device role with ACLs**:

```bash
# Create role for device topics
mosquitto_ctrl -u admin -P admin12 dynsec createRole deviceRole

# Allow publish to all collar telemetry topics
mosquitto_ctrl -u admin -P admin12 dynsec addRoleACL deviceRole publishClientSend "collar/+/location" allow
mosquitto_ctrl -u admin -P admin12 dynsec addRoleACL deviceRole publishClientSend "collar/+/battery" allow
mosquitto_ctrl -u admin -P admin12 dynsec addRoleACL deviceRole publishClientSend "collar/+/isLost" allow

# Allow subscribe to all collar control topics
mosquitto_ctrl -u admin -P admin12 dynsec addRoleACL deviceRole subscribePattern "collar/+/isOn" allow
mosquitto_ctrl -u admin -P admin12 dynsec addRoleACL deviceRole subscribePattern "collar/+/isWalking" allow
```

4. **Set file permissions**:

```bash
chmod 644 dynamic-security.json
chown mosquitto:mosquitto dynamic-security.json  # or ubuntu:ubuntu depending on service user
```

### Application Deployment

```bash
# Deploy
git clone <repo-url>
cd mqtt && npm install
cp .env.example .env
# Configure .env with production values (see Configuration section above)

# Run Mosquitto with custom config
sudo mosquitto -c /home/ubuntu/mqtt/mosquitto-custom.conf -d

# Run as systemd service (optional)
sudo nano /etc/systemd/system/mqtt-backend.service
```

**SystemD Services:**

Node.js Backend (`/etc/systemd/system/mqtt-backend.service`):

```ini
[Unit]
Description=MQTT Backend Service
After=network.target mosquitto.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/mqtt
ExecStart=/usr/bin/node index.js
Restart=on-failure
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

Mosquitto Broker (`/etc/systemd/system/mosquitto-custom.service`):

```ini
[Unit]
Description=Mosquitto MQTT Broker with Dynamic Security
After=network.target

[Service]
Type=forking
User=mosquitto
ExecStart=/usr/sbin/mosquitto -c /home/ubuntu/mqtt/mosquitto-custom.conf -d
Restart=on-failure
PIDFile=/var/run/mosquitto/mosquitto.pid

[Install]
WantedBy=multi-user.target
```

**Enable and start services:**

```bash
# Stop default mosquitto if running
sudo systemctl stop mosquitto
sudo systemctl disable mosquitto

# Start custom services
sudo systemctl enable mosquitto-custom
sudo systemctl enable mqtt-backend

sudo systemctl start mosquitto-custom
sudo systemctl start mqtt-backend
```

## Testing

```bash
# Run device simulator
node iot-publisher.js

# Run test app
node dummy-app.js


# Monitor MQTT
mosquitto_sub -h 35.154.64.66 -p 1883 -u <imei> -P <password> -t "collar/#" -v

# Test location publishing
mosquitto_pub -h 35.154.64.66 -p 1883 -u imei -P pass \
  -t "collar/123456789012345/location" -m '[37.7749, -122.4194]'
```

## Monitoring

**Logs:**

```bash
sudo journalctl -u mqtt-backend -f
```

**Database:**

```bash
psql $DATABASE_URL -c "SELECT * FROM devices WHERE is_on = true;"
psql $DATABASE_URL -c "SELECT * FROM locations ORDER BY created_at DESC LIMIT 10;"
```

**MQTT Broker:**

```bash
sudo systemctl status mosquitto
sudo tail -f /var/log/mosquitto/mosquitto.log
```

## Troubleshooting

| Issue                      | Solution                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| MQTT connection refused    | Check Mosquitto running, port 1883 open, verify credentials                                                |
| Database connection failed | Verify `DATABASE_URL` in `.env`, check Neon DB status at console.neon.tech                                 |
| Device not found           | Register device: `INSERT INTO devices (imei, is_on, is_walking) VALUES ('123456789012345', false, false);` |
| Data not saving            | Ensure device `is_on = true` via `/isOn` endpoint                                                          |
| WebSocket disconnects      | Check Express server running, port 3000 accessible                                                         |

## Security Checklist

- [ ] Use strong device passwords (auto-generated)
- [ ] Enable MQTT TLS/SSL
- [ ] Configure AWS Security Groups restrictively
- [ ] Add API authentication middleware
- [ ] Use HTTPS (nginx reverse proxy)
- [ ] Enable WSS for WebSocket
- [ ] Use Mosquitto Dynamic Security Plugin for MQTT ACL
- [ ] Regular backups of Neon DB

## Dependencies

`mqtt` `express` `sequelize` `pg` `ws` `body-parser` `dotenv` `axios`

## Files

- **index.js** - Main server (MQTT, Express, WebSocket)
- **db.js** - Neon DB connection (Sequelize)
- **iot-publisher.js** - Device simulator
- **device-manager.js** - Device registration tool
- **dummy-app.js** - Test notification endpoint
- **models/** - Sequelize models (Device, Location, Battery)

---

**Status**: Production Ready | **Last Updated**: Feb 8, 2026 | **Server**: 35.154.64.66
