// Mac 输入法 → 手机输入框这一段（G1 Slice 4）。
//
// 形状：页面上挂一个 0 尺寸的隐藏字段专门收 Mac 输入法的候选，这里把它的 DOM 事件翻成
// 「一段要送出去的文本」。为什么只在**提交**那一刻送：手机侧的 `InputConnection` 没有
// marked text（未定候选词）这个概念，把拼音字母半截送进去就留在输入框里了 —— 竞品也是
// 在它自己的 `insertText:` 回调里才发（`setMarkedText` 那段留在 Mac 本地）。
//
// ⚠️ `compositionend` 与 `input` 的先后是 Chromium 定的：合成结束时 `input` 先、
// `compositionend` 后。所以合成期间 `input` 一律忽略，只在 `compositionend` 发一次；
// 不打字（没在合成）时才用 `input` 的 `data`（插入的那几个字符）。

/**
 * @param {{
 *   commit: (text: string) => boolean,   // 走桥送输入法；true = 真的送出去了
 *   fallback: (text: string) => void,    // 桥没连上时的退路（`injectText`，只保 ASCII）
 *   compose?: (text: string) => void,    // 合成中的拼音 → 手机光标处（`setComposingText`）
 * }} deps
 */
export function createMacTextSink({ commit, fallback, compose = () => {} }) {
  let composing = false;

  function emit(text) {
    if (!text) return;
    if (!commit(text)) fallback(text);
  }

  return {
    get composing() {
      return composing;
    },
    onCompositionStart() {
      composing = true;
    },
    /**
     * 合成中的拼音：整串（`event.data` 就是当前合成文本）同步到手机光标处。
     * 观感对齐竞品 —— 用户 10-11：「它会将输入法文字显示在光标后」。
     * 候选列表本身仍只在 Mac 上（macOS 不把第三方输入法的候选词表暴露给应用，读不到）。
     */
    onCompositionUpdate(event) {
      compose(String(event?.data ?? ""));
    },
    onCompositionEnd(event) {
      composing = false;
      // 合成结束 = **没有合成串了**，显式通知一次空串（协议里空串就是这个意思：设备侧
      // `finishComposingText()` 靠它）。⚠️ 不能指望下面那句 `emit` —— 它对**空串会提前
      // return**（Esc 取消合成、或输入法把合成收成空串），没人通知的话"正在输入"的显示
      // （Mac 上的拼音胶囊）会一直挂着。
      compose("");
      emit(event?.data ?? "");
    },
    /**
     * 没在合成时的插入（打一个 `a`、粘贴一段文本都走这里）。
     * 删除类的 `input` 其 `data` 是 null —— 退格由按键那条路走（`kind:'key'`），这里不翻译。
     */
    onInput(event) {
      if (composing) return;
      emit(event?.data ?? "");
    },
  };
}
