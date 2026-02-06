const WebSocket = require('ws');

// Connect to the WebSocket server
const ws = new WebSocket('ws://172.18.236.12:3000');

ws.on('open', function open() {
    console.log('Connected to WebSocket server');
});

ws.on('message', function incoming(data) {
    console.log('Received:', data.toString());
    const message = JSON.parse(data.toString());
    if (message.type === 'session') {
        console.log('Session ID:', message.sessionId);
    } else if (message.type === 'location') {
        console.log(`Location update - IMEI: ${message.imei}, Lat: ${message.latitude}, Lon: ${message.longitude}, Time: ${message.timestamp}`);
    } else if (message.type === 'battery') {
        console.log(`Battery update - IMEI: ${message.imei}, Level: ${message.batteryLevel}, Time: ${message.timestamp}`);
    }
});

ws.on('close', function close() {
    console.log('Disconnected from WebSocket server');
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

// Keep the script running
setInterval(() => {
    // Ping to keep alive if needed
}, 10000);