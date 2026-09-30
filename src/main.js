import { createApp } from "vue";
// 先于 App 求值：挂载前就把 <html> 上的 dark 类摆好，免得开窗闪一下浅色。
import "./composables/useTheme";
import App from "./App.vue";
import "./styles/index.css";
import "vue-sonner/style.css";
import "virtual:offline-icons";

createApp(App).mount("#app");
