#!/bin/bash

# 构建AndDrive Helper App脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER_APP_DIR="$PROJECT_ROOT/helper-app"
RESOURCES_DIR="$PROJECT_ROOT/resources"
APK_NAME="helper-app.apk"

echo "构建AndDrive Helper App..."

# 检查ANDROID_HOME
if [ -z "$ANDROID_HOME" ]; then
    if [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    elif [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    else
        echo "错误: 未设置ANDROID_HOME环境变量"
        echo "请安装Android SDK并设置ANDROID_HOME"
        exit 1
    fi
fi

echo "ANDROID_HOME: $ANDROID_HOME"

# 进入helper-app目录
cd "$HELPER_APP_DIR"

# 构建APK
echo "正在构建APK..."
if [ -x "./gradlew" ]; then
    ./gradlew assembleDebug
else
    gradle assembleDebug
fi

# 检查APK是否生成
APK_PATH="$HELPER_APP_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -s "$APK_PATH" ]; then
    echo "错误: APK构建失败"
    exit 1
fi

# 复制到resources目录
echo "复制APK到resources目录..."
cp "$APK_PATH" "$RESOURCES_DIR/$APK_NAME"

echo "构建完成!"
echo "APK位置: $RESOURCES_DIR/$APK_NAME"
