import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
  plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
  // Set by scripts/build-gui.sh from tag detection; defaults to a release
  // build when Vite is run directly.
  define: {
    __PROGRESS_DEV__: JSON.stringify(process.env.PROGRESS_DEV === "1"),
  },
});
