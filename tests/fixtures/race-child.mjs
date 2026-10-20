#!/usr/bin/env node
// One jevelry process asking for a model, held until an agreed moment so many ask on the same
// millisecond. It runs the built ensureServer, so the race is between real processes and their lock.
import { readdirSync, readFileSync } from "node:fs";

const [home, localJson, startAt] = process.argv.slice(2);
const dist = new URL("../../dist/", import.meta.url);
const chunk = readdirSync(dist).find((f) => f.endsWith(".js") && readFileSync(new URL(f, dist), "utf8").includes("function ensureServer("));
const { ensureServer } = await import(new URL(chunk, dist).href);
const local = JSON.parse(localJson);
while (Date.now() < Number(startAt)) {
  // Spin rather than sleep: a timer would spread the starts over milliseconds.
}
try {
  await ensureServer(home, local, process.env, { timeoutMs: 4000 });
  console.log(JSON.stringify({ ok: local.alias }));
} catch (error) {
  console.log(JSON.stringify({ error: local.alias, message: error.message }));
}
