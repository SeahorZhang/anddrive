package com.anddrive.helper;

import android.content.Context;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Mac ↔ 输入法这条通道：设备上监听一个**抽象** unix socket，桌面端经 adb 的
 * `connect:localabstract:<name>` 连进来 —— 与 scrcpy 自己那条 `localabstract:scrcpy_<scid>`
 * 同一机制，两端都不开 TCP 端口、不需要 `forward`。
 *
 * 线格式：一行一条 JSON（换行分隔），双向。
 * 桌面 → 输入法：`{"op":"hello","token":"…"}`（第一句，必须）、`{"op":"commit","text":"…"}`、
 * `{"op":"ping"}`。
 * 输入法 → 桌面：`{"op":"hello","proto":1,"caps":{…}}`、`{"op":"yield"}`（用户按了胶囊上的 ×）、
 * `{"op":"pong"}`。
 *
 * ⚠️ 抽象 socket 在设备上是**任何 app 都连得上**的（没有文件权限位，Java 侧也拿不到对端 uid），
 * 所以第一句必须对上 token，值取 `Settings.Global`（桌面端开启时写进去的、每次开启换一个）。
 * 对不上直接断开 —— 否则同一台手机上的别的软件就能往用户正聚焦的输入框里注字。
 * 竞品用 binder + session token 解决同一件事，我们这条是它的等价物。
 */
public final class MirrorBridge implements AutoCloseable {

    /** 桌面端 `adb.createSocket("localabstract:" + SOCKET_NAME)` 连的就是它。 */
    public static final String SOCKET_NAME = "anddrive-mac-keyboard";

    /** 握手 token 在 `Settings.Global` 里的那一格（与 `macKeyboard.js` 的 `BRIDGE_TOKEN_SETTING` 一致）。 */
    public static final String TOKEN_SETTING = "anddrive_mac_keyboard_token";

    /** 协议版本；不兼容改动时抬它，桌面端据此决定要不要重连/提示升级。 */
    public static final int PROTOCOL = 1;

    /** 收到指令后的落点。全部在**主线程**回调（`InputConnection` 只能在主线程用）。 */
    public interface Sink {
        /** @return 有没有真的提交进输入框（没有聚焦的编辑器时 false，桌面端要给用户一句话）。 */
        boolean onCommit(String text);

        /**
         * 合成中的文字（Mac 输入法还没选定的那串拼音）→ `setComposingText`，
         * 让它带下划线出现在手机的光标处，观感才和"手机自己在打字"一致（用户 10-11 点的）。
         * @return 同 {@link #onCommit}
         */
        boolean onCompose(String text);
    }

    /**
     * **进程内单例**。输入法服务会被系统反复重建（切走再切回来、配置变化），每建一个就各起一条
     * 监听线程的话：先起来那个占着抽象 socket 并持有连接，后起来的那个 `bind` 失败、`out` 永远是 null
     * —— 10-11 的 × 丢了就是这个（ping/pong 在旧实例上跑得好好的，`notifyYield` 读的是新实例）。
     */
    private static MirrorBridge instance;

    /** 取（并首次创建）这个进程唯一的那条桥。Context 只取 application context，不持有服务实例。 */
    public static synchronized MirrorBridge get(Context context) {
        if (instance == null) {
            instance = new MirrorBridge(context.getApplicationContext());
        }
        return instance;
    }

    private final Context context;
    /** 当前那个服务实例（可空：服务被销毁、桥还活着等下一次连接的这段时间里就是空）。 */
    private volatile Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** 打日志用：一眼能看出是不是又冒出第二个实例。 */
    private final String id = Integer.toHexString(System.identityHashCode(this));

    private Thread thread;
    private volatile LocalServerSocket server;
    private volatile OutputStream out;

    private MirrorBridge(Context context) {
        this.context = context;
    }

    /** 服务实例换了就把落点重挂到它身上（桥与连接都不动，用户不用重连一次）。 */
    public void setSink(Sink sink) {
        this.sink = sink;
    }

    /** 只在自己还是当前落点时清（避免旧服务实例的 onDestroy 把新实例挂上去的落点抹掉）。 */
    public void clearSink(Sink sink) {
        if (this.sink == sink) {
            this.sink = null;
        }
    }

    /** 起监听。已经在跑就是空操作（输入法进程可能反复 onCreate/onDestroy）。 */
    public synchronized void start() {
        if (thread != null) {
            return;
        }
        thread = new Thread(this::loop, "anddrive-ime-bridge");
        thread.setDaemon(true);
        thread.start();
    }

    private void loop() {
        try {
            server = new LocalServerSocket(SOCKET_NAME);
            while (!Thread.currentThread().isInterrupted()) {
                serve(server.accept());
            }
        } catch (Exception e) {
            Log.w("AndDriveBridge", id + " listen 结束: " + e);
            // 名字被占（同一设备开了第二个输入法进程）或已 close：桥断了而已，
            // 桌面端会重连，输入法活着就还能接上。这里不抛，抛了会把输入法进程带崩。
        } finally {
            closeQuietly();
        }
    }

