#!/bin/bash
# Hierarchical Memory System Startup Script

cd "$(dirname "$0")"

echo "🧠 Starting Hierarchical Memory System..."
echo ""

# Kill existing processes
pkill -f "hierarchical-memory.*server.js" 2>/dev/null
pkill -f "hierarchical-memory.*watch.js" 2>/dev/null
sleep 1

# Start backend
cd web
nohup node server.js > /tmp/hierarchical-memory-server.log 2>&1 &
SERVER_PID=$!

sleep 2

# Check if started successfully
if ps -p $SERVER_PID > /dev/null; then
    echo "✅ Server started (PID: $SERVER_PID)"
    echo "📊 Dashboard: http://localhost:3458"
    echo "🔧 API: http://localhost:3458/api/agents"
    echo ""
    echo "Logs: /tmp/hierarchical-memory-server.log"
    echo ""
    echo "To stop: pkill -f 'hierarchical-memory.*server.js'"
else
    echo "❌ Failed to start server"
    echo "Check logs: /tmp/hierarchical-memory-server.log"
    exit 1
fi
