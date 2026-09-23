import { defineConfig } from "tsup";

export default defineConfig({
  // tui is its own chunk, loaded by a dynamic import in the tui command only, so ink and react never slow the other commands.
  entry: ["src/cli.ts", "src/index.ts", "src/tui.tsx"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});
