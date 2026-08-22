#!/bin/bash

# 构建 AndDrive Helper App（test | lint | assemble）
# 用法: ./scripts/build-helper.sh [test|lint|assemble]，默认 assemble

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER_APP_DIR="$PROJECT_ROOT/helper-app"
RESOURCES_DIR="$PROJECT_ROOT/resources"
APK_NAME="helper-app.apk"
MODE="${1:-assemble}"

case "$MODE" in
  test) GRADLE_TASK="testDebugUnitTest" ;;
  lint) GRADLE_TASK="lintDebug" ;;
  assemble) GRADLE_TASK="assembleDebug" ;;
  *)
    echo "用法: $0 [test|lint|assemble]" >&2
    exit 1
    ;;
esac

echo "构建 AndDrive Helper App ($MODE)..."

# 检查 ANDROID_HOME / 常见 SDK 安装位置
if [ -z "$ANDROID_HOME" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  else
    echo "错误: 未设置 ANDROID_HOME 环境变量" >&2
    echo "请安装 Android SDK 并设置 ANDROID_HOME" >&2
    exit 1
  fi
fi

echo "ANDROID_HOME: $ANDROID_HOME"

# 始终使用项目自带 gradlew，不依赖系统 Gradle 安装
GRADLEW="$HELPER_APP_DIR/gradlew"
if [ ! -x "$GRADLEW" ]; then
  echo "错误: $GRADLEW 不存在或不可执行" >&2
  echo "请在 helper-app 目录执行: chmod +x gradlew" >&2
  exit 1
fi

"$GRADLEW" -p "$HELPER_APP_DIR" "$GRADLE_TASK"

if [ "$MODE" = "assemble" ]; then
  APK_PATH="$HELPER_APP_DIR/app/build/outputs/apk/debug/app-debug.apk"
  if [ ! -s "$APK_PATH" ]; then
    echo "错误: APK 构建失败" >&2
    exit 1
  fi
  mkdir -p "$RESOURCES_DIR"
  cp "$APK_PATH" "$RESOURCES_DIR/$APK_NAME"
  echo "构建完成! APK 位置: $RESOURCES_DIR/$APK_NAME"
else
  echo "$MODE 完成!"
fi
