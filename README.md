# MQTT IoT Collar System

Node.js backend for managing IoT collar devices with real-time location tracking, battery monitoring, and WebSocket streaming.

##  Production Deployment (AWS)

- **Public IP**: `35.154.64.66`
- **REST API**: `http://35.154.64.66:3000`
- **WebSocket**: `ws://35.154.64.66:3000`
- **MQTT Broker**: `mqtt://35.154.64.66:1883`

**Open Ports**: 3000 (API/WebSocket), 1883 (MQTT)

##  Architecture

```
IoT Devices  MQTT  Mosquitto Broker
  (Collars)                      
  Topics:                         Subscribe
  - collar/+/location            
  - collar/+/battery      Node.js Backend  Neon DB
  - collar/+/isLost       (Express + WS)     (PostgreSQL)
```

**Stack**: Node.js, Express, MQTT, WebSocket, Neon DB (Serverless PostgreSQL), Mosquitto

##  Quick Start

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

##  Configuration

Required environment variables in `.env`:

```env
# Neon DB (get from https://console.neon.tech)
DATABASE_URL=postgresql://user:password@ep-xxx.aws.neon.tech/dbname?sslmode=require

# MQTT Broker
MQTT_HOST=35.154.64.66
MQTT_PORT=1883
MQTT_USERNAME=mqtt_user
MQTT_PASSWORD=secure_password

# API Server
API_HOST=0.0.0.0
PORT=3000
```

##  MQTT Topics

| Topic | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `collar/{imei}/location` | Device  Server | `[lat, lng]` | GPS coordinates |
| `collar/{imei}/battery` | Device  Server | `[level]` | Battery % (0-100) |
| `collar/{imei}/isLost` | Device  Server | `true/false` | Lost status |
| `collar/{imei}/isOn` | Server  Device | `true/false` | Activate/deactivate |
| `collar/{imei}/isWalking` | Server  Device | `true/false` | Walking mode |

**Example - Publish Location:**
```bash
mosquitto_pub -h 35.154.64.66 -p 1883 -u imei -P pass \
  -t "collar/123456789012345/location" -m '[37.7749, -122.4194]'
```

##  REST API

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

##  WebSocket API

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
const ws = new WebSocket('ws://35.154.64.66:3001');
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if(data.type === 'location') console.log(data.latitude, data.longitude);
};
```

##  Database Schema (Neon DB)

**Devices**: `imei` (VARCHAR 15, unique), `is_on` (BOOLEAN), `is_walking` (BOOLEAN), `last_seen` (TIMESTAMP)

**Locations**: `imei` (VARCHAR 15), `latitude` (DECIMAL), `longitude` (DECIMAL), `created_at` (TIMESTAMP)

**Batteries**: `imei` (VARCHAR 15), `battery_level` (DECIMAL 0-100), `created_at` (TIMESTAMP)

Auto-created via Sequelize on first run.

##  AWS EC2 Deployment

```bash
# SSH to instance
ssh -i key.pem ubuntu@35.154.64.66

# Install dependencies
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs mosquitto mosquitto-clients

# Deploy
git clone <repo-url>
cd mqtt && npm install
cp .env.example .env
# Configure .env with production values

# Run as systemd service (optional)
sudo nano /etc/systemd/system/mqtt-backend.service
```

**SystemD Service:**
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

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable mqtt-backend
sudo systemctl start mqtt-backend
```

##  Testing

```bash
# Run device simulator
node iot-publisher.js

# Run test app
node dummy-app.js

# Monitor MQTT
mosquitto_sub -h 35.154.64.66 -p 1883 -u user -P pass -t "collar/#" -v

# Test location publishing
mosquitto_pub -h 35.154.64.66 -p 1883 -u imei -P pass \
  -t "collar/123456789012345/location" -m '[37.7749, -122.4194]'
```

##  Monitoring

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

##  Troubleshooting

| Issue | Solution |
|-------|----------|
| MQTT connection refused | Check Mosquitto running, port 1883 open, verify credentials |
| Database connection failed | Verify `DATABASE_URL` in `.env`, check Neon DB status at console.neon.tech |
| Device not found | Register device: `INSERT INTO devices (imei, is_on, is_walking) VALUES ('123456789012345', false, false);` |
| Data not saving | Ensure device `is_on = true` via `/isOn` endpoint |
| WebSocket disconnects | Check Express server running, port 3000 accessible |

##  Security Checklist

- [ ] Change default MQTT credentials
- [ ] Use strong passwords (16+ chars)
- [ ] Enable MQTT TLS/SSL
- [ ] Configure AWS Security Groups restrictively
- [ ] Add API authentication middleware
- [ ] Use HTTPS (nginx reverse proxy)
- [ ] Enable WSS for WebSocket
- [ ] Implement MQTT ACL
- [ ] Regular backups of Neon DB

##  Dependencies

`mqtt` `express` `sequelize` `pg` `ws` `body-parser` `dotenv` `axios`

##  Files

- **index.js** - Main server (MQTT, Express, WebSocket)
- **db.js** - Neon DB connection (Sequelize)
- **iot-publisher.js** - Device simulator
- **device-manager.js** - Device registration tool
- **dummy-app.js** - Test notification endpoint
- **models/** - Sequelize models (Device, Location, Battery)

---

**Status**: Production Ready  | **Last Updated**: Feb 8, 2026 | **Server**: 35.154.64.66
