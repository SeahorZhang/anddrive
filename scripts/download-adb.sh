#!/bin/bash

# Download ADB binaries for all platforms
# Run this script to download ADB binaries on first build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB_DIR="$SCRIPT_DIR/../resources/adb"

mkdir -p "$ADB_DIR"

# macOS
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

# Windows
if [ ! -f "$ADB_DIR/win/adb.exe" ]; then
  echo "Downloading ADB for Windows..."
  mkdir -p "$ADB_DIR/win"
  curl -L "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -o "$ADB_DIR/platform-tools-win.zip"
  unzip -o "$ADB_DIR/platform-tools-win.zip" -d "$ADB_DIR/win"
  mv "$ADB_DIR/win/platform-tools/adb.exe" "$ADB_DIR/win/adb.exe"
  mv "$ADB_DIR/win/platform-tools/AdbWinApi.dll" "$ADB_DIR/win/AdbWinApi.dll" 2>/dev/null || true
  mv "$ADB_DIR/win/platform-tools/AdbWinUsbApi.dll" "$ADB_DIR/win/AdbWinUsbApi.dll" 2>/dev/null || true
  rm -rf "$ADB_DIR/win/platform-tools" "$ADB_DIR/platform-tools-win.zip"
fi
for file in adb.exe AdbWinApi.dll AdbWinUsbApi.dll; do
  if [ ! -s "$ADB_DIR/win/$file" ]; then
    echo "Missing Windows ADB file: $file" >&2
    exit 1
  fi
done

# Linux
if [ ! -f "$ADB_DIR/linux/adb" ]; then
  echo "Downloading ADB for Linux..."
  mkdir -p "$ADB_DIR/linux"
  curl -L "https://dl.google.com/android/repository/platform-tools-latest-linux.zip" -o "$ADB_DIR/platform-tools-linux.zip"
  unzip -o "$ADB_DIR/platform-tools-linux.zip" -d "$ADB_DIR/linux"
  mv "$ADB_DIR/linux/platform-tools/adb" "$ADB_DIR/linux/adb"
  rm -rf "$ADB_DIR/linux/platform-tools" "$ADB_DIR/platform-tools-linux.zip"
  chmod +x "$ADB_DIR/linux/adb"
fi
chmod +x "$ADB_DIR/mac/adb" "$ADB_DIR/linux/adb"

echo "ADB binaries downloaded successfully!"
