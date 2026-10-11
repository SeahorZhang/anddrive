package com.anddrive.helper;

import android.graphics.Matrix;
import android.inputmethodservice.InputMethodService;
import android.view.LayoutInflater;
import android.view.View;
import android.view.inputmethod.CursorAnchorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.ImageView;
import android.view.inputmethod.EditorInfo;

/**
 * Mac 键盘落在设备这一侧的端点：不提供任何按键布局，文本由桌面端经桥（{@link MirrorBridge}）
 * 送进来后走 {@code InputConnection} 提交，所以画面里只看得见右下角那颗状态胶囊。
 *
 * 为什么必须是输入法：上游 scrcpy 的 {@code injectText} 送不了非 ASCII（真机实测中文整段被吞），
 * {@code adb shell input text} 在 MIUI 14 上直接抛 NPE；而输入法是系统里唯一**不需要前台焦点**
 * 就能把文本直接提交进聚焦编辑框的角色。
 */
public final class MirrorInputMethodService extends InputMethodService {

    private MirrorBridge bridge;
    /** 挂在桥上的落点。必须是同一个对象引用，`onDestroy` 才清得掉自己那一份（见 `clearSink`）。 */
    private final MirrorBridge.Sink sink = new MirrorBridge.Sink() {
        @Override
        public boolean onCommit(String text) {
            return commit(text);
        }

        @Override
        public boolean onCompose(String text) {
            return compose(text);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        // 桥是进程内单例：服务被系统重建时不重新绑 socket，只把落点换到当前这个实例上。
        bridge = MirrorBridge.get(this);
        bridge.setSink(sink);
        bridge.start();
    }

    @Override
    public View onCreateInputView() {
        View view = LayoutInflater.from(this).inflate(R.layout.mirror_ime_capsule, null);
        ImageView close = view.findViewById(R.id.mirror_ime_close);
        // × = 设备侧临时让出：先告诉桌面端（它此后不再抢、也不再送字），再把自己的视图收起来。
        // 它不是持久开关 —— 那一份意图在桌面端，所以这里不写任何存盘。
        close.setOnClickListener(v -> {
            if (bridge != null) {
                bridge.notifyYield();
            }
            requestHideSelf(0);
        });
        return view;
    }

    /**
     * 合成中的拼音：用 `setComposingText` 画在手机光标处（带下划线），下一次 commit 会把它替换掉。
     * 空串 = 结束合成（桥断了/用户撤掉候选时别把半截拼音留在人家输入框里）。
     */
    private boolean compose(String text) {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            return false;
        }
        return text.isEmpty() ? connection.finishComposingText() : connection.setComposingText(text, 1);
    }

    /**
     * 桌面端送进来的一段文本，整串提交给当前聚焦的输入框（中文在这条路上不丢字）。
     * @return 有没有落进去 —— 手机上没有聚焦的输入框时返回 false，桌面端要给用户一句话。
     */
    private boolean commit(String text) {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            return false;
        }
        return connection.commitText(text, 1);
    }

    /** 胶囊要贴在画面上，不能把前台 app 挤进全屏输入模式。 */
    @Override
    public boolean onEvaluateFullscreenMode() {
        return false;
    }

    /**
     * 让编辑器开始推 {@code CursorAnchorInfo} —— 手机光标的**屏幕矩形**唯一的数据来源。
     *
     * ⚠️ **不主动要就永远收不到**。我们 2026-10-11 第一轮把 `dumpsys input_method` 里
     * `mCursorRect` 恒为 `0,0-0,0` 误读成"Android 拿不到光标的像素位置"，于是绕道去"按送出去的
     * 文本估推进宽度"。第二轮拆竞品才看清：它的设备端 dex 里同样有 `requestCursorUpdates` 与
     * `getInsertionMarkerHorizontal/Top/Bottom` —— 它不是不下发，是**要输入法先要**。
     *
     * 编辑器不支持时返回 false / 抛异常，都当"没有这条路"：桌面端会退回自己攒的锚点。
     */
    private void requestCaretUpdates() {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            return;
        }
        try {
            connection.requestCursorUpdates(InputConnection.CURSOR_UPDATE_MONITOR);
        } catch (Throwable ignored) {
            // 见上：拿不到就算了，不影响打字。
        }
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        requestCaretUpdates();
    }

    @Override
    public void onStartInputView(EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        requestCaretUpdates();
    }

    /**
     * 手机光标的矩形 → 桌面端。**不改任何输入行为**，只是上报。
     *
     * ⚠️ `getInsertionMarker*` 报的是**编辑器本地坐标**，不是屏幕坐标 —— 官方类摘要那句
     * "in the screen coordinates" 说的是**过 `getMatrix()` 之后**的结果，具有误导性。正确读法：
     * 先把 (x, top) 与 (x, bottom) 两个点过 `getMatrix().mapPoints()`，才得到屏幕坐标。
     * 2026-10-11 实测就是漏了这一步，才把 MIUI 上的局部坐标误当成"平台不给屏幕坐标"。
     */
    @Override
    public void onUpdateCursorAnchorInfo(CursorAnchorInfo info) {
        if (bridge == null || info == null) {
            return;
        }
        float x = info.getInsertionMarkerHorizontal();
        float top = info.getInsertionMarkerTop();
        float bottom = info.getInsertionMarkerBottom();
        if (Float.isNaN(x) || Float.isNaN(top) || Float.isNaN(bottom)) {
            return;
        }
        // 本地 → 屏幕：同一 x 取上下两点，变换后分别得到屏幕上的上/下沿。
        float[] points = new float[] { x, top, x, bottom };
        Matrix matrix = info.getMatrix();
        if (matrix != null) {
            matrix.mapPoints(points);
        }
        bridge.notifyCaret(true, points[0], points[1], points[3]);
    }

    /** 输入框没了 = 没有光标可锚，告诉桌面端退回它自己攒的那个。 */
    @Override
    public void onFinishInput() {
        if (bridge != null) {
            bridge.notifyCaret(false, 0f, 0f, 0f);
        }
        super.onFinishInput();
    }

    /** 显形判据：有编辑框就画。桥的状态（连没连上）不改变这一条 —— 没连上时这颗胶囊本身就是提示。 */
    @Override
    public boolean onEvaluateInputViewShown() {
        return true;
    }

    @Override
    public void onDestroy() {
        // 只摘自己的落点，**不关桥**：关了就把 Mac 那边正在用的连接一起掐了，
        // 而服务随时会被系统重建回来（重建后 `setSink` 又挂上，桥不用重连）。
        if (bridge != null) {
            bridge.clearSink(sink);
        }
        super.onDestroy();
    }
}
