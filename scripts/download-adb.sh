#!/bin/bash

# Download ADB binary for macOS
# Run this script to download the ADB binary on first build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB_DIR="$SCRIPT_DIR/../resources/adb"

mkdir -p "$ADB_DIR"

if [ ! -f "$ADB_DIR/mac/adb" ]; then
  echo "Downloading ADB for macOS..."
  mkdir -p "$ADB_DIR/mac"
  curl -L "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip" -o "$ADB_DIR/platform-tools-mac.zip"
  unzip -o "$ADB_DIR/platform-tools-mac.zip" -d "$ADB_DIR/mac"
  mv "$ADB_DIR/mac/platform-tools/adb" "$ADB_DIR/mac/adb"
  rm -rf "$ADB_DIR/mac/platform-tools" "$ADB_DIR/platform-tools-mac.zip"
  chmod +x "$ADB_DIR/mac/adb"
fi
if command -v lipo >/dev/null 2>&1; then
  lipo -verify_arch arm64 x86_64 "$ADB_DIR/mac/adb"
fi

echo "ADB binary downloaded successfully!"
