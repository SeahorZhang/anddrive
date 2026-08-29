package com.andrive.helper;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/**
 * Desktop-icon shortcut: tapping the helper icon jumps to the system Wireless
 * Debugging page with the QR-pairing entry auto-clicked by the accessibility
 * service. Until that service is enabled once, tapping instead opens the
 * accessibility settings page so the user can flip the switch.
 */
public class MainActivity extends Activity {

    private static final String ACTION_WIRELESS_DEBUGGING =
            "android.settings.WIRELESS_DEBUGGING_SETTINGS";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (isAutoClickServiceEnabled()) {
            QrAutoClickService.arm(15000);
            openWirelessDebugging();
        } else {
            Toast.makeText(this, "请先开启「AndDrive 扫码直达」无障碍开关", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        }
        finish();
    }

    private boolean isAutoClickServiceEnabled() {
        String enabled =
                Settings.Secure.getString(getContentResolver(), "enabled_accessibility_services");
        return enabled != null && enabled.contains(getPackageName())
                && enabled.contains(QrAutoClickService.class.getSimpleName());
    }

    private void openWirelessDebugging() {
        // 1) Public settings action (Android 12+, honored by most ROMs)
        if (tryStart(new Intent(ACTION_WIRELESS_DEBUGGING))) return;
        // 2) AOSP Settings sub-page component
        if (tryStart(
                new Intent(Intent.ACTION_MAIN)
                        .setClassName("com.android.settings",
                                "com.android.settings.Settings$WirelessDebuggingActivity")))
            return;
        // 3) Last resort: the developer settings page one level up
        tryStart(new Intent("android.settings.APPLICATION_DEVELOPMENT_SETTINGS"));
    }

    private boolean tryStart(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
