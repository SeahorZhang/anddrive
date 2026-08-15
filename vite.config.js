import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import RekaResolver from "reka-ui/resolver";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";
import { electronSimple } from "vite-plugin-electron/multi-env";
import { notBundle } from "vite-plugin-electron/plugin";

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  fs.rmSync("dist-electron", { recursive: true, force: true });

  const isServe = command === "serve";
  const isBuild = command === "build";
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG;

  return {
    plugins: [
      vue(),
      vueDevTools(),
      tailwindcss(),
      AutoImport({
        imports: ["vue"],
        dts: true,
      }),
      Components({
        dts: true,
        resolvers: [
          RekaResolver(),
        ],
      }),
      electronSimple({
        main: {
          input: "electron/main.js",
          plugins: [notBundle()],
          options: {
            build: {
              sourcemap,
              minify: isBuild,
            },
          },
        },
        preload: {
          input: "electron/preload.js",
          plugins: [notBundle()],
          options: {
            build: {
              sourcemap: sourcemap ? "inline" : undefined,
              minify: isBuild,
            },
          },
        },
      }),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    clearScreen: false,
  };
});
