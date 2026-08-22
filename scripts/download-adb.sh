#!/bin/bash

# Download macOS ADB binary
# Run this script to download ADB binaries on first build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB_DIR="$SCRIPT_DIR/../resources/adb"

mkdir -p "$ADB_DIR"

# macOS（AndDrive 仅支持 macOS）
if [ ! -f "$ADB_DIR/mac/adb" ]; then
  echo "Downloading ADB for macOS..."
  mkdir -p "$ADB_DIR/mac"
  curl -L "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip" -o "$ADB_DIR/platform-tools-mac.zip"
  unzip -o "$ADB_DIR/platform-tools-mac.zip" -d "$ADB_DIR/mac"
  mv "$ADB_DIR/mac/platform-tools/adb" "$ADB_DIR/mac/adb"
  rm -rf "$ADB_DIR/mac/platform-tools" "$ADB_DIR/platform-tools-mac.zip"
fi
chmod +x "$ADB_DIR/mac/adb"

if command -v lipo >/dev/null 2>&1; then
  lipo -verify_arch arm64 x86_64 "$ADB_DIR/mac/adb"
fi

echo "ADB binary downloaded successfully!"
