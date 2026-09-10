package com.anddrive.helper;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;

/**
 * Launcher entry point for the Helper App.
 *
 * Tapping the app icon opens Android's "Wireless debugging" screen so the user
 * can enable it and pair with AndDrive, then this activity finishes right away
 * (it uses a translucent theme, so nothing is drawn).
 *
 * Android exposes no public SDK intent for the wireless-debugging page, so the
 * Settings "QS tile long-press gateway" is used with the ADB wireless tile
 * component. A couple of OEM variants are attempted next, and the flow falls
 * back to Developer Options where "Wireless debugging" can be opened manually.
 */
public final class MainActivity extends Activity {

    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String GATEWAY_ACTIVITY =
            SETTINGS_PACKAGE + ".qstile.QSTileLongPressGatewayActivity";
    private static final String ADB_WIRELESS_TILE =
            SETTINGS_PACKAGE + ".development.qstile.AdbWirelessDebuggingDevelopmentTile";
    private static final String ACTION_WIRELESS_DEBUGGING =
            "com.android.settings.WIRELESS_DEBUGGING_SETTINGS";
    private static final String WIRELESS_DEBUGGING_ACTIVITY =
            SETTINGS_PACKAGE + ".Settings$WifiDebuggingActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!openWirelessDebugging()) openDeveloperOptions();
        finish();
    }

    /** @return true when a wireless-debugging deep link was started. */
    private boolean openWirelessDebugging() {
        Intent gateway = new Intent();
        gateway.setComponent(new ComponentName(SETTINGS_PACKAGE, GATEWAY_ACTIVITY));
        gateway.putExtra(Intent.EXTRA_COMPONENT_NAME,
                new ComponentName(SETTINGS_PACKAGE, ADB_WIRELESS_TILE));
        if (start(gateway)) return true;

        Intent byComponent = new Intent();
        byComponent.setComponent(new ComponentName(SETTINGS_PACKAGE, WIRELESS_DEBUGGING_ACTIVITY));
        if (start(byComponent)) return true;

        return start(new Intent(ACTION_WIRELESS_DEBUGGING));
    }

    private void openDeveloperOptions() {
        start(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
    }

    private boolean start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
            return true;
        } catch (Throwable ignored) {
            // Unknown component / no matching activity on this ROM: try the next option.
            return false;
        }
    }
}
