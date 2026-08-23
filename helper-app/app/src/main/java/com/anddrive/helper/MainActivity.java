package com.andrive.helper;

import android.app.Activity;
import android.os.Bundle;

/**
 * Launcher stub only: makes the helper visible on the device desktop. It does
 * nothing — tapping the icon opens and immediately closes an empty activity.
 */
public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        finish();
    }
}
