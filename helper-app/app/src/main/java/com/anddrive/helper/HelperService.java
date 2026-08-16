package com.anddrive.helper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class HelperService extends Service {
    private static final String TAG = "AndDriveHelper";
    private static final int PORT = 18923;
    private static final String CHANNEL_ID = "anddrive_helper";
    private ServerSocket serverSocket;
    private final ExecutorService executor = Executors.newCachedThreadPool();

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
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
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
            String body;
            int code = 200;

            if ("/apps".equals(path)) {
                body = getAppsJson();
            } else if (path.startsWith("/icon")) {
                String pkg = path.contains("?") ? path.split("\\?")[1].replace("pkg=", "") : "";
                body = getIconBase64(pkg);
                if (body == null) { code = 404; body = "{}"; }
            } else if ("/ping".equals(path)) {
                body = "{\"ok\":true}";
            } else {
                code = 404; body = "{\"error\":\"not found\"}";
            }

            byte[] bytes = body.getBytes("UTF-8");
            String resp = "HTTP/1.1 " + code + " OK\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
            OutputStream os = client.getOutputStream();
            os.write(resp.getBytes("UTF-8"));
            os.write(bytes);
            os.flush();
            client.close();
        } catch (Exception e) {
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private String getAppsJson() {
        try {
            PackageManager pm = getPackageManager();
            JSONArray apps = new JSONArray();
            List<PackageInfo> list = pm.getInstalledPackages(0);
            for (PackageInfo info : list) {
                // 过滤系统app
                if ((info.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                JSONObject obj = new JSONObject();
                obj.put("packageName", info.packageName);
                try { obj.put("label", pm.getApplicationLabel(info.applicationInfo).toString()); }
                catch (Exception e) { obj.put("label", info.packageName); }
                apps.put(obj);
            }
            JSONObject result = new JSONObject();
            result.put("apps", apps);
            result.put("count", apps.length());
            return result.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    private String getIconBase64(String pkg) {
        try {
            Log.d(TAG, "Getting icon for: " + pkg);
            Drawable icon = getPackageManager().getApplicationIcon(pkg);
            Bitmap bmp = toBitmap(icon);
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, 48, 48, true);
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.PNG, 80, baos);
            byte[] data = baos.toByteArray();
            scaled.recycle();
            if (scaled != bmp) bmp.recycle();
            Log.d(TAG, "Icon got for: " + pkg + " size=" + data.length);
            return Base64.encodeToString(data, Base64.NO_WRAP);
        } catch (Exception e) {
            Log.e(TAG, "Get icon error for " + pkg, e);
            return null;
        }
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
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) {}
        executor.shutdownNow();
    }
}
