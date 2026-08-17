package com.anddrive.helper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.IBinder;
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
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
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
    private static final int PROTOCOL_VERSION = 3;
    private static final int ICON_SIZE_PX = 256;
    private static final int MAX_BATCH_PACKAGES = 32;
    private static final int MAX_PACKAGE_NAME_BYTES = 512;
    private static final int MAX_ICON_BYTES = 1024 * 1024;
    private static final long APPS_CACHE_TTL_MS = 30_000L;
    private static final String CHANNEL_ID = "anddrive_helper";
    private ServerSocket serverSocket;
    private final ExecutorService executor = Executors.newFixedThreadPool(8);
    private final Map<String, LauncherActivityInfo> appInfoCache = new ConcurrentHashMap<>();
    private final Map<String, byte[]> iconCache = new ConcurrentHashMap<>();
    private final Map<String, FutureTask<byte[]>> iconTasks = new ConcurrentHashMap<>();
    private volatile String appsJsonCache;
    private volatile long appsCacheTime;

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
                writeResponse(client, "application/octet-stream", getIconsBinary(parsePackages(path)));
            } else if (path.startsWith("/icon-bin")) {
                String pkg = queryValue(path, "pkg");
                byte[] iconData = getIconBinary(pkg);
                if (iconData == null) writeStatus(client, "404 Not Found");
                else writeResponse(client, "application/octet-stream", iconData);
            } else if ("/ping".equals(path)) {
                writeResponse(client, "application/json; charset=utf-8",
                    ("{\"ok\":true,\"protocol\":" + PROTOCOL_VERSION + ",\"batchIcons\":true}").getBytes(StandardCharsets.UTF_8));
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

    private String queryValue(String path, String key) {
        int queryStart = path.indexOf('?');
        if (queryStart < 0) return "";
        for (String pair : path.substring(queryStart + 1).split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2 && key.equals(parts[0])) {
                try { return URLDecoder.decode(parts[1], "UTF-8"); }
                catch (Exception ignored) { return parts[1]; }
            }
        }
        return "";
    }

    private String[] parsePackages(String path) {
        String value = queryValue(path, "pkgs");
        if (value.isEmpty()) return new String[0];
        String[] raw = value.split(",");
        int count = Math.min(raw.length, MAX_BATCH_PACKAGES);
        String[] result = new String[count];
        System.arraycopy(raw, 0, result, 0, count);
        return result;
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

    private byte[] getIconsBinary(String[] packages) {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            for (String pkg : packages) {
                if (pkg == null || pkg.isEmpty()) continue;
                byte[] name = pkg.getBytes(StandardCharsets.UTF_8);
                if (name.length > MAX_PACKAGE_NAME_BYTES) continue;
                byte[] icon = getIconBinary(pkg);
                if (icon != null && icon.length > MAX_ICON_BYTES) icon = null;
                output.write(ByteBuffer.allocate(2).order(ByteOrder.BIG_ENDIAN).putShort((short) name.length).array());
                output.write(name);
                output.write(ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(icon == null ? 0 : icon.length).array());
                if (icon != null) output.write(icon);
            }
            return output.toByteArray();
        } catch (Exception e) {
            Log.e(TAG, "getIconsBinary error", e);
            return new byte[0];
        }
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
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) { }
        executor.shutdownNow();
    }
}
