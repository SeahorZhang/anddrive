// ---------------------------------------------------------------------------
// 设备级音频会话的「宿主选举」（用户 2026-10-14 第三条报障的修法）
//
// 背景：Android 上音频是**设备级**的 —— 只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`。
// 同一台设备上两条采集同时跑，拿到的是**同一份混音**（两个窗口各播一遍 = 声音重叠）；
// 而释放任意一条会让 AudioPolicy 把那条输出整条拆掉、应用输出回到 `SPEAKER`，
// 剩下那条采集从此静音（声音「回到了手机」）。机制与读数见
// `electron/mirror/options.js` 的 `buildMirrorOptions` 与 `docs/NATIVE_MIRROR.md`。
//
// ⇒ 同一台设备同时只允许**一条**采集，且它的生命周期不能挂在某一条镜像窗口上。
// 这里只做一件事：从该设备**当前还活着的**镜像窗口里挑出承载者 —— 最早打开的那个。
// ---------------------------------------------------------------------------

/**
 * 从同一台设备的镜像窗口里挑出承载那条音频会话的窗口（**最早打开的**，`startedAt` 最小；
 * 同刻用 `id` 兜底，保证同一份输入永远给出同一个答案）。
 *
 * 为什么固定「最早那个」而不是「最近关掉谁就换谁」：判据必须**只依赖当前活着的窗口集合**
 * —— 否则每次窗口开关都要在主进程与渲染层各记一份「谁是宿主」，两边漂了就会出现两条采集
 * 同时跑（声音重叠）或者一条都不跑（彻底没声音）。这样两边都只算一次、算的是同一件事。
 *
 * ⚠️ 调用方负责**先按设备与「设置页开着声音输出」过滤**：关掉那一项时这台设备一个候选都不该有。
 * @param {Array<{ id: string, startedAt: number } | null | undefined>} candidates
 * @returns {string | null} 承载者的会话 id；没有候选（= 这台设备没窗口了，该收摊）时为 null
 */
export function pickAudioHost(candidates) {
  let best = null;
  for (const item of candidates ?? []) {
    if (!item || typeof item.id !== "string") continue;
    const startedAt = Number(item.startedAt) || 0;
    if (best === null) {
      best = { id: item.id, startedAt };
      continue;
    }
    if (startedAt < best.startedAt) best = { id: item.id, startedAt };
    else if (startedAt === best.startedAt && item.id < best.id) best = { id: item.id, startedAt };
  }
  return best?.id ?? null;
}
