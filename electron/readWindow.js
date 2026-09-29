// 顺序读窗口的存放规则（从 devfs 拆出来单测：这里的比较条件错过一项，
// 播放式读就会从 5 MB/s 掉到 0.3 MB/s，而且只在"读超过一窗之后"才显现）。

/** 小窗下限：访达缩略图只要文件头 150–230 KB，256 KB 够盖住一次解码。 */
export const SMALL_WINDOW_BYTES = 256 * 1024;
/** 顺序读的下限：播放器每 64 KB 来回一次太贵，2 MB 是实测划算的那一档。 */
export const SEQUENTIAL_WINDOW_BYTES = 2 * 1024 * 1024;

/**
 * 一次未命中该从设备**同步**取多少。
 *
 * 这条规则是为图片夹写的：以前不管请求多小都按 2 MB 起取，实测开一个 24 张 12 MB 照片的
 * 文件夹，访达只要 3 MB 缩略图数据，我们却拉了 48 MB（墙钟 3.3s → 0.6s 的差距就在这）。
 * 但顺序续读（播放、拷贝）不能跟着缩小 —— 它每 64 KB 回一次源的代价比多取高得多，
 * 实测同一串 40×64 KB：小窗档 800ms，2 MB 档 350ms。
 * 补到 8 MB 大窗是 `prefetchWindow` 在背后做的事，不占用户正在等的这一块。
 *
 * @param {{ length: number, sequential: boolean, maxBytes: number,
 *           smallFloor?: number, sequentialFloor?: number }} request
 */
export function planWindowFetch({
  length,
  sequential,
  maxBytes,
  smallFloor = SMALL_WINDOW_BYTES,
  sequentialFloor = SEQUENTIAL_WINDOW_BYTES,
}) {
  const floor = sequential ? sequentialFloor : smallFloor;
  const wanted = Number.isFinite(length) && length > 0 ? length : floor;
  return Math.min(maxBytes, Math.max(floor, wanted));
}

/**
 * @param {{ budgetBytes: number }} limits 所有窗口加起来的内存上限
 */
export function createReadWindowCache({ budgetBytes }) {
  /** key → { start, data }；Map 的插入顺序当 LRU 用。 */
  const windows = new Map();
  let heldBytes = 0;

  function drop(key) {
    const win = windows.get(key);
    if (!win) return;
    windows.delete(key);
    heldBytes -= win.data.length;
  }

  /**
   * 存一整窗。
   *
   * `prev.start === start` 这个条件不能省：它挡的是"同一窗口的更大版本被更小切片盖掉"
   * （物化分块时会遇到）。写成只比长度，换偏移量的新窗就会被旧窗挡下 —— 于是越过第一窗
   * 之后每个请求都重取一整块又被丢弃，实测 80×64KB 的播放式读从 1.0s 变成 14.5s。
   */
  function store(key, start, data) {
    const prev = windows.get(key);
    if (prev && prev.start === start && prev.data.length >= data.length) return;
    if (prev) heldBytes -= prev.data.length;
    windows.set(key, { start, data });
    heldBytes += data.length;
    while (heldBytes > budgetBytes && windows.size > 1) {
      const [oldest] = windows.keys();
      if (oldest === key) break;
      drop(oldest);
    }
  }

  /** 命中就把该窗挪到 LRU 末尾，正在看的文件不会被别的挤掉。 */
  function hit(key, start, length) {
    const win = windows.get(key);
    if (!win) return null;
    const offset = start - win.start;
    if (offset < 0 || offset + length > win.data.length) return null;
    windows.delete(key);
    windows.set(key, win);
    return win.data.subarray(offset, offset + length);
  }

  /** 这个键当前窗口的尾部偏移；没有窗口就 null（用来判断新请求是不是"接着读"）。 */
  function end(key) {
    const win = windows.get(key);
    return win ? win.start + win.data.length : null;
  }

  return {
    store,
    hit,
    drop,
    end,
    clear: () => {
      windows.clear();
      heldBytes = 0;
    },
    get heldBytes() {
      return heldBytes;
    },
    get size() {
      return windows.size;
    },
  };
}
