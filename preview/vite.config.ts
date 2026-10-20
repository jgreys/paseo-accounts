import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const here = (path: string) => resolve(__dirname, path);

// Renders the real client components in a browser: react-native → react-native-web, and Paseo's
// plugin SDK → small stand-ins with sample data. Nothing here ships with the plugin.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: here("mocks/plugin-rn.tsx") },
      { find: /^@getpaseo\/plugin\/client\/ui$/, replacement: here("mocks/plugin-ui.tsx") },
      { find: /^@getpaseo\/plugin\/client$/, replacement: here("mocks/plugin-client.tsx") },
      { find: /^@getpaseo\/plugin$/, replacement: here("mocks/plugin-root.ts") },
      { find: /^react$/, replacement: here("node_modules/react") },
      { find: /^react\/(.*)$/, replacement: here("node_modules/react/$1") },
      { find: /^react-dom(.*)$/, replacement: here("node_modules/react-dom$1") },
      { find: /^zod$/, replacement: here("../node_modules/zod") },
    ],
  },
  server: { fs: { allow: [".."] } },
});
