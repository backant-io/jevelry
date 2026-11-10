import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { type Options, defineConfig } from "tsup";

/** The one package left to npm: `ask` tells the SDK's error classes apart with instanceof, so a host's client and jevelry must share one copy. */
const INSTALLED = ["@typesafe-ai/sdk"];
const LEFT_OUT = new RegExp(`^(?!(${INSTALLED.map((name) => name.replace(/[/.-]/g, "\\$&")).join("|")})$)`);

/**
 * ink imports a bridge to React's devtools only when DEV=true, and the bridge brings a websocket library with it:
 * 129 KB that no command of jevelry reaches. The import resolves to an empty module, so DEV=true changes nothing
 * in the build; what is left of it is a chunk of about a hundred bytes.
 */
const noDevtools: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "no-ink-devtools",
  setup(build) {
    build.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => (/[\\/]ink[\\/]/.test(args.importer) ? { path: args.path, namespace: "nothing" } : undefined));
    build.onLoad({ filter: /.*/, namespace: "nothing" }, () => ({ contents: "export {};" }));
  },
};

interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>;
}

/** `node_modules/a/node_modules/@b/c/x.js` is package `node_modules/a/node_modules/@b/c`: the innermost one. */
function packageDir(input: string): string | null {
  const at = input.lastIndexOf("node_modules/");
  if (at === -1) return null;
  const parts = input.slice(at + "node_modules/".length).split("/");
  return input.slice(0, at + "node_modules/".length) + (parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
}

/**
 * Fails the build when a chunk imports a package npm would not install for a person, and writes the
 * licence of every package the build carries next to it: a copy of someone's code travels with their notice.
 */
function checkAndCredit(): void {
  const file = join("dist", "metafile-esm.json");
  const meta = JSON.parse(readFileSync(file, "utf8")) as Metafile;
  rmSync(file);
  const allowed = new Set([...INSTALLED, ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  for (const [output, { imports }] of Object.entries(meta.outputs)) {
    for (const { path, external } of imports) {
      if (external && !allowed.has(path)) throw new Error(`${output} imports ${path}, which npm does not install with jevelry: bundle it or add it to INSTALLED`);
    }
  }
  const dirs = [...new Set(Object.keys(meta.inputs).map(packageDir).filter((dir): dir is string => dir !== null))];
  const notices = dirs
    .map((dir) => {
      const { name, version, license, homepage } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: string; homepage?: string };
      const text = readdirSync(dir).find((entry) => /^licen[sc]e/i.test(entry));
      if (!text && !license) throw new Error(`${name} declares no licence and ships no licence file`);
      // Some packages declare a licence and ship no file for it: what they declare is credited, with where to read it.
      const body = text ? readFileSync(join(dir, text), "utf8").trim() : `The package ships no licence file. It declares ${license}${homepage ? `; see ${homepage}` : ""}.`;
      return { key: `${name}@${version}`, body: `${name}@${version} (${license ?? "see below"})\n\n${body}\n` };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const unique = notices.filter((notice, i) => notices[i - 1]?.key !== notice.key);
  writeFileSync(join("dist", "THIRD-PARTY-LICENSES.txt"), `jevelry's build carries these packages. Each one's licence follows.\n\n${unique.map((notice) => notice.body).join(`\n${"-".repeat(72)}\n\n`)}`);
}

export default defineConfig({
  // tui is its own chunk, loaded by a dynamic import in the tui command only, so ink and react never slow the other commands.
  entry: { cli: "src/cli.ts", index: "src/index.ts", tui: "src/tui/app.tsx" },
  format: ["esm"],
  target: "node22",
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: true,
  // Everything but the SDK is in the build, so an install is jevelry and the SDK, not 43 packages and 27 MB.
  noExternal: [LEFT_OUT],
  external: INSTALLED,
  esbuildPlugins: [noDevtools],
  metafile: true,
  // commander and yaml are CommonJS, and bundled CommonJS reaches Node's own modules through `require`.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __jevelryRequire } from "node:module"; const require = __jevelryRequire(import.meta.url);' },
  async onSuccess() {
    // The declarations are built apart from the code and may still be running; only the code's metafile is read.
    if (existsSync(join("dist", "metafile-esm.json"))) checkAndCredit();
  },
});
