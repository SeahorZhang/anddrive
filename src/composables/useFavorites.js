import { ref, toValue, watch } from "vue";
import { getFavoritesApi, toggleFavoriteApi } from "@/api";
import { notifyError } from "@/composables/useNotifications";

/**
 * 应用收藏（按设备隔离，跨重启保留）。
 *
 * @param {import('vue').MaybeRefOrGetter<string>} source 设备 serial / address
 */
export function useFavorites(source) {
  const favorites = ref(new Set());

  /** @param {string} [address] */
  async function load(address = toValue(source)) {
    const serial = address || "";
    if (!serial) {
      favorites.value = new Set();
      return;
    }
    try {
      const list = await getFavoritesApi(serial);
      // 设备的收藏可能在读取期间被切换或替换，丢弃过期结果
      if (toValue(source) !== serial) return;
      favorites.value = new Set(list || []);
    } catch (error) {
      console.warn("读取收藏失败：", error);
    }
  }

  /** @param {string} packageName */
  function isFavorite(packageName) {
    return favorites.value.has(packageName);
  }

  /** @param {string} packageName */
  async function toggleFavorite(packageName) {
    const serial = toValue(source);
    if (!serial || !packageName) return;

    const next = new Set(favorites.value);
    if (next.has(packageName)) next.delete(packageName);
    else next.add(packageName);
    favorites.value = next;

    try {
      const saved = await toggleFavoriteApi(serial, packageName);
      if (Array.isArray(saved) && toValue(source) === serial) {
        favorites.value = new Set(saved);
      }
    } catch (error) {
      // 回滚乐观更新
      const revert = new Set(favorites.value);
      if (revert.has(packageName)) revert.delete(packageName);
      else revert.add(packageName);
      favorites.value = revert;
      notifyError(error, { title: "更新收藏失败" });
    }
  }

  watch(() => toValue(source), load, { immediate: true });

  return { favorites, isFavorite, toggleFavorite, reload: load };
}
