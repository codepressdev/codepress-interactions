import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localSink } from "./local-sink.ts";

export default defineConfig({
  plugins: [react(), localSink(".interactions")],
  server: {
    port: 5173,
    strictPort: true,
    // Files written by the sink are output, not source: don't reload on them.
    watch: { ignored: ["**/.interactions/**"] },
  },
});
