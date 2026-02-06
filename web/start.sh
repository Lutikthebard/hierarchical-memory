#!/bin/bash

cd "$(dirname "$0")"

echo "🚀 Starting Hierarchical Memory Dashboard..."
echo "📍 Location: $(pwd)"
echo "🌐 URL: http://localhost:3458"
echo ""

node server.js
