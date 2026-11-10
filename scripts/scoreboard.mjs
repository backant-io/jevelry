#!/usr/bin/env node
// The numbers every change to jevelry is judged on, from one command: `npm run scoreboard`.
// It never starts a model, and it asks one only with --eval: it times what runs without a model, reads
// what the log already holds, looks at a model server that is already running, and names the rest.
//   --eval        ask every jevel's cases of the model that is set up (hosted Jev charges for each ask)
//   --quick       three timing rounds and no install, for the test suite
//   --out <file>  where the result goes; by default scoreboard/<date>-<commit>.json
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jevelryHome, needBytes, readLog, speed, wilson } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const home = jevelryHome(process.env, homedir());
const notMeasured = [];

const git = (...argv) => spawnSync("git", argv, { cwd: root, encoding: "utf8" }).stdout.trim();
const date = new Date().toISOString().slice(0, 10);
const commit = git("rev-parse", "--short", "HEAD");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(root, "scoreboard", `${date}-${commit}.json`);
const refuse = () => {
  process.stderr.write(`scoreboard: ${out} is already there; a result is a dated record and is never written over\n`);
  process.exit(1);
};
if (existsSync(out)) refuse();

const cli = (...argv) => spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...argv], { cwd: root, encoding: "utf8" });
const round = (n) => Math.round(n * 10) / 10;

/** Start-up of the CLI next to bare Node, interleaved so a busy moment on the machine lands on every command alike. */
function startUp() {
  const cases = { bare_node_ms: ["-e", "0"], jevelry_version_ms: [join("dist", "cli.js"), "--version"], jevelry_check_ms: [join("dist", "cli.js"), "check", "log-triage"] };
  const samples = Object.fromEntries(Object.keys(cases).map((name) => [name, []]));
  for (let i = 0; i < (quick ? 3 : 40); i++) {
    for (const [name, argv] of Object.entries(cases)) {
      const started = process.hrtime.bigint();
      const ran = spawnSync(process.execPath, argv, { cwd: root, stdio: "ignore" });
      // A crash is fast: timed as a start, it once read as "jevelry adds 2 ms".
      if (ran.status !== 0) throw new Error(`node ${argv.join(" ")} exited ${ran.status}; run npm ci and npm run build first`);
      samples[name].push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([name, xs]) => {
    const sorted = xs.sort((a, b) => a - b);
    return [name, { min: round(sorted[0]), p25: round(sorted[Math.floor(sorted.length / 4)]), median: round(sorted[Math.floor(sorted.length / 2)]) }];
  }));
}

