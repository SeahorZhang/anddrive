package com.anddrive.helper;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Process;
import android.os.UserHandle;
import android.os.UserManager;
import android.util.DisplayMetrics;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * app_process 入口类
 * 运行在 shell (uid=2000) 身份下
 */
public class LaunchableAppsMain {

    private static final int PORT = 18923;
    private static ServerSocket serverSocket;
    private static final ExecutorService executor = Executors.newCachedThreadPool();
    private static final Map<String, LauncherActivityInfo> appInfoCache = new HashMap<>();
    private static Context context;
    private static final Map<String, byte[]> iconCache = new HashMap<>();

    public static void main(String[] args) {
        System.err.println("[LaunchableAppsMain] Starting...");

        // 验证 uid
        int uid = Process.myUid();
        System.err.println("[LaunchableAppsMain] UID: " + uid);
        if (uid != 2000) {
            System.err.println("[LaunchableAppsMain] WARNING: Not running as shell (uid=2000), current uid=" + uid);
        }

        try {
            // 获取系统 Context
            System.err.println("[LaunchableAppsMain] Getting system context...");
            context = MirrorRuntimeWorkarounds.systemContext();

            if (context == null) {
                System.err.println("[LaunchableAppsMain] Failed to get context, exiting");
                System.exit(1);
                return;
            }

            System.err.println("[LaunchableAppsMain] Got context, package: " + context.getPackageName());

            // 测试 LauncherApps
            System.err.println("[LaunchableAppsMain] Testing LauncherApps...");
            LauncherApps launcherApps = (LauncherApps) context.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            UserManager userManager = (UserManager) context.getSystemService(Context.USER_SERVICE);

            if (launcherApps == null) {
                System.err.println("[LaunchableAppsMain] LauncherApps is null!");
                System.exit(1);
                return;
            }
            if (userManager == null) {
                System.err.println("[LaunchableAppsMain] UserManager is null!");
                System.exit(1);
                return;
            }

            // 获取 app 列表并预加载图标
            System.err.println("[LaunchableAppsMain] Loading app list and icons...");
            loadAppsAndIcons(launcherApps, userManager);
            System.err.println("[LaunchableAppsMain] Loaded " + appInfoCache.size() + " apps, " + iconCache.size() + " icons");

            // 启动服务器
            System.err.println("[LaunchableAppsMain] Starting server on port " + PORT);
            serverSocket = new ServerSocket(PORT);
            System.err.println("[LaunchableAppsMain] Server started");

            // 通知就绪
            System.out.println("READY");
            System.out.flush();

            // 处理请求
            while (!serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                } catch (Exception e) {
                    if (!serverSocket.isClosed()) {
                        System.err.println("[LaunchableAppsMain] Accept error: " + e);
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("[LaunchableAppsMain] Fatal error: " + e);
            e.printStackTrace();
            System.exit(1);
        }
    }

    private static void handleClient(Socket client) {
        try {
            System.err.println("[LaunchableAppsMain] Handling client request...");
            java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(client.getInputStream()));
            String line = reader.readLine();
            if (line == null) {
                client.close();
                return;
            }

            String path = line.split(" ")[1];
            System.err.println("[LaunchableAppsMain] Request path: " + path);

            while ((line = reader.readLine()) != null && !line.isEmpty()) {}

            if ("/apps".equals(path)) {
                String body = getAppsJson();
                sendJson(client, body);
            } else if (path.startsWith("/icon-bin")) {
                String pkg = path.contains("?") ? path.split("\\?")[1].replace("pkg=", "") : "";
                byte[] iconData = getIconBinary(pkg);
                if (iconData == null) {
                    send404(client);
                } else {
                    sendBinary(client, iconData);
                }
            } else if ("/ping".equals(path)) {
                sendJson(client, "{\"ok\":true}");
            } else if ("/exit".equals(path)) {
                sendJson(client, "{\"ok\":true}");
                client.close();
                shutdown();
                return;
            } else {
                send404(client);
            }
            client.close();
        } catch (Exception e) {
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private static void sendJson(Socket client, String json) throws Exception {
        byte[] bytes = json.getBytes("UTF-8");
        String resp = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Content-Length: " + bytes.length + "\r\n"
            + "Connection: close\r\n\r\n";
        OutputStream os = client.getOutputStream();
        os.write(resp.getBytes("UTF-8"));
        os.write(bytes);
        os.flush();
    }

    private static void sendBinary(Socket client, byte[] data) throws Exception {
        String resp = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/octet-stream\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Content-Length: " + data.length + "\r\n"
            + "Connection: close\r\n\r\n";
        OutputStream os = client.getOutputStream();
        os.write(resp.getBytes("UTF-8"));
        os.write(data);
        os.flush();
    }

    private static void send404(Socket client) throws Exception {
        String resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
        client.getOutputStream().write(resp.getBytes("UTF-8"));
    }

    /**
     * 加载 app 列表（不加载图标，避免图形系统问题）
     */
    private static void loadAppsAndIcons(LauncherApps launcherApps, UserManager userManager) {
        appInfoCache.clear();

        for (UserHandle userHandle : userManager.getUserProfiles()) {
            List<LauncherActivityInfo> activities = launcherApps.getActivityList(null, userHandle);
            for (LauncherActivityInfo info : activities) {
                if ((info.getApplicationInfo().flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;

                String pkg = info.getComponentName().getPackageName();
                appInfoCache.put(pkg, info);
            }
        }
    }

    private static byte[] drawableToBytes(Drawable d) {
        try {
            Bitmap bmp = toBitmap(d);
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, 48, 48, true);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.PNG, 80, baos);
            byte[] data = baos.toByteArray();
            scaled.recycle();
            if (scaled != bmp) bmp.recycle();
            return data;
        } catch (Exception e) {
            return null;
        }
    }

    private static String getAppsJson() {
        try {
            System.err.println("[LaunchableAppsMain] getAppsJson called, cache size: " + appInfoCache.size());
            JSONArray apps = new JSONArray();

            for (String pkg : appInfoCache.keySet()) {
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("packageName", pkg);
                    // 只使用包名，避免调用 getLabel() 触发图形系统问题
                    obj.put("label", pkg);
                    apps.put(obj);
                } catch (Exception e) {
                    System.err.println("[LaunchableAppsMain] Error processing app " + pkg + ": " + e);
                }
            }

            JSONObject result = new JSONObject();
            result.put("apps", apps);
            result.put("count", apps.length());
            System.err.println("[LaunchableAppsMain] getAppsJson returning " + apps.length() + " apps");
            return result.toString();
        } catch (Exception e) {
            System.err.println("[LaunchableAppsMain] getAppsJson error: " + e);
            e.printStackTrace();
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    private static byte[] getIconBinary(String pkg) {
        // app_process 环境下不获取图标，返回 null
        // 图标通过 HelperService 获取
        return null;
    }

    private static Bitmap toBitmap(Drawable d) {
        if (d instanceof BitmapDrawable) return ((BitmapDrawable) d).getBitmap();
        int w = Math.max(d.getIntrinsicWidth(), 64);
        int h = Math.max(d.getIntrinsicHeight(), 64);
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        d.setBounds(0, 0, w, h);
        d.draw(c);
        return b;
    }

    private static void shutdown() {
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) {}
        executor.shutdownNow();
        System.exit(0);
    }
}
