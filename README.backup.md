# MQTT IoT Collar System - Production Documentation

A production-ready Node.js-based MQTT backend system for managing IoT collar devices with real-time location tracking, battery monitoring, and WebSocket streaming capabilities.

## 🌐 AWS Deployment Information

### Server Details

- **Public IPv4 Address**: `35.154.64.66`
- **Private IPv4 Address**: `172.31.38.175`
- **Region**: AWS EC2 Instance

### Service URLs

- **REST API**: `http://35.154.64.66:3000`
- **WebSocket**: `ws://35.154.64.66:3000`
- **MQTT Broker**: `mqtt://35.154.64.66:1883`

### Security Group Configuration

Ensure the following ports are open in AWS Security Group:

- **Port 3000**: Express REST API and WebSocket Server
- **Port 1883**: MQTT Broker (Mosquitto)

## 📋 System Overview

This system provides a complete IoT infrastructure for managing collar devices with:

- Real-time location tracking via MQTT
- Battery level monitoring
- Device state management (on/off, walking status)
- WebSocket streaming for live updates
- Neon DB (Serverless PostgreSQL) data persistence
- RESTful API for device control

## 🏗️ Architecture

```
┌─────────────┐         MQTT          ┌──────────────┐
│ IoT Devices │ ◄──────────────────► │    Mosquitto  │
│  (Collars)  │    collar/+/location  │ MQTT Broker  │
│             │    collar/+/battery   │              │
└─────────────┘    collar/+/isLost    └──────┬───────┘
                                              │
                                              │ Subscribe
                   ┌──────────────────────────▼──────┐
                   │   Node.js Backend Server        │
                   │   - MQTT Client                 │
                   │   - Express REST API            │
┌─────────────┐    │   - WebSocket Server           │    ┌──────────────┐
│  Web/Mobile │◄───┤   - Data Validation            ├───►│   Neon DB    │
│   Clients   │    │   - isLost Listener            │    │   Database   │
└─────────────┘    └─────────────────────────────────┘    └──────────────┘
    WebSocket              HTTP REST API                    Sequelize ORM
    (Real-time)           (Device Control)                  (Data Storage)
```

### Components

1. **Main Server** ([index.js](index.js)): Core application handling MQTT, REST API, and WebSocket
2. **Neon DB Database**: Serverless PostgreSQL for persistent storage of devices, locations, and battery data
3. **MQTT Broker (Mosquitto)**: Message broker for IoT communication
4. **IoT Publisher** ([iot-publisher.js](iot-publisher.js)): Device simulator for testing
5. **Device Manager** ([device-manager.js](device-manager.js)): Device registration utility
6. **Dummy App** ([dummy-app.js](dummy-app.js)): Test API endpoint for notifications

## 🚀 Installation & Deployment

### Prerequisites

