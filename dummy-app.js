const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.DUMMY_APP_PORT || 3001;
const HOST = process.env.DUMMY_APP_HOST || `http://${process.env.DUMMY_APP_HOST}:${process.env.DUMMY_APP_PORT}/isLost`;

// POST /isLost endpoint to receive isLost notifications
app.post('/isLost', (req, res) => {
    const { imei, isLost } = req.body;
    console.log(`[DUMMY APP] Received isLost notification:`);
    console.log(`  IMEI: ${imei}`);
    console.log(`  isLost: ${isLost}`);
    console.log(`  Timestamp: ${new Date().toISOString()}`);
    console.log('---');

    // Respond with success
    res.json({ success: true, message: 'isLost status received' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Dummy app is running', timestamp: new Date().toISOString() });
});

app.listen(PORT, HOST, (err) => {
    if (err) {
        console.error(`[DUMMY APP] Failed to start server on ${HOST}:${PORT}:`, err.message);
        process.exit(1);
    }
    console.log(`[DUMMY APP] Server running on http://${HOST}:${PORT}`);
    console.log(`[DUMMY APP] POST /isLost endpoint ready for testing`);
    console.log(`[DUMMY APP] GET /health for health check`);
});