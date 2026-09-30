import { computed, ref, watch } from 'vue'

/**
 * 明暗主题（模块级单例，设置页与入口共用）。
 *
 * 只写 <html> 上的一个 `dark` 类：index.css 里 `.dark` 覆盖同一组语义色变量，
 * 组件不关心当前主题。存 localStorage——主题是纯渲染层偏好，主进程用不上。
 */

const STORAGE_KEY = 'anddrive:theme'

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // 隐私模式下 localStorage 会抛，落到默认值即可
  }
  // 默认深色：这次改版就是奔着深色去的，浅色靠设置里手动切。
  return 'dark'
}

export const theme = ref(readStored())

export const isDark = computed(() => theme.value === 'dark')

export function setTheme(value) {
  theme.value = value === 'light' ? 'light' : 'dark'
}

watch(
  theme,
  (value) => {
    document.documentElement.classList.toggle('dark', value === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // 存不下就只在本次会话生效，不影响切换本身
    }
  },
  { immediate: true },
)