- Node.js 18+ installed
- Neon DB account and database (https://neon.tech)
- Mosquitto MQTT broker
- AWS EC2 instance with appropriate security groups

### Local Development Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd mqtt
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   # Edit .env with your Neon DB connection string
   ```

4. **Start Mosquitto MQTT Broker**

   ```bash
   mosquitto -c mosquitto-custom.conf
   ```

5. **Run the application**

   ```bash
   node index.js
   ```

   **Note**: No need to install PostgreSQL locally - Neon DB is cloud-hosted!

### AWS EC2 Deployment

1. **Connect to EC2 instance**

   ```bash
   ssh -i your-key.pem ubuntu@35.154.64.66
   ```

2. **Install Node.js**

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Install Mosquitto**

   ```bash
   sudo apt-get install -y mosquitto mosquitto-clients
   ```

4. **Deploy application**

   ```bash
   git clone <repository-url>
   cd mqtt
   npm install
   cp .env.example .env
   # Configure .env with Neon DB connection string and production values
   ```

5. **Configure as system service (optional)**

   ```bash
   sudo nano /etc/systemd/system/mqtt-backend.service
   ```

   Add:

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

   Enable and start:

   ```bash
   sudo systemctl enable mqtt-backend
   sudo systemctl start mqtt-backend
   sudo systemctl status mqtt-backend
   ```

### Docker Deployment

```bash
# Build image
docker build -t mqtt-backend .

# Run container
docker run -d \
  --name mqtt-backend \
  -p 3000:3000 \
  --env-file .env \
  mqtt-backend
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
# Neon DB Database (Serverless PostgreSQL)
DATABASE_URL=postgresql://user:password@ep-xxx-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require

# MQTT Broker Configuration
MQTT_HOST=35.154.64.66
MQTT_PORT=1883
MQTT_USERNAME=mqtt_user
MQTT_PASSWORD=secure_password

# API Server Configuration
API_HOST=0.0.0.0
PORT=3000

# Application Settings
ACCESS_TOKEN=your_secure_access_token
PUBLISH_INTERVAL=5000

# Dummy App for Testing
DUMMY_APP_HOST=localhost
DUMMY_APP_PORT=3001
APP_API_URL=http://localhost:3001/isLost
```

### Production Configuration (AWS)

For the AWS deployment at **35.154.64.66**, use:

```env
# Neon DB Database (get from Neon Dashboard)
DATABASE_URL=postgresql://user:password@ep-xxx-xxx.us-east-2.aws.neon.tech/mqtt_iot_db?sslmode=require

# MQTT Broker
MQTT_HOST=172.31.38.175
MQTT_PORT=1883
MQTT_USERNAME=<mqtt_username>
MQTT_PASSWORD=<mqtt_password>

# API Server (bind to all interfaces for external access)
API_HOST=0.0.0.0
PORT=3000

# Application Settings
ACCESS_TOKEN=<production_token>
PUBLISH_INTERVAL=5000

APP_API_URL=http://35.154.64.66:3001/isLost
DUMMY_APP_HOST=0.0.0.0
DUMMY_APP_PORT=3001
```

## 📡 MQTT Topics

### Server Subscriptions (Incoming from Devices)

| Topic Pattern       | Description                           | Payload Format          | Example                |
| ------------------- | ------------------------------------- | ----------------------- | ---------------------- |
| `collar/+/location` | Receives GPS coordinates from devices | `[latitude, longitude]` | `[37.7749, -122.4194]` |
| `collar/+/battery`  | Receives battery level from devices   | `[batteryLevel]`        | `[85.5]`               |
| `collar/+/isLost`   | Receives device lost status           | `true` or `false`       | `true`                 |

### Server Publications (Outgoing to Devices)

| Topic Pattern             | Description                  | Payload Format    | Retained | Example |
| ------------------------- | ---------------------------- | ----------------- | -------- | ------- |
| `collar/{imei}/isOn`      | Controls device active state | `true` or `false` | Yes      | `true`  |
| `collar/{imei}/isWalking` | Controls device walking mode | `true` or `false` | Yes      | `false` |

### Topic Structure

```
collar/
  ├── {imei}/
  │   ├── location      (device → server)
  │   ├── battery       (device → server)
  │   ├── isLost        (device → server)
  │   ├── isOn          (server → device)
  │   └── isWalking     (server → device)
```

### MQTT Message Examples

**Publishing Location (from device)**

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 \
  -u device_imei -P device_password \
  -t "collar/123456789012345/location" \
  -m '[37.7749, -122.4194]'
```

**Publishing Battery (from device)**

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 \
  -u device_imei -P device_password \
  -t "collar/123456789012345/battery" \
  -m '[75.5]'
```

**Subscribing to All Topics (testing)**

```bash
mosquitto_sub -h 35.154.64.66 -p 1883 \
  -u mqtt_username -P mqtt_password \
  -t "collar/#" -v
```

## 🔌 REST API Endpoints

Base URL: `http://35.154.64.66:3000`

### POST /isOn

Controls the active state of a device. When a device is turned off, it stops publishing data.

**Request:**

```http
POST /isOn HTTP/1.1
Host: 35.154.64.66:3000
Content-Type: application/json

{
  "imei": "123456789012345",
  "isOn": true
}
```

**Response:**

```json
{
  "success": true
}
```

**MQTT Side Effect**: Publishes retained message to `collar/{imei}/isOn` topic

**Example using curl:**

```bash
curl -X POST http://35.154.64.66:3000/isOn \
  -H "Content-Type: application/json" \
  -d '{"imei":"123456789012345","isOn":true}'
```

**Validation Rules:**

- `imei` must be a 15-character string
- `isOn` must be a boolean value
- Device must exist in database

**Error Responses:**

```json
// Missing IMEI
{ "error": "IMEI is required" }

// Invalid IMEI format
{ "error": "IMEI must be a 15-character string" }

// Invalid isOn value
{ "error": "isOn must be a boolean (true or false)" }

// Device not found
{ "error": "Device not found" }
```

### POST /isWalking

Controls the walking mode of a device, which may affect data publishing frequency.

**Request:**

```http
POST /isWalking HTTP/1.1
Host: 35.154.64.66:3000
Content-Type: application/json

{
  "imei": "123456789012345",
  "isWalking": true
}
```

**Response:**

```json
{
  "success": true
}
```

**MQTT Side Effect**: Publishes retained message to `collar/{imei}/isWalking` topic

**Example using curl:**

```bash
curl -X POST http://35.154.64.66:3000/isWalking \
  -H "Content-Type: application/json" \
  -d '{"imei":"123456789012345","isWalking":false}'
```

**Validation Rules:**

- `imei` must be a 15-character string
- `isWalking` must be a boolean value
- Device must exist in database

## 🔄 WebSocket API

Real-time streaming of device data via WebSocket connection.

### Connection

Connect to: `ws://35.154.64.66:3001`

**With Session ID (resume existing session):**

```
ws://35.154.64.66:3001?sessionId=session_abc123xyz
```

**Without Session ID (new session):**

```
ws://35.154.64.66:3001
```

### Message Types

#### 1. Session Initialization (Server → Client)

```json
{
  "type": "session",
  "sessionId": "session_abc123xyz"
}
```

#### 2. Location Update (Server → Client)

```json
{
  "type": "location",
  "imei": "123456789012345",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "timestamp": "2026-02-08T10:30:45.123Z"
}
```

#### 3. Battery Update (Server → Client)

```json
{
  "type": "battery",
  "imei": "123456789012345",
  "batteryLevel": 85.5,
  "timestamp": "2026-02-08T10:30:45.123Z"
}
```

### JavaScript Client Example

```javascript
const ws = new WebSocket("ws://35.154.64.66:3000");

ws.onopen = () => {
  console.log("Connected to WebSocket server");
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case "session":
      console.log("Session ID:", data.sessionId);
      // Store sessionId for reconnection
      localStorage.setItem("sessionId", data.sessionId);
      break;

    case "location":
      console.log(
        `Device ${data.imei} location:`,
        data.latitude,
        data.longitude,
      );
      // Update map or UI
      break;

    case "battery":
      console.log(`Device ${data.imei} battery:`, data.batteryLevel + "%");
      // Update battery indicator
      break;
  }
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
};

ws.onclose = () => {
  console.log("WebSocket connection closed");
  // Implement reconnection logic
};
```

### Session Management

Sessions are maintained server-side and mapped to WebSocket connections. When a device publishes data, it's broadcast to all active WebSocket sessions.

**Features:**

- Automatic session ID generation for new connections
- Session resumption using stored session ID
- Automatic cleanup of stale connections
- Broadcast to multiple concurrent clients

## 💾 Database Schema

The system uses Neon DB (Serverless PostgreSQL) with Sequelize ORM.

### Device Table

| Column       | Type        | Constraints                 | Description             |
| ------------ | ----------- | --------------------------- | ----------------------- |
| `id`         | INTEGER     | PRIMARY KEY, AUTO_INCREMENT | Unique device ID        |
| `imei`       | VARCHAR(15) | UNIQUE, NOT NULL            | Device IMEI             |
| `is_on`      | BOOLEAN     | DEFAULT false               | Device active state     |
| `is_walking` | BOOLEAN     | DEFAULT false               | Walking mode state      |
| `last_seen`  | TIMESTAMP   |                             | Last activity timestamp |
| `created_at` | TIMESTAMP   | NOT NULL                    | Record creation time    |
| `updated_at` | TIMESTAMP   | NOT NULL                    | Record update time      |

### Location Table

| Column       | Type          | Constraints                 | Description        |
| ------------ | ------------- | --------------------------- | ------------------ |
| `id`         | INTEGER       | PRIMARY KEY, AUTO_INCREMENT | Unique location ID |
| `imei`       | VARCHAR(15)   | NOT NULL                    | Device IMEI        |
| `latitude`   | DECIMAL(10,8) | NOT NULL                    | GPS latitude       |
| `longitude`  | DECIMAL(11,8) | NOT NULL                    | GPS longitude      |
| `created_at` | TIMESTAMP     | NOT NULL                    | Record timestamp   |
| `updated_at` | TIMESTAMP     | NOT NULL                    | Record update time |

**Constraints:**

- Latitude: -90 to 90
- Longitude: -180 to 180
- Foreign key to Device table

### Battery Table

| Column          | Type         | Constraints                 | Description        |
| --------------- | ------------ | --------------------------- | ------------------ |
| `id`            | INTEGER      | PRIMARY KEY, AUTO_INCREMENT | Unique battery ID  |
| `imei`          | VARCHAR(15)  | NOT NULL                    | Device IMEI        |
| `battery_level` | DECIMAL(5,2) | NOT NULL                    | Battery percentage |
| `created_at`    | TIMESTAMP    | NOT NULL                    | Record timestamp   |
| `updated_at`    | TIMESTAMP    | NOT NULL                    | Record update time |

**Constraints:**

- Battery level: 0 to 100
- Foreign key to Device table

### Database Initialization

The database schema is automatically created on first run via Sequelize sync:

```javascript
sequelize.sync(); // Creates tables if they don't exist
```

For production, use migrations:

```bash
npx sequelize-cli db:migrate
```

## 📱 Device Management

### Registering a New Device

Use the device manager utility:

```bash
node device-manager.js
```

Or manually insert into Neon DB using psql or a database client:

```sql
INSERT INTO devices (imei, is_on, is_walking, last_seen, created_at, updated_at)
VALUES ('123456789012345', false, false, NOW(), NOW(), NOW());
```

### Device Lifecycle

1. **Registration**: Device added to database
2. **Activation**: `is_on` set to `true` via `/isOn` endpoint
3. **Operation**: Device publishes location/battery data
4. **Monitoring**: Server validates and stores data
5. **Deactivation**: `is_on` set to `false` via `/isOn` endpoint

### Device States

| State               | `is_on` | `is_walking` | Behavior               |
| ------------------- | ------- | ------------ | ---------------------- |
| Inactive            | false   | -            | No data accepted       |
| Active - Stationary | true    | false        | Normal data publishing |
| Active - Walking    | true    | true         | Enhanced tracking mode |

## 🧪 Testing & Development

### Running the IoT Device Simulator

```bash
node iot-publisher.js
```

The simulator will:

1. Prompt for MQTT credentials
2. Generate random IMEI (or use provided one)
3. Publish simulated location and battery data
4. Listen for control commands (`isOn`, `isWalking`)

### Running the Dummy App (isLost Notification Handler)

```bash
node dummy-app.js
```

Endpoints:

- `POST http://35.154.64.66:3001/isLost` - Receives isLost notifications
- `GET http://35.154.64.66:3001/health` - Health check

### Testing WebSocket Connection

```bash
node test-ws.js
```

Or use a WebSocket client tool like **websocat**:

```bash
websocat ws://35.154.64.66:3000
```

### Manual Testing Commands

**Test location publishing:**

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 \
  -u 123456789012345 -P password \
  -t "collar/123456789012345/location" \
  -m '[37.7749, -122.4194]'
```

**Test battery publishing:**

```bash
mosquitto_pub -h 35.154.64.66 -p 1883 \
  -u 123456789012345 -P password \
  -t "collar/123456789012345/battery" \
  -m '[75.5]'
```

**Test device activation:**

```bash
curl -X POST http://35.154.64.66:3000/isOn \
  -H "Content-Type: application/json" \
  -d '{"imei":"123456789012345","isOn":true}'
```

**Monitor all MQTT traffic:**

```bash
mosquitto_sub -h 35.154.64.66 -p 1883 \
  -u admin -P admin_password \
  -t "#" -v
```

## 🔍 Monitoring & Logs

### Application Logs

View real-time logs:

```bash
# If running as systemd service
sudo journalctl -u mqtt-backend -f

# If running directly
tail -f /var/log/mqtt-backend.log
```

### Key Log Messages

```
✓ Neon DB connected successfully!
✓ Database synced!
✓ Express server running on http://0.0.0.0:3000
✓ WebSocket server initialized
[MQTT] Connected to broker
[MQTT] Subscribed to: collar/+/location
[MQTT] Subscribed to: collar/+/battery
✓ Location saved successfully
✓ Battery saved successfully
```

### Database Monitoring

Connect to Neon DB using:

```bash
psql $DATABASE_URL
```

Then run queries:

```sql
-- Check device count
SELECT COUNT(*) FROM devices;

-- Check recent locations
SELECT * FROM locations ORDER BY created_at DESC LIMIT 10;

-- Check battery levels
SELECT imei, battery_level, created_at
FROM batteries
ORDER BY created_at DESC
LIMIT 10;

-- Active devices
SELECT imei, is_on, is_walking, last_seen
FROM devices
WHERE is_on = true;
```

### MQTT Broker Monitoring

```bash
# Check Mosquitto status
sudo systemctl status mosquitto

# View Mosquitto logs
sudo tail -f /var/log/mosquitto/mosquitto.log

# Check active connections
sudo netstat -tulpn | grep 1883
```

## 🛠️ Troubleshooting

### Common Issues

#### 1. Cannot Connect to MQTT Broker

**Symptoms:**

```
[MQTT] Connection error: connect ECONNREFUSED
```

**Solutions:**

- Check Mosquitto is running: `sudo systemctl status mosquitto`
- Verify port 1883 is open in AWS Security Group
- Check credentials in `.env` file
- Test with mosquitto_pub/sub client

#### 2. Database Connection Failed

**Symptoms:**

```
✗ Database connection error: connection refused
```

**Solutions:**

- Verify Neon DB connection string in `.env`
- Check Neon DB status in Neon dashboard (https://console.neon.tech)
- Ensure database exists in Neon project
- Test connection: `psql $DATABASE_URL`
- Check if IP is allowlisted in Neon (if IP restrictions enabled)

#### 3. Device Data Not Saving

**Symptoms:**

```
✗ Device not found in database
✗ Device is not active
```

**Solutions:**

- Verify device exists: `SELECT * FROM devices WHERE imei='...'`
- Check device `is_on` status
- Activate device via `/isOn` endpoint
- Verify IMEI format (15 characters)

#### 4. WebSocket Connection Closes Immediately

**Symptoms:**

- WebSocket connects then immediately disconnects
- No session ID received

**Solutions:**

- Check Express server is running
- Verify port 3000 is accessible
- Check for firewall rules blocking WebSocket
- Review server logs for errors

#### 5. Invalid Coordinate Range Error

**Symptoms:**

```
✗ Invalid coordinate range
```

**Solutions:**

- Ensure latitude is between -90 and 90
- Ensure longitude is between -180 and 180
- Check data format is `[latitude, longitude]`
- Verify numeric types (not strings)

### Debug Mode

Enable detailed logging by modifying log level in code or environment:

```javascript
// Add to index.js
const DEBUG = process.env.DEBUG === "true";
```

```bash
# Run with debug
DEBUG=true node index.js
```

## 🔒 Security Considerations

### Production Security Checklist

- [ ] Change default MQTT credentials
- [ ] Use strong passwords (16+ characters)
- [ ] Enable MQTT TLS/SSL encryption
- [ ] Configure AWS Security Groups restrictively
- [ ] Use Neon DB connection pooling and secure connections
- [ ] Implement rate limiting on API endpoints
- [ ] Add API authentication tokens
- [ ] Enable HTTPS for REST API (use nginx reverse proxy)
- [ ] Use WSS (WebSocket Secure) instead of WS
- [ ] Implement MQTT ACL (Access Control List)
- [ ] Regular security updates: `sudo apt update && sudo apt upgrade`
- [ ] Monitor logs for suspicious activity
- [ ] Backup database regularly

### MQTT Security

The system includes Mosquitto ACL configuration:

**File: mosquitto_acl.conf**

```
# Each device can only publish to its own topics
user device1
topic write collar/device1/#

user device2
topic write collar/device2/#

# Admin can subscribe to all
user admin
topic read collar/#
```

**File: mosquitto_passwords.txt**

```
# Generate password file
mosquitto_passwd -c mosquitto_passwords.txt username
```

### API Authentication (Recommended Enhancement)

Add authentication middleware to Express:

```javascript
const authMiddleware = (req, res, next) => {
  const token = req.headers["authorization"];
  if (token !== process.env.API_AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.post("/isOn", authMiddleware, async (req, res) => {
  // ... handler code
});
```

## 📊 Performance Optimization

### Recommended Configuration for Production

**Neon DB optimizations:**

```sql
-- Add indexes for faster queries (connect via psql $DATABASE_URL)
CREATE INDEX idx_locations_imei ON locations(imei);
CREATE INDEX idx_locations_created_at ON locations(created_at);
CREATE INDEX idx_batteries_imei ON batteries(imei);
CREATE INDEX idx_devices_imei ON devices(imei);
```

**MQTT Broker tuning:**

```conf
# mosquitto-custom.conf
max_connections 1000
max_queued_messages 1000
message_size_limit 8192
```

**Node.js process management with PM2:**

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start index.js --name mqtt-backend

# Auto-restart on system reboot
pm2 startup
pm2 save

# Monitor
pm2 monit
```

## 📦 Dependencies

| Package     | Version | Purpose                         |
| ----------- | ------- | ------------------------------- |
| mqtt        | ^5.14.1 | MQTT client library             |
| express     | ^5.2.1  | Web framework for REST API      |
| sequelize   | ^6.37.7 | PostgreSQL ORM                  |
| pg          | ^8.18.0 | PostgreSQL driver               |
| ws          | -       | WebSocket server                |
| body-parser | -       | JSON request parsing            |
| dotenv      | ^17.2.3 | Environment variable management |
| axios       | ^1.6.0  | HTTP client for API calls       |

## 📄 License

ISC

## 👥 Support & Contact

For issues or questions:

1. Check troubleshooting section above
2. Review logs for error messages
3. Verify configuration and credentials
4. Test individual components (MQTT, DB, API) separately

## 🗺️ Roadmap

Potential enhancements:

- [ ] HTTPS/WSS support with SSL certificates
- [ ] User authentication and authorization
- [ ] Device geofencing alerts
- [ ] Historical data analytics dashboard
- [ ] Mobile app integration
- [ ] Multi-region deployment
- [ ] Data retention policies
- [ ] Automated alerts for low battery
- [ ] GPS trajectory visualization
- [ ] Device firmware update over MQTT

---

**Last Updated**: February 8, 2026  
**Server**: AWS EC2 - 35.154.64.66  
**Status**: Production Ready ✅
