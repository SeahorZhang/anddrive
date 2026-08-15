import { setCustomIconLoader } from '@iconify/vue'

// 懒加载：只有使用到的图标才会被加载
setCustomIconLoader(async (name) => {
  const module = await import('@iconify-json/lucide/icons.json')
  const data = module.default
  const icon = data.icons[name]
  if (!icon) return null

  // 返回完整图标数据，包含元数据
  return {
    ...icon,
    width: data.width || 24,
    height: data.height || 24,
  }
}, 'lucide')
