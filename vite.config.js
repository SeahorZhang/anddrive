import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import RekaResolver from "reka-ui/resolver";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig({
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

        // RekaResolver({
        //   prefix: '' // use the prefix option to add Prefix to the imported components
        // })
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
