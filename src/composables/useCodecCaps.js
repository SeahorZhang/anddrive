import { onMounted, ref, watch } from "vue";
import { getVideoCodecsApi } from "@/api";
import { probeLocalCodecs } from "@/utils/codecCaps";

/** 本机探测进程内只做一次（WebCodecs 能力不会中途变化）。 */
let localCaps = null;

/** 本机 WebCodecs 能解哪些编码。`null` = 还没回来或探不出（调用方按未知处理）。 */
export function useLocalCodecs() {
  const caps = ref(null);
  localCaps ??= probeLocalCodecs();
  onMounted(async () => {
    caps.value = await localCaps;
  });
  return caps;
}

/**
 * 目标设备的编码器清单（`{usable, mimes}`）。
 * @param {() => string} serialGetter 传函数而不是值：对话框里的序列号会变，查回来时要对一下还是不是同一台。
 */
export function useDeviceCodecs(serialGetter) {
  const caps = ref(null);
  watch(
    serialGetter,
    async (serial) => {
      caps.value = null;
      if (!serial) return;
      const next = await getVideoCodecsApi(serial).catch(() => null);
      if (serialGetter() === serial) caps.value = next;
    },
    { immediate: true },
  );
  return caps;
}
