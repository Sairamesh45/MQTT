const mqtt = require("mqtt");
const Location = require("./models/location");
const Device = require("./models/device");
const mongoose = require("mongoose");

// Explicitly set the database name
const mongoUri = "mongodb+srv://sairamesh4551621_db_user:7eu1kp022ZgjLhyf@cluster0.buhtzae.mongodb.net/test";

// Connect to MongoDB first
mongoose.connect(mongoUri)
    .then(() => {
        console.log("✓ MongoDB connected successfully!");
        console.log("✓ Database: test");
        console.log("✓ Collection: locations");
        
        // Only connect to MQTT after MongoDB is ready
        startMQTTClient();
    })
    .catch(err => {
        console.error("✗ MongoDB connection error:", err.message);
        process.exit(1);
    });

// Function to save location to MongoDB after validation
async function saveLocationToMongo(imei, latitude, longitude, accessToken) {
    console.log("\n--- Received Data ---");
    console.log("IMEI:", imei);
    console.log("Latitude:", latitude);
    console.log("Longitude:", longitude);
    console.log("Access Token:", accessToken);
    
    // Validate access token against MongoDB
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
        
        if (!device.verifyToken(accessToken)) {
            console.log("✗ Invalid access token");
            return false;
        }
        
        console.log("✓ Access token validated");
        
        // Update last seen
        device.lastSeen = new Date();
        await device.save();
        
    } catch (err) {
        console.error("✗ Token validation error:", err.message);
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
    const client = mqtt.connect("mqtt://10.104.74.45:1883", {
        username: "123456789012345",
        password: "my-device-secret"
    });

    client.on('connect', () => {
        console.log("\n✓ Connected to MQTT broker");
        console.log("✓ Subscribed to: collar/+/location");
        console.log("\nWaiting for messages...\n");
        client.subscribe("collar/+/location");
    });

    client.on('error', (err) => {
        console.error("✗ MQTT Error:", err.message);
    });

    client.on('message', async (topic, message) => {
        console.log("\n=== New MQTT Message ===");
        console.log("Topic:", topic);
        console.log("Raw message:", message.toString());

        const parts = topic.split("/");
        const imei = parts[1];

        let data;
        try {
            data = JSON.parse(message.toString());
            console.log("Parsed JSON:", data);
            if (typeof data.latitude !== "undefined" && typeof data.longitude !== "undefined") {
                console.log(`Received latitude: ${data.latitude}, longitude: ${data.longitude}`);
            }
        } catch (err) {
            console.log("✗ Invalid JSON format:", err.message);
            return;
        }

        if (!data.accessToken) {
            console.log("✗ Missing access token in message");
            return;
        }

        // Use the helper function for validation and saving
        await saveLocationToMongo(imei, data.latitude, data.longitude, data.accessToken);
    });
}