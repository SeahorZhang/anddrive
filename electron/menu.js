import { BrowserWindow, Menu, app } from "electron";
import { isMirrorWindow } from "./mirror/session.js";

// ---------------------------------------------------------------------------
// 应用菜单（macOS）
//
// 装这个菜单只为了一件事：**焦点在镜像窗口时 ⌘Q 只关这个镜像窗口**，不要把
// 整个程序带走。之前没设菜单，用的是 Electron 默认菜单，Quit 就是 app.quit()，
// 用户按 ⌘Q 想关投屏窗口结果连主界面一起退掉（2026-09-21 反馈）。
// 想真的退出：菜单里另留了「退出 AndDrive（全部窗口）」= ⌥⌘Q。
// ---------------------------------------------------------------------------

export function installAppMenu() {
  if (process.platform !== "darwin") {
    // 其他平台保持默认菜单，本次问题只出现在 macOS 的 ⌘Q 语义上。
    return;
  }
  // dev 下 app.name 是包名 slug（anddrive_next），菜单里显示它太丑；打包后的
  // productName（AndDrive / AndDrive Beta）才拿来做标题。
  const raw = app.name || "";
  const appName = raw && !/[_-]/.test(raw) ? raw : "AndDrive";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          {
            label: `退出 ${appName}`,
            accelerator: "Cmd+Q",
            click: (_item, focusedWindow) => {
              if (focusedWindow && isMirrorWindow(focusedWindow)) {
                focusedWindow.close();
                return;
              }
              app.quit();
            },
          },
          {
            label: `退出 ${appName}（全部窗口）`,
            accelerator: "Alt+Cmd+Q",
            click: () => app.quit(),
          },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
