import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", detect: "src/detect/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});
