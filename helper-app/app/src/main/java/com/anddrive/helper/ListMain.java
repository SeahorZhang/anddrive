package com.anddrive.helper;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * app_process one-shot entry point.
 *
 * Runs as shell (uid 2000): `CLASSPATH=<base.apk> app_process /system/bin com.anddrive.helper.ListMain`
 * The APK is only a code container — no component is started and no permission
 * is granted to the package. The result is a single JSON line on stdout:
 * `{"apps":[{"packageName","label","iconPng"?}]}` — iconPng appears only in `--icons` mode.
 */
public final class ListMain {

    private static final String SELF_PACKAGE = "com.anddrive.helper";
    private static final int ICON_SIZE_PX = 128;
    private static final int ICON_QUALITY = 80;

    private ListMain() { }

    public static void main(String[] args) {
        try {
            Context context = systemContext();
            PackageManager pm = context.getPackageManager();

            // `--icons pkg1,pkg2,...` returns icons for exactly those packages;
            // no args lists all launchable third-party apps with labels only.
            if (args.length >= 2 && "--icons".equals(args[0])) {
                System.out.println(iconMode(pm, args[1].split(",")));
                System.out.flush();
                System.exit(0);
            }

            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> activities = pm.queryIntentActivities(launcher, 0);

            Map<String, JSONObject> unique = new LinkedHashMap<>();
            for (ResolveInfo info : activities) {
                ApplicationInfo appInfo =
                        info.activityInfo != null ? info.activityInfo.applicationInfo : null;
                if (appInfo == null || (appInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0)
                    continue;
                String pkg = appInfo.packageName;
                // Guard against the helper ever listing itself.
                if (SELF_PACKAGE.equals(pkg) || unique.containsKey(pkg)) continue;

                JSONObject obj = new JSONObject();
                obj.put("packageName", pkg);
                obj.put("label", safeLabel(pm, info, pkg));
                unique.put(pkg, obj);
            }

            JSONArray apps = new JSONArray(unique.values());
            JSONObject result = new JSONObject();
            result.put("apps", apps);
            System.out.println(result);
            System.out.flush();
            System.exit(0);
        } catch (Throwable t) {
            t.printStackTrace();
            System.err.flush();
            System.exit(1);
        }
    }

    /**
     * A system Context for shell (uid 2000) code with no running ActivityThread.
     * {@code ActivityThread.systemMain()} builds a Handler in its constructor,
     * which needs a main Looper or it throws
     * "Can't create handler inside thread ... that has not called Looper.prepare()".
     */
    private static Context systemContext() throws Exception {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        try {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Object at = atClass.getDeclaredMethod("systemMain").invoke(null);
            return (Context) atClass.getMethod("getSystemContext").invoke(at);
        } catch (Throwable primary) {
            // Some builds abort inside systemMain(); fall back to an already
            // running ActivityThread when one exists.
            Object current = atClass.getMethod("currentActivityThread").invoke(null);
            if (current != null) {
                return (Context) atClass.getMethod("getSystemContext").invoke(current);
            }
            throw primary;
        }
    }

    private static String safeLabel(PackageManager pm, ResolveInfo info, String fallback) {
        try {
            CharSequence label = info.loadLabel(pm);
            if (label != null && label.length() > 0) return label.toString();
        } catch (Throwable ignored) { }
        return fallback;
    }

    /** Icons (base64 PNG) for the requested packages; failures yield no entry. */
    private static JSONObject iconMode(PackageManager pm, String[] packages) throws Exception {
        JSONArray apps = new JSONArray();
        for (String pkg : packages) {
            if (pkg == null || pkg.isEmpty()) continue;
            try {
                ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
                JSONObject obj = new JSONObject();
                obj.put("packageName", pkg);
                String iconBase64 = safeIconBase64(info.loadIcon(pm));
                if (iconBase64 != null) obj.put("iconPng", iconBase64);
                apps.put(obj);
            } catch (Throwable ignored) {
                // Unknown/removed package: skip silently.
            }
        }
        return new JSONObject().put("apps", apps);
    }

    /** @return base64 PNG of the icon scaled to {@code ICON_SIZE_PX}, or null on failure. */
    private static String safeIconBase64(Drawable drawable) {
        try {
            Bitmap bitmap = toSquareBitmap(drawable, ICON_SIZE_PX);
            ByteArrayOutputStream png = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, ICON_QUALITY, png);
            byte[] data = png.toByteArray();
            bitmap.recycle();
            return android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP);
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * Render any drawable into a square bitmap. Recycles the source when it is
     * a bitmap that had to be rescaled onto a fresh one.
     */
    private static Bitmap toSquareBitmap(Drawable d, int sizePx) {
        if (!(d instanceof BitmapDrawable)) {
            int w = Math.max(d.getIntrinsicWidth(), sizePx);
            int h = Math.max(d.getIntrinsicHeight(), sizePx);
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            d.setBounds(0, 0, w, h);
            d.draw(c);
            return square(b, sizePx);
        }
        Bitmap source = ((BitmapDrawable) d).getBitmap();
        Bitmap result = square(source, sizePx);
        if (result != source) source.recycle();
        return result;
    }

    private static Bitmap square(Bitmap source, int sizePx) {
        int w = source.getWidth(), h = source.getHeight();
        if (w == h && w > 0 && w <= sizePx) return source;
        int side = w >= h ? w : h;
        if (side <= 0) side = sizePx;
        return Bitmap.createScaledBitmap(source, side, side, true);
    }
}
