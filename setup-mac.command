#!/bin/bash
cd "$(dirname "$0")"
clear
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "         Setting up us. app"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌  Node.js is not installed."
    echo "    Please install it from: https://nodejs.org"
    echo "    Then double-click this file again."
    read -p "Press Enter to close..."
    exit 1
fi

echo "✓  Node.js found: $(node --version)"
echo ""
echo "Installing dependencies..."
npm install
echo ""
echo "Building app..."
npm run build
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Done! The 'dist' folder is ready."
echo "    Follow STEP 2 in the guide to deploy."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
open .