/** What a person gets from `npm install jevelry`: the tarball installed into an empty folder, counted and timed. */
function install() {
  if (quick) {
    notMeasured.push("install size and time: skipped by --quick");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "jevelry-scoreboard-"));
  try {
    const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr.trim()}`);
    const tarball = join(dir, packed.stdout.trim().split("\n").at(-1));
    writeFileSync(join(dir, "package.json"), "{}\n");
    const started = process.hrtime.bigint();
    const ran = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball], { cwd: dir, encoding: "utf8" });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (ran.status !== 0) throw new Error(`npm install failed: ${ran.stderr.trim()}`);
    const lock = JSON.parse(readFileSync(join(dir, "node_modules", ".package-lock.json"), "utf8"));
    const kilobytes = Number(spawnSync("du", ["-sk", join(dir, "node_modules")], { encoding: "utf8" }).stdout.split("\t")[0]);
    return { packages: Object.keys(lock.packages).length, megabytes: round(kilobytes / 1024), seconds: Math.round(seconds * 100) / 100, tarball_bytes: statSync(tarball).size };
  } catch (error) {
    notMeasured.push(`install size and time: ${error.message}`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The memory of the model server jevelry started, if it is running now, next to what jevelry estimated for it. */
function footprint() {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(join(home, file), "utf8"));
    } catch {
      return null;
    }
  };
  const record = read("server.json");
  const ps = Number.isInteger(record?.pid) ? spawnSync("/bin/ps", ["-ww", "-o", "rss=,command=", "-p", String(record.pid)], { encoding: "utf8" }) : null;
  const line = ps?.status === 0 ? `${ps.stdout.trim()} ` : "";
  if (!record || !line.includes(` --alias ${record.alias} `)) {
    notMeasured.push("memory of the model server: no model server jevelry started is running");
    return null;
  }
  const local = read("config.json")?.local ?? {};
  const fileBytes = statSync(record.path).size;
  // ponytail: the resident size at this moment, not the peak, and on a Mac the GPU's share may not be in it; sample `footprint -p` across an eval once a run shows the gap.
  return {
    model: record.alias,
    rss_bytes: Number.parseInt(line, 10) * 1024,
    file_bytes: fileBytes,
    estimate_bytes: needBytes({ bytes: fileBytes, params: typeof local.params === "number" ? local.params : Infinity, decisionType: typeof local.decisionType === "string" ? local.decisionType : "kev" }),
  };
}

/** Every jevel's cases asked of the model that is set up. Never the default: hosted Jev charges for each ask, and a local model has to load. */
function quality() {
  if (!args.includes("--eval")) {
    notMeasured.push("accuracy on the jevels' cases: pass --eval to ask every case of the model that is set up (hosted Jev charges for each ask)");
    return null;
  }
  const rows = [];
  const seen = new Set();
  for (const line of cli("list").stdout.trim().split("\n")) {
    const [name, dir] = line.split("\t");
    if (!name || !dir || seen.has(name)) continue;
    seen.add(name);
    if (!existsSync(join(dir, name, "cases.json"))) {
      notMeasured.push(`cases of ${name}: it has no cases.json`);
      continue;
    }
    const ran = cli("eval", name, "--json");
    // 8 is an eval that ran and found a wrong answer: a result like any other.
    if (ran.status !== 0 && ran.status !== 8) {
      notMeasured.push(`cases of ${name}: ${ran.stderr.trim().split("\n").at(-1)}`);
      continue;
    }
    const e = JSON.parse(ran.stdout);
    const act = e.questions.reduce((sum, q) => sum + q.act, 0);
    const clear = e.questions.reduce((sum, q) => sum + q.clear, 0);
    rows.push({ jevel: name, model: e.model, cases: e.cases.length, checks: e.checks, right: e.right, interval: wilson(e.right, e.checks), act, clear, wrong_at_act: e.questions.reduce((sum, q) => sum + q.wrong_at_act, 0), p50_ms: e.p50_ms });
  }
  return rows;
}

const start = startUp();
const installed = install();
const judged = quality();
// Read after the eval, so the server it may have started is the one measured.
const memory = footprint();
const rows = speed(await readLog(home, () => {}));
if (!rows.some((row) => row.model.startsWith("local/"))) notMeasured.push("warm local asks: the log holds no timed ask of a local model");
notMeasured.push("cold asks apart from warm ones: the log cannot tell an ask that waited for a model to load from one that did not");

const board = {
  date,
  commit,
  dirty: git("status", "--porcelain") !== "",
  machine: { chip: cpus()[0]?.model ?? "unknown", cpus: cpus().length, ram_gb: Math.round(totalmem() / 2 ** 30), platform: process.platform, node: process.version },
  start,
  install: installed,
  speed: rows,
  footprint: memory,
  quality: judged,
  not_measured: notMeasured,
};
mkdirSync(dirname(out), { recursive: true });
try {
  writeFileSync(out, `${JSON.stringify(board, null, 2)}\n`, { flag: "wx" });
} catch (error) {
  if (error.code === "EEXIST") refuse();
  throw error;
}
process.stdout.write(`${out}\n${notMeasured.map((line) => `not measured: ${line}`).join("\n")}\n`);
