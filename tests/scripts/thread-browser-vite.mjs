import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  root,
  envDir: fileURLToPath(new URL("../../scripts/no-env", import.meta.url)),
  plugins: [tailwindcss(), react({ compiler: true })],
  resolve: { alias: { "@": root } },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.THREAD_TEST_PORT ?? 4187),
    strictPort: true,
  },
});
