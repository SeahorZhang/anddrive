package com.anddrive.helper;

import java.io.ByteArrayOutputStream;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Pure protocol helpers shared by the HTTP service and local JVM tests. */
public final class HelperProtocol {
    public static final int PROTOCOL_VERSION = 4;
    public static final int MAX_BATCH_PACKAGES = 32;
    public static final int MAX_PACKAGE_NAME_BYTES = 512;
    public static final int MAX_ICON_BYTES = 1024 * 1024;

    private HelperProtocol() {}

    public static String queryValue(String path, String key) {
        int queryStart = path.indexOf('?');
        if (queryStart < 0) return "";
        for (String pair : path.substring(queryStart + 1).split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2 && key.equals(parts[0])) {
                try {
                    return URLDecoder.decode(parts[1], "UTF-8");
                } catch (Exception ignored) {
                    return parts[1];
                }
            }
        }
        return "";
    }

    public static String[] parsePackages(String path) {
        String value = queryValue(path, "pkgs");
        if (value.isEmpty()) return new String[0];
        String[] raw = value.split(",");
        int count = Math.min(raw.length, MAX_BATCH_PACKAGES);
        String[] result = new String[count];
        System.arraycopy(raw, 0, result, 0, count);
        return result;
    }

    public static byte[] encodeIconBatch(String[] packages, IconProvider provider) {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            for (String pkg : packages) {
                if (pkg == null || pkg.isEmpty()) continue;
                byte[] name = pkg.getBytes(StandardCharsets.UTF_8);
                if (name.length > MAX_PACKAGE_NAME_BYTES) continue;
                byte[] icon = provider.iconFor(pkg);
                if (icon != null && icon.length > MAX_ICON_BYTES) icon = null;
                ByteBuffer header = ByteBuffer.allocate(2).order(ByteOrder.BIG_ENDIAN);
                header.putShort((short) name.length);
                output.write(header.array());
                output.write(name);
                ByteBuffer length = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN);
                length.putInt(icon == null ? 0 : icon.length);
                output.write(length.array());
                if (icon != null) output.write(icon);
            }
            return output.toByteArray();
        } catch (Exception ignored) {
            return new byte[0];
        }
    }

    public interface IconProvider {
        byte[] iconFor(String packageName);
    }
}
