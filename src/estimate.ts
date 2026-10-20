import { spawnSync } from "node:child_process";
import { cpus, release, totalmem } from "node:os";

/** What a model runs on: the chip and memory that decide whether it fits and how fast it answers. */
export interface Machine {
  os: NodeJS.Platform;
  chip: string;
  cpus: number;
  ramBytes: number;
  /** From `os.release()` on darwin, else null. */
  darwinMajor: number | null;
  /** NVIDIA only, from nvidia-smi on linux and win32. */
  gpu: { name: string; vramBytes: number } | null;
}

/**
 * `JEVELRY_MACHINE` (JSON of a Machine) replaces detection entirely, so a test, or a person who wants
 * the picker for another machine, never depends on this one. On macOS nothing is spawned: the chip
 * name and the memory are all the estimates need, and probing the GPU there is what crashed one.
 */
export function detectMachine(env: NodeJS.ProcessEnv = process.env): Machine {
  const given = env.JEVELRY_MACHINE;
  if (given !== undefined && given.trim() !== "") {
    try {
      return JSON.parse(given) as Machine;
    } catch (error) {
      throw new Error(`JEVELRY_MACHINE is not JSON of a machine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const cores = cpus();
  const darwin = process.platform === "darwin";
  return {
    os: process.platform,
    chip: cores[0]?.model ?? "unknown",
    cpus: cores.length,
    // A container's memory limit is the machine a model has; constrainedMemory() is 0 where there is none.
    ramBytes: Math.min(totalmem(), process.constrainedMemory() || Infinity),
    darwinMajor: darwin ? Number(release().split(".")[0]) : null,
    gpu: darwin ? null : nvidiaGpu(),
  };
}

/** This machine whatever `JEVELRY_MACHINE` says: browsing another machine's picks must never load a model this one cannot hold. */
export function realMachine(): Machine {
  return detectMachine({});
}

function nvidiaGpu(): Machine["gpu"] {
  const found = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000 });
  if (found.status !== 0) return null;
  const line = (found.stdout ?? "").split("\n")[0] ?? "";
  // The name may hold a comma, the memory never does: split at the last one.
  const at = line.lastIndexOf(",");
  const mib = Number(line.slice(at + 1).trim());
  const name = line.slice(0, at).trim();
  return at > 0 && name !== "" && Number.isFinite(mib) && mib > 0 ? { name, vramBytes: mib * 2 ** 20 } : null;
}

// Published llama.cpp prompt-processing tokens/s, Llama-2-7B pp512: discussions #4167 (Apple, Metal) and #15013 (CUDA).
// Each Apple name maps to its lowest-core GPU variant unless the CPU count identifies the higher bin.
export const CHIPS: Array<{ match: string; kind: "apple" | "nvidia" | "cpu"; q4: number; q8: number; variants?: Array<{ cpus: number; q4: number; q8: number }> }> = [
  { match: "Apple M1 Ultra", kind: "apple", q4: 772.2, q8: 783.5 },
  { match: "Apple M1 Max", kind: "apple", q4: 400.3, q8: 405.9 },
  { match: "Apple M1 Pro", kind: "apple", q4: 232.6, q8: 235.2 },
  { match: "Apple M1", kind: "apple", q4: 107.8, q8: 108.2 },
  { match: "Apple M2 Ultra", kind: "apple", q4: 1013.8, q8: 1003.2 },
  { match: "Apple M2 Max", kind: "apple", q4: 537.6, q8: 540.1 },
  { match: "Apple M2 Pro", kind: "apple", q4: 294.2, q8: 288.5, variants: [{ cpus: 12, q4: 341.2, q8: 344.5 }] },
  { match: "Apple M2", kind: "apple", q4: 145.9, q8: 147.3 },
  { match: "Apple M3 Ultra", kind: "apple", q4: 1073.1, q8: 1085.8, variants: [{ cpus: 32, q4: 1471.2, q8: 1487.5 }] },
  { match: "Apple M3 Max", kind: "apple", q4: 567.6, q8: 566.4, variants: [{ cpus: 16, q4: 759.7, q8: 757.6 }] },
  { match: "Apple M3 Pro", kind: "apple", q4: 269.5, q8: 272.1, variants: [{ cpus: 12, q4: 341.7, q8: 344.7 }] },
  { match: "Apple M3", kind: "apple", q4: 149.4, q8: 150.0 },
  { match: "Apple M4 Max", kind: "apple", q4: 713.9, q8: 718.6, variants: [{ cpus: 16, q4: 885.7, q8: 891.9 }] },
  { match: "Apple M4 Pro", kind: "apple", q4: 364.1, q8: 367.1, variants: [{ cpus: 14, q4: 439.8, q8: 449.6 }] },
  { match: "Apple M4", kind: "apple", q4: 177.0, q8: 178.9 },
  { match: "Apple M5 Ultra", kind: "apple", q4: 3955.7, q8: 3928.4 },
  { match: "Apple M5 Max", kind: "apple", q4: 2576.0, q8: 2515.0 },
  { match: "Apple M5 Pro", kind: "apple", q4: 1340.4, q8: 1302.6 },
  { match: "Apple M5", kind: "apple", q4: 578.2, q8: 572.3 },
  { match: "RTX PRO 6000", kind: "nvidia", q4: 14854.6, q8: 14303.2 },
  { match: "RTX 5090 Laptop", kind: "nvidia", q4: 6667.1, q8: 6419.6 },
  { match: "RTX 5090", kind: "nvidia", q4: 14073.4, q8: 13551.0 },
  { match: "RTX 4090", kind: "nvidia", q4: 11992.7, q8: 11547.5 },
  { match: "RTX 3090", kind: "nvidia", q4: 5174.7, q8: 4982.6 },
  { match: "RTX 3060", kind: "nvidia", q4: 2137.5, q8: 2058.2 },
  { match: "H100", kind: "nvidia", q4: 9918.3, q8: 9550.2 },
  { match: "A100", kind: "nvidia", q4: 4849.5, q8: 4669.5 },
];

export const GIB = 2 ** 30;

export type Fit = "runs well" | "tight" | "won't fit";

/**
 * The memory a model may use. Metal's recommendedMaxWorkingSetSize is 2/3 of RAM up to 32 GiB and
 * 3/4 above it on macOS 15 and earlier; macOS 26 allows a little more, so this stays on the safe side.
 */
export function budgetBytes(m: Machine): number {
  if (m.gpu) return m.gpu.vramBytes;
  if (m.os === "darwin") return m.ramBytes <= 32 * GIB ? (m.ramBytes * 2) / 3 : (m.ramBytes * 3) / 4;
  return m.ramBytes * 0.75;
}

/**
 * The file plus the KV cache, recurrent state and compute at `-c 8192 -ub 4096`, from measured
 * llama-server peaks. kev runs in embedding mode and keeps full-vocabulary logits for the whole
 * ubatch, measured at 3.8 GiB more at `-ub 4096`.
 */
export function needBytes(model: { bytes: number; params: number; decisionType: string }): number {
  // ponytail: two flat overheads by size class, measured on a handful of models; measure per family if a new one runs over.
  return model.bytes + (model.params > 15e9 ? 2.5 : 1.5) * GIB + (model.decisionType === "kev" ? 3.8 * GIB : 0);
}

/** llama.cpp keeps 1 GiB free, and a model at 90% of what is left still leaves the rest of the machine room. */
export function fitOf(need: number, budget: number): Fit {
  const usable = budget - GIB;
  if (need <= 0.9 * usable) return "runs well";
  return need <= budget ? "tight" : "won't fit";
}

/**
 * The CHIPS row for this machine: the longest match wins, so "Apple M4 Pro" never reads as "Apple M4",
 * and a match must not run on into a digit, so a later "Apple M10" is unknown rather than an M1.
 */
function chipRow(m: Machine): { q4: number; q8: number } | null {
  const name = m.gpu ? m.gpu.name : m.chip;
  const kind = m.gpu ? "nvidia" : "apple";
  const matches = (match: string): boolean => {
    const at = name.indexOf(match);
    return at !== -1 && !/\d/.test(name.charAt(at + match.length));
  };
  const row = CHIPS.filter((r) => r.kind === kind && matches(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
  if (!row) return null;
  return row.variants?.find((v) => v.cpus === m.cpus) ?? row;
}

/** Seconds for one question of `tokens` prompt tokens, or null when the chip is not in the table (CPU only, or unknown). */
export function secondsPerQuestion(model: { params: number; quant: string }, m: Machine, tokens = 500): number | null {
  const row = chipRow(m);
  if (!row) return null;
  const pp = model.quant.startsWith("Q8") || model.quant === "BF16" ? row.q8 : row.q4;
  // ponytail: published pp512 of a dense 7B scaled by 1/params, good to about +-30%; replace with a measured tokens/s after the first local ask if it matters.
  const tps = ((pp * 6.74) / (model.params / 1e9)) * 0.9;
  return 0.05 + tokens / tps;
}
