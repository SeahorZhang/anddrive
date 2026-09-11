package com.anddrive.helper;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;

/**
 * 桌面图标入口：打开系统无线调试的二维码配对界面。
 * 等价于：
 * adb shell am start -n com.android.settings/.qstile.QSTileLongPressGatewayActivity \
 *   --ecn android.intent.extra.COMPONENT_NAME \
 *   com.android.settings/com.android.settings.development.qstile.AdbWirelessDebuggingDevelopmentTile
 */
public final class QrPairActivity extends Activity {

    private static final String SETTINGS = "com.android.settings";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(SETTINGS, SETTINGS + ".qstile.QSTileLongPressGatewayActivity"));
        intent.putExtra(Intent.EXTRA_COMPONENT_NAME,
                new ComponentName(SETTINGS, SETTINGS + ".development.qstile.AdbWirelessDebuggingDevelopmentTile"));
        try {
            startActivity(intent);
        } catch (Exception ignored) {
        }
        finish();
    }
}
