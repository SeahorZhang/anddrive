import { fileURLToPath, URL } from 'node:url'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import RekaResolver from 'reka-ui/resolver'

import { defineConfig, perEnvironmentPlugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import { notBundle } from 'vite-plugin-electron/plugin'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const srcDir = path.join(projectRoot, 'src')

function sourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, files)
    else if (/\.(vue|js)$/.test(entry)) files.push(full)
  }
  return files
}

/**
 * 构建时扫描源码里用到的 `lucide:*`，只把这些图标内联进 `virtual:offline-icons`，
 * 新增图标无需手动登记。
 */
function offlineIconsPlugin() {
  const virtualId = 'virtual:offline-icons'
  const resolvedId = `\0${virtualId}`
  return {
    name: 'offline-icons',
    resolveId: (id) => (id === virtualId ? resolvedId : null),
    load(id) {
      if (id !== resolvedId) return
      const collection = JSON.parse(
        readFileSync(
          path.join(projectRoot, 'node_modules/@iconify-json/lucide/icons.json'),
          'utf8',
        ),
      )
      const names = new Set()
      for (const file of sourceFiles(srcDir)) {
        this.addWatchFile(file)
        for (const match of readFileSync(file, 'utf8').matchAll(/lucide:([a-z0-9-]+)/g)) {
          names.add(match[1])
        }
      }
      const icons = {}
      for (const name of names) {
        const icon =
          collection.icons[name] || collection.icons[collection.aliases?.[name]?.parent]
        if (icon) icons[name] = icon
      }
      return [
        `import { setCustomIconLoader } from '@iconify/vue'`,
        `const icons = ${JSON.stringify(icons)}`,
        `setCustomIconLoader((name) => (icons[name] ? { ...icons[name], width: 24, height: 24 } : null), 'lucide')`,
      ].join('\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG

  return {
    plugins: [
      offlineIconsPlugin(),
      tailwindcss(),
      perEnvironmentPlugin('renderer', (environment) =>
        environment.name === 'client'
          ? [
              vue(),
              AutoImport({
                imports: ['vue'],
                dts: true,
              }),
              Components({
                dts: true,
                resolvers: [RekaResolver()],
              }),
            ]
          : [],
      ),
      electronSimple({
        main: {
          input: 'electron/main.js',
          plugins: [notBundle()],
          options: {
            build: {
              sourcemap,
              minify: isBuild,
            },
          },
        },
        preload: {
          input: 'electron/preload.js',
          plugins: [notBundle()],
          options: {
            build: {
              sourcemap: sourcemap ? 'inline' : undefined,
              minify: isBuild,
            },
          },
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    clearScreen: false,
  }
})
