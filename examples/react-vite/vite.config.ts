import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localSink } from "./local-sink.ts";

// CodePress-managed: map Live Dev Server preview URL settings into Vite.
const normalizeBasePath = (value: string | undefined) => {
  if (!value || value === "/") return "/";
  return `/${value.split("/").filter(Boolean).join("/")}/`;
};

const previewHmrProtocol = process.env.CODEPRESS_HMR_PROTOCOL;
const previewHmrClientPort = process.env.CODEPRESS_HMR_CLIENT_PORT;
const previewHmr =
  (previewHmrProtocol === "ws" || previewHmrProtocol === "wss") && previewHmrClientPort
    ? {
        protocol: previewHmrProtocol,
        clientPort: Number(previewHmrClientPort),
      }
    : undefined;

export default defineConfig({
  base: normalizeBasePath(process.env.CODEPRESS_BASE_PATH),
  plugins: [react(), localSink(".interactions")],
  server: {
    port: 5173,
    strictPort: true,
    ...(previewHmr ? { hmr: previewHmr } : {}),
    allowedHosts: true,
    // Files written by the sink are output, not source: don't reload on them.
    watch: { ignored: ["**/.interactions/**"] },
  },
});
