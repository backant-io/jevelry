import { defineConfig } from "tsup";

export default defineConfig({
  // tui is its own chunk, loaded by a dynamic import in the tui command only, so ink and react never slow the other commands.
  entry: { cli: "src/cli.ts", index: "src/index.ts", tui: "src/tui/app.tsx" },
  format: ["esm"],
  target: "node22",
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});
