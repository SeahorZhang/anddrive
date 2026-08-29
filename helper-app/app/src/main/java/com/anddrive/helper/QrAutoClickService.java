package com.andrive.helper;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.Queue;

/**
 * Auto-clicks the QR-pairing row on the system Wireless Debugging page.
 *
 * Armed for a short window each time the desktop icon is tapped; outside that
 * window every event is ignored, so the service never acts on its own.
 * Requires a one-time enablement in system accessibility settings.
 */
public class QrAutoClickService extends AccessibilityService {

    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static volatile long armedUntil;

    /** Arm auto-clicking for {@code durationMs} starting now. */
    public static void arm(long durationMs) {
        armedUntil = System.currentTimeMillis() + durationMs;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (System.currentTimeMillis() > armedUntil) return;
        if (event == null || !SETTINGS_PACKAGE.equals(event.getPackageName())) return;
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && event.getEventType() != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && clickQrEntry(root)) armedUntil = 0L;
    }

    /** Breadth-first search for the QR-pairing row; clicks its clickable ancestor. */
    private boolean clickQrEntry(AccessibilityNodeInfo root) {
        Queue<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited++ < 500) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) continue;
            CharSequence text = node.getText();
            CharSequence desc = node.getContentDescription();
            boolean match =
                    (text != null && text.toString().contains("二维码"))
                            || (desc != null && desc.toString().contains("二维码"))
                            || (text != null && text.toString().toUpperCase().contains("QR"));
            if (match && clickOrDelegate(node)) return true;
            for (int i = 0; i < node.getChildCount(); i++) queue.add(node.getChild(i));
        }
        return false;
    }

    private boolean clickOrDelegate(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        int depth = 0;
        while (current != null && depth++ < 5) {
            if (current.isClickable() && current.performAction(
                    AccessibilityNodeInfo.ACTION_CLICK)) return true;
            current = current.getParent();
        }
        return false;
    }

    @Override
    public void onInterrupt() { }
}