    /** 一次连接：验 token → 报 hello → 读指令，直到对端断开。 */
    private void serve(LocalSocket socket) {
        try (LocalSocket s = socket;
             BufferedReader in = new BufferedReader(
                     new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
             OutputStream o = s.getOutputStream()) {
            String line = in.readLine();
            if (!authorized(line)) {
                Log.i("AndDriveBridge", id + " client REJECTED (token 不对)");
                return;
            }
            Log.i("AndDriveBridge", id + " client authorized");
            out = o;
            send(o, hello());
            while ((line = in.readLine()) != null) {
                handle(line, o);
            }
        } catch (Exception e) {
            Log.i("AndDriveBridge", id + " serve 异常退出: " + e);
        } finally {
            Log.i("AndDriveBridge", id + " serve 结束（out 置空）");
            out = null;
        }
    }

    private boolean authorized(String line) {
        JSONObject msg = parse(line);
        if (msg == null || !"hello".equals(msg.optString("op"))) {
            return false;
        }
        String expected = currentToken();
        // 读不到或设备回字面量 "null"（桌面端关掉时清的就是这个）= 现在没人配对，谁都不认。
        return expected != null && expected.equals(msg.optString("token"));
    }

    private String currentToken() {
        try {
            String value = Settings.Global.getString(context.getContentResolver(), TOKEN_SETTING);
            return value == null || value.isEmpty() || "null".equals(value) ? null : value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void handle(String line, OutputStream o) {
        JSONObject msg = parse(line);
        if (msg == null) {
            return;
        }
        switch (msg.optString("op")) {
            case "compose": {
                // 合成态是高频的（每敲一个字母一条），所以不回 ack：丢了下一条就来。
                String marked = msg.optString("text");
                main.post(() -> {
                    Sink target = sink;
                    if (target != null) {
                        target.onCompose(marked);
                    }
                });
                break;
            }
            case "commit":
                String text = msg.optString("text");
                if (!text.isEmpty()) {
                    main.post(() -> {
                        Sink target = sink;
                        boolean delivered = target != null && target.onCommit(text);
                        // 回执：静默丢掉是这一类问题里最难查的（10-11 就是"字没进去但没人说"）。
                        send(o, delivered ? "{\"op\":\"ack\"}" : "{\"op\":\"nack\",\"reason\":\"no-editor\"}");
                    });
                }
                break;
            case "ping":
                send(o, "{\"op\":\"pong\"}");
                break;
            default:
                break;
        }
    }

    private static JSONObject hello() {
        try {
            return new JSONObject()
                    .put("op", "hello")
                    .put("proto", PROTOCOL)
                    .put("caps", new JSONObject()
                            .put("text", true)
                            .put("clipboard", false)
                            .put("switching", true));
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 用户在手机上按了胶囊上的 ×：告诉桌面端"这一会儿把键盘还给我"。 */
    public void notifyYield() {
        OutputStream stream = out;
        Log.i("AndDriveBridge", id + " notifyYield, connected=" + (stream != null));
        if (stream != null) {
            send(stream, "{\"op\":\"yield\"}");
        }
    }

    /**
     * 手机光标的**屏幕矩形**（来自 `CursorAnchorInfo` 的插入点，见 {@code MirrorInputMethodService}）。
     * 桌面端拿它把输入法候选窗锚到真实光标上 —— 这是它唯一拿得到光标像素位置的地方。
     *
     * @param valid false = 现在没有光标（编辑器不支持这条、或输入框没了）；桌面端据此退回自己攒的锚点。
     * @param x     光标竖线的左边（屏幕 px）
     * @param top   光标竖线的上边
     * @param bottom 光标竖线的下边
     */
    public void notifyCaret(boolean valid, float x, float top, float bottom) {
        OutputStream stream = out;
        if (stream == null) {
            return;
        }
        try {
            JSONObject msg = new JSONObject().put("op", "caret").put("valid", valid);
            if (valid) {
                msg.put("x", (double) x).put("top", (double) top).put("bottom", (double) bottom);
            }
            send(stream, msg);
        } catch (Exception ignored) {
            // 与 ping/pong 同一档：报不上就算了，光标锚点丢了只是观感退化，不该影响打字。
        }
    }

    /** 现在有没有连着的桌面端（胶囊要不要显形用它判断）。 */
    public boolean isConnected() {
        return out != null;
    }

    private static JSONObject parse(String line) {
        try {
            return new JSONObject(line);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void send(OutputStream o, JSONObject msg) {
        if (msg != null) {
            send(o, msg.toString());
        }
    }

    private static void send(OutputStream o, String json) {
        try {
            o.write(json.getBytes(StandardCharsets.UTF_8));
            o.write('\n');
            o.flush();
        } catch (Exception ignored) {
            // 写失败 = 对端走了，读循环随即会结束并回到 accept。
        }
    }

    @Override
    public void close() {
        Thread worker = thread;
        thread = null;
        if (worker != null) {
            worker.interrupt();
        }
        closeQuietly();
    }

    private void closeQuietly() {
        out = null;
        LocalServerSocket socket = server;
        server = null;
        try {
            if (socket != null) {
                socket.close();
            }
        } catch (Exception ignored) {
        }
    }
}
