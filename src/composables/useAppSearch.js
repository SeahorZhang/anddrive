import { computed, ref, watch } from "vue";
import { ensurePinyin, matchesAppQuery, pinyinReady } from "../../shared/appSearch.js";

/**
 * 应用列表的搜索：名字 / 包名 / 拼音首字母。
 *
 * 汉字表（pinyin-pro，280KB）不在首屏加载 —— 第一次敲字才拉，拉回来后靠
 * `pinyinReady()` 这个响应式读数重算一次列表。没加载完之前只是搜不到首字母，
 * 其余照常，所以不必为此加骨架或禁用输入框。
 * @param {() => Array<{label?: string, packageName?: string}>} getApps
 * @param {import('vue').Ref<string>} queryRef
 */
export function useAppSearch(getApps, queryRef) {
  const loaded = ref(pinyinReady());
  watch(queryRef, (value) => {
    if (!value.trim() || loaded.value) return;
    ensurePinyin().then(() => { loaded.value = true; });
  });

  return computed(() => {
    const query = queryRef.value.trim().toLowerCase();
    if (!query) return getApps();
    void loaded.value; // 建立依赖：表加载完成后重算
    return getApps().filter((app) => matchesAppQuery(app, query));
  });
}
