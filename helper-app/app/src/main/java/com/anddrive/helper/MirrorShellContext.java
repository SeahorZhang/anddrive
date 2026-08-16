package com.anddrive.helper;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.PackageManager;

/**
 * 伪装成 Shell (UID 2000) 的 Context
 * 参考 AndroMeld 方案
 */
public class MirrorShellContext extends ContextWrapper {

    private static final String SHELL_PACKAGE = "com.android.shell";

    private final String overriddenPackageName;

    public MirrorShellContext(Context base, String packageName) {
        super(base);
        this.overriddenPackageName = packageName;
    }

    /**
     * 创建 Shell 身份的 Context
     */
    public static MirrorShellContext create(Context systemContext) {
        try {
            System.out.println("[MirrorShellContext] Creating shell context...");
            Context shellContext = systemContext.createPackageContext(
                SHELL_PACKAGE,
                Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY
            );
            System.out.println("[MirrorShellContext] Shell context created successfully");
            return new MirrorShellContext(shellContext, SHELL_PACKAGE);
        } catch (PackageManager.NameNotFoundException e) {
            System.err.println("[MirrorShellContext] Error: " + e.getMessage());
            e.printStackTrace();
            return null;
        }
    }

    @Override
    public String getPackageName() {
        return overriddenPackageName;
    }

    @Override
    public String getOpPackageName() {
        return overriddenPackageName;
    }
}
