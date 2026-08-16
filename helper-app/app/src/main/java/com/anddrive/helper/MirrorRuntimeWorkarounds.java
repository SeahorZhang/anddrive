package com.anddrive.helper;

import android.content.Context;
import android.os.Looper;

import java.lang.reflect.Method;

/**
 * 通过反射获取系统 Context
 * 参考 app_process 方案
 */
public class MirrorRuntimeWorkarounds {

    private static Context systemContext;

    /**
     * 获取系统级 Context
     */
    public static synchronized Context systemContext() {
        if (systemContext != null) {
            return systemContext;
        }

        try {
            // 准备 Looper
            if (Looper.myLooper() == null) {
                Looper.prepareMainLooper();
            }

            // 使用 systemMain() 方法初始化 ActivityThread
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Method systemMain = atClass.getDeclaredMethod("systemMain");
            systemMain.setAccessible(true);
            Object at = systemMain.invoke(null);

            // 获取系统 Context
            Method getSystemContext = atClass.getMethod("getSystemContext");
            systemContext = (Context) getSystemContext.invoke(at);

            return systemContext;
        } catch (Exception e) {
            System.err.println("[MirrorRuntime] systemMain failed: " + e);
            e.printStackTrace();

            // 备用方案：尝试 currentActivityThread
            try {
                Class<?> atClass = Class.forName("android.app.ActivityThread");
                Method current = atClass.getMethod("currentActivityThread");
                Object at = current.invoke(null);
                if (at != null) {
                    Method getCtx = atClass.getMethod("getSystemContext");
                    systemContext = (Context) getCtx.invoke(at);
                    return systemContext;
                }
            } catch (Exception e2) {
                System.err.println("[MirrorRuntime] Alternative failed: " + e2);
            }

            return null;
        }
    }
}
