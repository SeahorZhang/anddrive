package com.andrive.helper;

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
 * Runs as shell (uid 2000): `CLASSPATH=<base.apk> app_process /system/bin com.andrive.helper.ListMain`
 * The APK is only a code container — no component is started and no permission
 * is granted to the package. The result is a single JSON line on stdout:
 * `{"apps":[{"packageName","label","iconPng"?}]}`.
 */
public final class ListMain {

    private static final String SELF_PACKAGE = "com.andrive.helper";
    private static final int ICON_SIZE_PX = 256;
    private static final int ICON_QUALITY = 80;

    private ListMain() { }

    public static void main(String[] args) {
        try {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Context context = systemContext();
            PackageManager pm = context.getPackageManager();

            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> activities = pm.queryIntentActivities(launcher, 0);

            Map<String, JSONObject> unique = new LinkedHashMap<>();
            for (ResolveInfo info : activities) {
                ApplicationInfo appInfo = info.activityInfo != null ? info.activityInfo.applicationInfo : null;
                if (appInfo == null || (appInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
                String pkg = appInfo.packageName;
                // The helper itself has a desktop-icon stub activity; hide it
                // from AndDrive's own list.
                if (SELF_PACKAGE.equals(pkg) || unique.containsKey(pkg)) continue;

                JSONObject obj = new JSONObject();
                obj.put("packageName", pkg);
                obj.put("label", safeLabel(pm, info, pkg));
                String iconBase64 = safeIconBase64(pm, info);
                if (iconBase64 != null) obj.put("iconPng", iconBase64);
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
            System.exit(1);
        }
    }

    private static Context systemContext() throws Exception {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        Object at = atClass.getDeclaredMethod("systemMain").invoke(null);
        return (Context) atClass.getMethod("getSystemContext").invoke(at);
    }

    private static String safeLabel(PackageManager pm, ResolveInfo info, String fallback) {
        try {
            CharSequence label = info.loadLabel(pm);
            if (label != null && label.length() > 0) return label.toString();
        } catch (Throwable ignored) { }
        return fallback;
    }

    /** @return PNG bytes of the icon scaled to a square of {@code sizePx}, or null on failure. */
    private static String safeIconBase64(PackageManager pm, ResolveInfo info) {
        try {
            Drawable drawable = info.loadIcon(pm);
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
