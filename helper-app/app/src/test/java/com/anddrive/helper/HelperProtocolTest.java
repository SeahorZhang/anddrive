package com.anddrive.helper;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public class HelperProtocolTest {
    @Test
    public void queryValueDecodesUtf8AndHandlesMissingValues() throws Exception {
        String encoded = URLEncoder.encode("com.example 电视", "UTF-8");
        assertEquals("com.example 电视", HelperProtocol.queryValue("/icon-bin?pkg=" + encoded, "pkg"));
        assertEquals("", HelperProtocol.queryValue("/icon-bin", "pkg"));
        assertEquals("", HelperProtocol.queryValue("/icon-bin?other=value", "pkg"));
    }

    @Test
    public void parsePackagesCapsBatchSize() {
        StringBuilder value = new StringBuilder();
        for (int index = 0; index < 40; index++) {
            if (index > 0) value.append(',');
            value.append("pkg").append(index);
        }
        String[] packages = HelperProtocol.parsePackages("/icons-bin?pkgs=" + value);
        assertEquals(HelperProtocol.MAX_BATCH_PACKAGES, packages.length);
        assertEquals("pkg0", packages[0]);
        assertEquals("pkg31", packages[31]);
    }

    @Test
    public void encodeIconBatchUsesBigEndianFramesAndPreservesOrder() {
        byte[] encoded = HelperProtocol.encodeIconBatch(
            new String[] {"com.one", "应用.two", "missing"},
            pkg -> "missing".equals(pkg) ? null : new byte[] {(byte) pkg.length()}
        );

        ByteBuffer buffer = ByteBuffer.wrap(encoded).order(ByteOrder.BIG_ENDIAN);
        assertFrame(buffer, "com.one", new byte[] {7});
        assertFrame(buffer, "应用.two", new byte[] {6});
        assertFrame(buffer, "missing", new byte[0]);
        assertEquals(0, buffer.remaining());
    }

    @Test
    public void encodeIconBatchSkipsLongNamesAndDropsOversizedIcons() {
        char[] characters = new char[HelperProtocol.MAX_PACKAGE_NAME_BYTES + 1];
        Arrays.fill(characters, 'a');
        String tooLong = new String(characters);
        byte[] oversizedIcon = new byte[HelperProtocol.MAX_ICON_BYTES + 1];

        byte[] encoded = HelperProtocol.encodeIconBatch(
            new String[] {tooLong, "com.large"},
            pkg -> oversizedIcon
        );

        ByteBuffer buffer = ByteBuffer.wrap(encoded).order(ByteOrder.BIG_ENDIAN);
        assertFrame(buffer, "com.large", new byte[0]);
        assertEquals(0, buffer.remaining());
    }

    private static void assertFrame(ByteBuffer buffer, String packageName, byte[] icon) {
        byte[] expectedName = packageName.getBytes(StandardCharsets.UTF_8);
        int nameLength = Short.toUnsignedInt(buffer.getShort());
        byte[] name = new byte[nameLength];
        buffer.get(name);
        int iconLength = buffer.getInt();
        byte[] actualIcon = new byte[iconLength];
        buffer.get(actualIcon);
        assertArrayEquals(expectedName, name);
        assertArrayEquals(icon, actualIcon);
    }
}
