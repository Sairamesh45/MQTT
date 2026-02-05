# MQTT Backend for IoT Collar System

A Node.js-based MQTT backend system for managing IoT collar devices, handling location and battery data, and providing REST API endpoints for device control.

## Features

- **MQTT Communication**: Publishes and subscribes to MQTT topics for real-time data exchange
- **MongoDB Integration**: Stores device data, locations, battery levels, and sessions
- **REST API**: Express.js endpoints for device management and control
- **Device Management**: Tracks device status, last seen times, and active state
- **Session Control**: Manages device on/off states via MQTT commands

## Architecture

The system consists of:

- **Main Server** (`index.js`): MQTT client, Express server, and data handlers
- **Models**: Mongoose schemas for Device, Location, Session, and Battery data
- **Publisher** (`iot-publisher.js`): Simulates IoT device publishing location and battery data
- **Device Manager** (`device-manager.js`): Manages device registration and status
- **Lost Listener** (`isLost-listener.js`): Monitors device connectivity

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure your environment variables
4. Ensure MongoDB and MQTT broker are running

## Configuration

Create a `.env` file with the following variables:

```env
MONGO_URI=mongodb+srv://your_db_user:your_db_password@cluster0.buhtzae.mongodb.net/test
MQTT_HOST=your_mqtt_host
MQTT_PORT=1883
MQTT_USERNAME=your_mqtt_username
MQTT_PASSWORD=your_mqtt_password
ACCESS_TOKEN=your_access_token
PUBLISH_INTERVAL=5000
```

## Usage

### Starting the Server

```bash
node index.js
```

The server will:

- Connect to MongoDB
- Start the Express server on port 3000
- Connect to MQTT broker and subscribe to topics

### Running the IoT Publisher

```bash
node iot-publisher.js
```

This will prompt for MQTT credentials and start publishing simulated data.

## MQTT Topics

### Subscriptions (Server)

- `collar/+/location`: Receives location data from devices
- `collar/+/battery`: Receives battery level data from devices

### Publications (Server)

- `collar/{imei}/isOn`: Publishes session state changes
- `collar/{imei}/isWalking`: Publishes walking state updates

### Publications (Publisher)

- `collar/{imei}/location`: Publishes location data
- `collar/{imei}/battery`: Publishes battery data

## API Endpoints

### POST /isOn

Controls device session state.

**Request Body:**

```json
{
  "imei": "device_imei",
  "isOn": true
}
```

**Response:**

```json
{
  "success": true
}
```

### POST /isWalking

Updates device walking status.

**Request Body:**

```json
{
  "imei": "device_imei",
  "isWalking": true
}
```

## Data Models

### Device

```javascript
{
  imei: String,
  isOn: Boolean,
  lastSeen: Date,
  accessToken: String
}
```

### Location

```javascript
{
  imei: String,
  latitude: Number,
  longitude: Number,
  timestamp: Date
}
```

### Battery

```javascript
{
  imei: String,
  batteryLevel: Number,
  timestamp: Date
}
```

### Session

```javascript
{
  imei: String,
  isOn: Boolean
}
```

## Scripts

### index.js

Main server file handling MQTT communication and REST API.

**Key Functions:**

- `saveLocationToMongo(imei, latitude, longitude)`: Validates and saves location data
- `saveBatteryToMongo(imei, batteryLevel)`: Validates and saves battery data
- `startMQTTClient()`: Initializes MQTT connection and subscriptions
- `startExpressServer()`: Starts Express server with API endpoints

### iot-publisher.js

Simulates an IoT device publishing data.

**Key Functions:**

- `publishLocation(client)`: Publishes GPS coordinates
- `publishBattery(client)`: Publishes battery level
- `getGPSLatitude()`, `getGPSLongitude()`: Simulated GPS data
- `getBatteryLevel()`: Simulated battery data

### device-manager.js

Manages device registration and status updates.

### isLost-listener.js

Listens for isLost status updates and notifies the app API.

### dummy-app.js

Simple Express server for testing isLost notifications. Configurable via environment variables.

**Environment Variables:**

- `DUMMY_APP_HOST`: Host to bind to (default: `localhost`)
- `DUMMY_APP_PORT`: Port to listen on (default: `3001`)

**Endpoints:**

- `POST /isLost`: Receives and logs isLost notifications
- `GET /health`: Health check endpoint

## MQTT Message Formats

### Location Data

```json
[37.7749, -122.4194]
```

### Battery Data

```json
[85.67]
```

### Control Messages

- `collar/{imei}/isOn`: `true` or `false`
- `collar/{imei}/isWalking`: `true` or `false`

## Dependencies

- **mqtt**: MQTT client library
- **mongoose**: MongoDB ODM
- **express**: Web framework
- **body-parser**: JSON parsing middleware
- **dotenv**: Environment variable management

## Development

### Running with Mosquitto

1. Install Mosquitto MQTT broker
2. Configure authentication in `mosquitto_passwords.txt`
3. Start Mosquitto with custom config:
   ```bash
   mosquitto -c mosquitto-custom.conf
   ```

### Testing

1. Start the backend server: `node index.js`
2. Run the dummy app for testing notifications: `node dummy-app.js`
3. Run the isLost listener: `node isLost-listener.js`
4. Publish control messages:

   ```bash
   # To start publishing
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isOn -m "true"

   # To stop publishing
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isOn -m "false"

   # To set walking state
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isWalking -m "true"
   ```

5. Check MongoDB for stored data
6. Monitor dummy app logs for received notifications

### Testing Control Messages

To test the control functionality:

1. Start the IoT publisher: `node iot-publisher.js`
2. Publish control messages using mosquitto_pub:

   ```bash
   # Enable data publishing
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isOn -m "true"

   # Disable data publishing
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isOn -m "false"

   # Set walking state
   mosquitto_pub -h localhost -p 1883 -u {imei} -P {password} -t collar/{imei}/isWalking -m "true"
   ```

3. Monitor the publisher console for responses

## License

ISC</content>
<parameter name="filePath">d:\mqtt-backend\README.md
