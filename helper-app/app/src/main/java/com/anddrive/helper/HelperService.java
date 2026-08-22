package com.anddrive.helper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.UserHandle;
import android.os.UserManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;

public class HelperService extends Service {
    private static final String TAG = "AndDriveHelper";
    private static final int PORT = 18923;
    private static final int ICON_SIZE_PX = 256;
    private static final long APPS_CACHE_TTL_MS = 30_000L;
    private static final String CHANNEL_ID = "anddrive_helper";
    private static final String KEEPALIVE_TAG = "anddrive:mirror";
    // 唤醒锁最长持有时间：桌面端异常退出未释放时自动过期，避免 CPU 长期不眠耗电
    private static final long KEEPALIVE_MAX_MS = 12 * 60 * 60 * 1000L;
    private ServerSocket serverSocket;
    private final ExecutorService executor = Executors.newFixedThreadPool(8);
    private final Map<String, LauncherActivityInfo> appInfoCache = new ConcurrentHashMap<>();
    private final Map<String, byte[]> iconCache = new ConcurrentHashMap<>();
    private final Map<String, FutureTask<byte[]>> iconTasks = new ConcurrentHashMap<>();
    private volatile String appsJsonCache;
    private volatile long appsCacheTime;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(1, createNotification());
        startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "AndDrive Helper",
                NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification createNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
            .setContentTitle("AndDrive Helper")
            .setContentText("Running in background")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build();
    }

    /**
     * 投屏保活：持有 CPU 唤醒锁与 WiFi 低延迟锁，防止手机息屏后
     * 系统挂起 CPU / WiFi 进入省电模式，导致无线 ADB 视频流卡死。
     * 非引用计数：重复 acquire/release 幂等。
     */
    private synchronized void acquireKeepAlive() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, KEEPALIVE_TAG);
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(KEEPALIVE_MAX_MS);
        } catch (Exception e) {
            Log.e(TAG, "acquire wake lock error", e);
        }
        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, KEEPALIVE_TAG);
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } catch (Exception e) {
            Log.e(TAG, "acquire wifi lock error", e);
        }
    }

    /** 投屏结束时释放保活锁；服务销毁时兜底调用。 */
    private synchronized void releaseKeepAlive() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) { }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) { }
    }

    private void startServer() {
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(PORT);
                Log.i(TAG, "Server started on port " + PORT);
                while (!serverSocket.isClosed()) {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                }
            } catch (Exception e) {
                Log.e(TAG, "Server error", e);
            }
        }).start();
    }

    private void handleClient(Socket client) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
            String line = reader.readLine();
            if (line == null) { client.close(); return; }

            String path = line.split(" ")[1];
            while ((line = reader.readLine()) != null && !line.isEmpty()) { }

            if ("/apps".equals(path)) {
                writeResponse(client, "application/json; charset=utf-8", getAppsJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.startsWith("/icons-bin")) {
                writeResponse(client, "application/octet-stream", getIconsBinary(HelperProtocol.parsePackages(path)));
            } else if (path.startsWith("/icon-bin")) {
                String pkg = HelperProtocol.queryValue(path, "pkg");
                byte[] iconData = getIconBinary(pkg);
                if (iconData == null) writeStatus(client, "404 Not Found");
                else writeResponse(client, "application/octet-stream", iconData);
            } else if ("/device-info".equals(path)) {
                writeResponse(client, "application/json; charset=utf-8",
                    getDeviceInfoJson().getBytes(StandardCharsets.UTF_8));
            } else if ("/wake-lock/acquire".equals(path)) {
                acquireKeepAlive();
                writeResponse(client, "application/json; charset=utf-8",
                    "{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
            } else if ("/wake-lock/release".equals(path)) {
                releaseKeepAlive();
                writeResponse(client, "application/json; charset=utf-8",
                    "{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
            } else if ("/ping".equals(path)) {
                writeResponse(client, "application/json; charset=utf-8",
                    ("{\"ok\":true,\"protocol\":" + HelperProtocol.PROTOCOL_VERSION + ",\"batchIcons\":true}").getBytes(StandardCharsets.UTF_8));
            } else {
                writeStatus(client, "404 Not Found");
            }
            client.close();
        } catch (Exception e) {
            try { client.close(); } catch (Exception ignored) { }
        }
    }

    private void writeResponse(Socket client, String contentType, byte[] body) throws Exception {
        String resp = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        OutputStream os = client.getOutputStream();
        os.write(resp.getBytes(StandardCharsets.UTF_8));
        os.write(body);
        os.flush();
    }

    private void writeStatus(Socket client, String status) throws Exception {
        client.getOutputStream().write(("HTTP/1.1 " + status + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private synchronized String getAppsJson() {
        long now = System.currentTimeMillis();
        if (appsJsonCache != null && now - appsCacheTime < APPS_CACHE_TTL_MS) return appsJsonCache;

        try {
            Map<String, JSONObject> uniqueApps = new LinkedHashMap<>();
            appInfoCache.clear();
            iconCache.clear();
            iconTasks.clear();

            LauncherApps launcherApps = (LauncherApps) getSystemService(Context.LAUNCHER_APPS_SERVICE);
            UserManager userManager = (UserManager) getSystemService(Context.USER_SERVICE);
            if (launcherApps != null && userManager != null) {
                for (UserHandle userHandle : userManager.getUserProfiles()) {
                    List<LauncherActivityInfo> activities = launcherApps.getActivityList(null, userHandle);
                    for (LauncherActivityInfo info : activities) {
                        if ((info.getApplicationInfo().flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                        String pkg = info.getComponentName().getPackageName();
                        if (uniqueApps.containsKey(pkg)) continue;
                        appInfoCache.put(pkg, info);
                        JSONObject obj = new JSONObject();
                        obj.put("packageName", pkg);
                        obj.put("label", info.getLabel() == null ? pkg : info.getLabel().toString());
                        uniqueApps.put(pkg, obj);
                    }
                }
            } else {
                PackageManager pm = getPackageManager();
                List<PackageInfo> list = pm.getInstalledPackages(0);
                for (PackageInfo info : list) {
                    if ((info.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                    JSONObject obj = new JSONObject();
                    obj.put("packageName", info.packageName);
                    try { obj.put("label", pm.getApplicationLabel(info.applicationInfo).toString()); }
                    catch (Exception e) { obj.put("label", info.packageName); }
                    uniqueApps.put(info.packageName, obj);
                }
            }

            JSONArray apps = new JSONArray();
            for (JSONObject app : uniqueApps.values()) apps.put(app);
            JSONObject result = new JSONObject();
            result.put("apps", apps);
            result.put("count", apps.length());
            appsJsonCache = result.toString();
            appsCacheTime = now;
            return appsJsonCache;
        } catch (Exception e) {
            Log.e(TAG, "getAppsJson error", e);
            return "{\"error\":\"app list unavailable\"}";
        }
    }

    private String getDeviceInfoJson() {
        try {
            String model = Build.MODEL == null ? "" : Build.MODEL;
            String brand = Build.BRAND == null ? "" : Build.BRAND;
            String marketName = readSystemProperty("ro.product.marketname");
            String deviceName;
            if (marketName != null && !marketName.isEmpty()) {
                deviceName = (brand.isEmpty() || marketName.startsWith(brand))
                    ? marketName : brand + " " + marketName;
            } else {
                deviceName = (brand + " " + model).trim();
            }

            int battery = -1;
            boolean isCharging = false;
            IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent batteryIntent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? registerReceiver(null, filter, Context.RECEIVER_NOT_EXPORTED)
                : registerReceiver(null, filter);
            if (batteryIntent != null) {
                int level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                int status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                if (level >= 0 && scale > 0) battery = (int) Math.round(level * 100.0 / scale);
                isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL;
            }

            StatFs stat = new StatFs(Environment.getDataDirectory().getPath());
            long total = stat.getTotalBytes();
            long used = total - stat.getAvailableBytes();
            long totalGB = total / (1024L * 1024 * 1024);
            long usedGB = used / (1024L * 1024 * 1024);
            int storagePercent = total > 0 ? (int) Math.round(used * 100.0 / total) : 0;

            JSONObject obj = new JSONObject();
            obj.put("model", model);
            obj.put("brand", brand);
            obj.put("deviceName", deviceName);
            obj.put("battery", battery);
            obj.put("isCharging", isCharging);
            obj.put("storage", usedGB + "/" + totalGB);
            obj.put("storagePercent", storagePercent);
            return obj.toString();
        } catch (Exception e) {
            Log.e(TAG, "getDeviceInfoJson error", e);
            return "{\"error\":\"device info unavailable\"}";
        }
    }

    /**
     * 读取系统属性。SystemProperties 是隐藏 API，helper 以 debuggable 安装可豁免
     * hidden API 限制；读不到时返回空串，由调用方回退到 Build.MODEL。
     */
    private String readSystemProperty(String key) {
        try {
            Class<?> cls = Class.forName("android.os.SystemProperties");
            java.lang.reflect.Method get = cls.getMethod("get", String.class);
            Object value = get.invoke(null, key);
            return value == null ? "" : value.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private byte[] getIconsBinary(String[] packages) {
        return HelperProtocol.encodeIconBatch(packages, this::getIconBinary);
    }

    private byte[] getIconBinary(String pkg) {
        if (pkg == null || pkg.isEmpty()) return null;
        byte[] cached = iconCache.get(pkg);
        if (cached != null) return cached;

        FutureTask<byte[]> task = new FutureTask<>(() -> loadIconBinary(pkg));
        FutureTask<byte[]> existing = iconTasks.putIfAbsent(pkg, task);
        FutureTask<byte[]> activeTask = existing == null ? task : existing;
        if (existing == null) task.run();
        try {
            byte[] data = activeTask.get();
            if (data != null) iconCache.put(pkg, data);
            return data;
        } catch (Exception e) {
            Log.e(TAG, "Get binary icon error for " + pkg, e);
            return null;
        } finally {
            iconTasks.remove(pkg, activeTask);
        }
    }

    private byte[] loadIconBinary(String pkg) throws Exception {
        Drawable icon = null;
        LauncherActivityInfo info = appInfoCache.get(pkg);
        if (info != null) icon = info.getIcon(android.util.DisplayMetrics.DENSITY_DEFAULT);
        if (icon == null) icon = getPackageManager().getApplicationIcon(pkg);

        Bitmap bmp = toBitmap(icon);
        Bitmap scaled = Bitmap.createScaledBitmap(bmp, ICON_SIZE_PX, ICON_SIZE_PX, true);
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.PNG, 80, baos);
        byte[] data = baos.toByteArray();
        scaled.recycle();
        if (scaled != bmp) bmp.recycle();
        return data;
    }

    private Bitmap toBitmap(Drawable d) {
        if (d instanceof BitmapDrawable) return ((BitmapDrawable) d).getBitmap();
        int w = Math.max(d.getIntrinsicWidth(), 64);
        int h = Math.max(d.getIntrinsicHeight(), 64);
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        d.setBounds(0, 0, w, h);
        d.draw(c);
        return b;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        releaseKeepAlive();
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) { }
        executor.shutdownNow();
    }
}
