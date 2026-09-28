// 本机（Chromium / WebCodecs）能不能解这几种视频编码。

/** 探测用的最小配置：只关心 `supported`，不需要真喂数据。 */
const PROBE_CONFIGS = {
  h264: { codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 },
  h265: { codec: "hvc1.1.6.L153.90", codedWidth: 1920, codedHeight: 1080 },
  av1: { codec: "av01.0.08M.08", codedWidth: 1920, codedHeight: 1080 },
  vp8: { codec: "vp8", codedWidth: 1920, codedHeight: 1080 },
  vp9: { codec: "vp09.00.10.08", codedWidth: 1920, codedHeight: 1080 },
};

/**
 * 返回 `{ h264, h265, av1 }`；没有 WebCodecs（或整个探测不可信）时返回 **null**，
 * 调用方按「未知」处理 —— 未知不当不支持，否则环境一变化就把用户挡在自动档外面。
 * @returns {Promise<Record<string, boolean> | null>}
 */
export async function probeLocalCodecs() {
  if (typeof VideoDecoder?.isConfigSupported !== "function") return null;
  const out = {};
  await Promise.all(
    Object.entries(PROBE_CONFIGS).map(async ([name, config]) => {
      try {
        out[name] = (await VideoDecoder.isConfigSupported(config)).supported === true;
      } catch {
        out[name] = false;
      }
    }),
  );
  return out;
}
