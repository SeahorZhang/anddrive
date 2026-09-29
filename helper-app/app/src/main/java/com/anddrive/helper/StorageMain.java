package com.anddrive.helper;

import android.content.Context;
import android.os.Looper;
import android.os.StatFs;
import android.os.storage.StorageManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.lang.reflect.Method;
import java.util.List;

/**
 * app_process one-shot storage probe:
 * `CLASSPATH=<base.apk> app_process /system/bin com.anddrive.helper.StorageMain [userId]`
 *
 * 口径与 AndroMeld 的 helper 逐条对齐（它的 `StorageMain volumes <userId>` 在同一台机器上
 * 报 total 528.0 GB / used 255.8 GB，而 `df`、`stat -f`、`dumpsys diskstats` 三者都给
 * 512.4 GB —— 差的那 ~15.6 GB 是保留区）：**内部卷的总容量不走 StatFs**，走
 * `StorageStatsManager.getTotalBytes(UUID_DEFAULT)`；可用量仍取 `StatFs.getAvailableBytes()`。
 * 这样桌面端显示的「总共 / 已用」和手机设置、和竞品是同一个数。
 */
public final class StorageMain {

    private static final String SHELL_PACKAGE = "com.android.shell";

    private StorageMain() { }

    public static void main(String[] args) {
        try {
            int userId = args.length >= 1 ? Integer.parseInt(args[0]) : 0;
            if (userId < 0) throw new IllegalArgumentException("Negative userId");
            System.out.println(probe(userId));
            System.out.flush();
            System.exit(0);
        } catch (Throwable t) {
            Throwable cause = t;
            while (cause instanceof java.lang.reflect.InvocationTargetException && cause.getCause() != null) {
                cause = cause.getCause();
            }
            System.err.println("StorageMain failed: " + cause.getClass().getSimpleName() + ": " + cause.getMessage());
            System.exit(1);
        }
    }

    static JSONObject probe(int userId) throws Exception {
        Context context = systemContext();
        StorageManager storageManager = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
        List<Object> volumes = asVolumeInfos(storageManager);
        Class<?> volumeInfo = Class.forName("android.os.storage.VolumeInfo");

        JSONArray items = new JSONArray();
        for (Object volume : volumes) {
            int type = (Integer) call(volumeInfo, "getType", volume);
            // TYPE_PUBLIC(0) 与 TYPE_EMULATED(2)：TYPE_PRIVATE(1) 是底层挂载点，用户翻不到，
            // 只在需要 findPrivateForEmulated 反查时用到。
            if (type != 0 && type != 2) continue;
            if (!Boolean.TRUE.equals(call(volumeInfo, "isMountedReadable", volume))) continue;
            boolean visible = Boolean.TRUE.equals(call(volumeInfo, "isVisibleForRead", int.class, userId, volume))
                    || Boolean.TRUE.equals(call(volumeInfo, "isVisibleForWrite", int.class, userId, volume));
            if (!visible) continue;

            File pathForUser = (File) call(volumeInfo, "getPathForUser", int.class, userId, volume);
            String id = (String) call(volumeInfo, "getId", volume);
            boolean internal = type == 2 && (id.equals("emulated") || id.startsWith("emulated;"));

            Object privateVolume = volume;
            if (type == 2 && !internal) {
                privateVolume = callInstance(storageManager, "findPrivateForEmulated", volumeInfo, volume);
            }
            if (privateVolume == null) throw new IllegalStateException("Missing private backing volume");

            String fsUuid = (String) call(volumeInfo, "getFsUuid", privateVolume);
            String description = internal
                    ? null
                    : (String) callInstance(storageManager, "getBestVolumeDescription", volumeInfo, privateVolume);
            if (internal) {
                id = "internal";
                fsUuid = "internal";
            }

            String path = internal ? "/storage/emulated/" + userId : pathForUser.getAbsolutePath();
            StatFs statFs = new StatFs(path);
            long totalBytes = internal
                    ? totalBytesViaStatsService()
                    : statFs.getTotalBytes();

            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("kind", internal ? "internal" : (type == 0 ? "adopted" : "portable"));
            obj.put("description", description == null ? JSONObject.NULL : description);
            obj.put("path", path);
            obj.put("totalBytes", totalBytes);
            obj.put("freeBytes", statFs.getAvailableBytes());
            obj.put("entryCount", entryCount(path));
            items.put(obj);
        }

        JSONObject result = new JSONObject();
        result.put("volumes", items);
        result.put("rootEntries", entryCount("/"));
        return result;
    }

    /**
     * 内部卷的总容量走存储统计服务，而不是 StatFs：服务返回的是带保留区的卷容量，
     * 和手机设置/竞品同一个数（这台机上 528.0 GB vs StatFs 的 512.4 GB）。
     *
     * 直接打 binder 而不是 `getSystemService(StorageStatsManager)`：服务端会按
     * `callingPackage` 反查 uid，app_process 里拿到的包上下文是 "android"，会被判成别人；
     * 传 `com.android.shell` 才和我们的 uid 2000 对得上。方法签名按名字找，避免绑死某个版本。
     * volumeUuid 传 **null**：这台 HyperOS 上把 `StorageManager.UUID_DEFAULT` 原样送过去会被服务
     * 判成「找不到该 UUID」，null 才走默认卷（实测 null → 528000000000，UUID_DEFAULT → 抛错）。
     */
    private static long totalBytesViaStatsService() throws Exception {
        Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "storagestats");
        Class<?> stub = Class.forName("android.app.usage.IStorageStatsManager$Stub");
        Object manager = stub.getMethod("asInterface", Class.forName("android.os.IBinder")).invoke(null, binder);
        for (Method candidate : manager.getClass().getMethods()) {
            Class<?>[] params = candidate.getParameterTypes();
            if ("getTotalBytes".equals(candidate.getName())
                    && params.length == 2 && params[0] == String.class && params[1] == String.class) {
                return (Long) candidate.invoke(manager, (Object) null, SHELL_PACKAGE);
            }
        }
        throw new NoSuchMethodException("IStorageStatsManager.getTotalBytes(String, String)");
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asVolumeInfos(StorageManager storageManager) throws Exception {
        return (List<Object>) storageManager.getClass().getMethod("getVolumes").invoke(storageManager);
    }

    private static Object call(Class<?> owner, String name, Object target) throws Exception {
        Method method = owner.getMethod(name);
        return method.invoke(target);
    }

    private static Object call(Class<?> owner, String name, Class<?> argType, int arg, Object target) throws Exception {
        Method method = owner.getMethod(name, argType);
        return method.invoke(target, arg);
    }

    private static Object callInstance(Object owner, String name, Class<?> argType, Object arg) throws Exception {
        Method method = owner.getClass().getMethod(name, argType);
        return method.invoke(owner, arg);
    }

    /** 顶层条目数；读不到（权限/不存在）返回 -1，让桌面端区分「空目录」和「看不见」。 */
    private static int entryCount(String path) {
        String[] names = new File(path).list();
        return names == null ? -1 : names.length;
    }

    /** 与 {@code ListMain} 同一套 shell (uid 2000) 系统上下文引导。 */
    private static Context systemContext() throws Exception {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        try {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Object at = atClass.getDeclaredMethod("systemMain").invoke(null);
            return (Context) atClass.getMethod("getSystemContext").invoke(at);
        } catch (Throwable primary) {
            Object current = atClass.getMethod("currentActivityThread").invoke(null);
            if (current != null) {
                return (Context) atClass.getMethod("getSystemContext").invoke(current);
            }
            throw primary;
        }
    }
}
