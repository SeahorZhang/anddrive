# AndDrive Helper App

这是一个小型Android app，用于获取手机上已安装app的名称和图标。

## 功能

- 通过PackageManager获取所有已安装app的信息
- 启动HTTP server提供数据
- 通过adb forward将数据传回主机

## 编译

### 前提条件

1. 安装Android Studio 或 Android SDK
2. 设置ANDROID_HOME环境变量

### 编译步骤

```bash
cd helper-app
./gradlew assembleDebug
```

编译完成后，APK文件位于：
`helper-app/app/build/outputs/apk/debug/app-debug.apk`

### 复制到resources目录

```bash
cp helper-app/app/build/outputs/apk/debug/app-debug.apk ../resources/helper-app.apk
```

## 工作原理

1. 主机通过adb install安装helper app到手机
2. 启动helper app，它会在手机上启动一个HTTP server（端口18923）
3. 主机通过adb forward将手机端口转发到主机
4. 主机通过HTTP GET请求获取app列表数据
5. 获取完成后，停止helper app并移除端口转发

## API

### GET /apps

返回JSON格式的app列表：

```json
[
  {
    "packageName": "com.example.app",
    "label": "示例应用",
    "icon": "base64编码的PNG图标"
  }
]
```

## 注意事项

- 需要INTERNET权限（用于本地HTTP server）
- 图标会被缩放到48x48像素
- 端口：18923
