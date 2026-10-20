import { type Fit, GIB, type Machine, budgetBytes, detectMachine, fitOf, needBytes, secondsPerQuestion } from "./estimate.js";

export const HF_URL = "https://huggingface.co";

/** `JEVELRY_HF_URL` points every Hugging Face request at another server; the tests point it at a fake. */
export function hfUrl(env: NodeJS.ProcessEnv): string {
  const given = env.JEVELRY_HF_URL?.trim();
  return given ? given.replace(/\/+$/, "") : HF_URL;
}

/** Official builds only: ggml-org converts and checks them, and LiquidAI publishes its own. */
export const AUTHORS = ["ggml-org", "LiquidAI"];

/** The oldest llama-server build that serves each decision type. */
export const MIN_BUILD: Record<string, number> = {
  openjev: 11361,
  kev: 11361,
  lev: 11361,
  laya: 11361,
  nimble: 11364,
  clef: 11371,
  "pplx-decider": 11447,
  "lfm2-d1": 11483,
  "lfm2-d1-omni": 11488,
  "vllm-decision2": 11571,
  "vllm-d3": 11572,
  "granite-switch": 11700,
};

/** Hosted Jev 1.14's score on the same index, the reference every local score is read against. */
export const INDEX = { name: "Jev Decision Index 0.3.2", hosted: 61.53 };

// https://huggingface.co/spaces/multimodalart/jev-decision-index (data/v03.json, full score, chance-corrected, 2026-10-16).
// Scores are of the 16-bit models.
export const SCORES: Record<string, { name: string; score: number | null; note?: string }> = {
  "ggml-org/vllm-d3-GGUF": { name: "vLLM-SR d3 27B", score: 66.26 },
  "ggml-org/vllm-d3-flash-GGUF": { name: "vLLM-SR d3-flash 9B", score: 55.79 },
  "ggml-org/Bespoke-Nimble-9B-v3-GGUF": { name: "Bespoke Nimble 9B v3", score: 54.67 },
  "ggml-org/Clef-GGUF": { name: "Cloudflare Clef 27B", score: 53.08 },
  "ggml-org/vllm-d3-mini-GGUF": { name: "vLLM-SR d3-mini 4B", score: 52.61 },
  "ggml-org/Clef-Flash-GGUF": { name: "Cloudflare Clef-Flash 9B", score: 47.61 },
  "ggml-org/Kev-9B-GGUF": { name: "Kev 9B", score: 43.27 },
  "ggml-org/Kev-4B-GGUF": { name: "Kev 4B", score: 39.5 },
  "LiquidAI/d1-3B-GGUF": { name: "Liquid d1 3B", score: 38.9 },
  "ggml-org/vllm-d3-nano-GGUF": { name: "vLLM-SR d3-nano 2B", score: 38.86 },
  "ggml-org/lev-GGUF": { name: "Interfaze lev 4B", score: 36.53 },
  "ggml-org/vllm-d3-lite-GGUF": { name: "vLLM-SR d3-lite 0.8B", score: 32.33 },
  "ggml-org/vllm-d3-edge-GGUF": { name: "vLLM-SR d3-edge 0.75B", score: 20.24 },
  "ggml-org/Kev-0.8B-GGUF": { name: "Kev 0.8B", score: 13.66 },
  "LiquidAI/d1-omni-600M-GGUF": { name: "Liquid d1-omni 600M", score: 9.09 },
  "ggml-org/Laya-GGUF": { name: "Convai Laya 421M", score: 4.43 },
  "ggml-org/Julia-1-GGUF": { name: "Supersonic Julia-1 144M", score: 2.56 },
  "ggml-org/OpenJev-GGUF": { name: "OpenJev 27B", score: null, note: "not on the index; its card reports 84.0% against hosted Jev's 85.4% on its own 10,000 questions" },
};

export interface Quant {
  quant: "Q8_0" | "Q4_K_M";
  file: string;
  /** An estimate from the parameter count; the exact size comes from the tree API at download time. */
  bytes: number;
}

export interface CatalogModel {
  repo: string;
  /** The repo name lowercased without "-gguf", like "vllm-d3-flash" or "d1-3b". */
  id: string;
  name: string;
  decisionType: string;
  params: number;
  licence: string;
  /** Only the Q8_0 and Q4_K_M files that exist, most precise first, mmproj files left out. */
  quants: Quant[];
  score: number | null;
  note?: string;
}

/** Bytes per parameter, measured on the ggml-org files, most precise first. */
const QUANTS = [
  { quant: "Q8_0", suffix: "-q8_0.gguf", perParam: 1.07 },
  { quant: "Q4_K_M", suffix: "-q4_k_m.gguf", perParam: 0.74 },
] as const;

/** The shape of one row of Hugging Face's model listing, as far as this file reads it. */
interface HfRow {
  id?: unknown;
  gguf?: { total?: unknown; architecture?: unknown; decision_type?: unknown };
  siblings?: Array<{ rfilename?: unknown }>;
  cardData?: { license?: unknown; license_name?: unknown };
}

/** One GET of Hugging Face's JSON API. The setup cannot go on without it, so a failure says Hugging Face could not be reached and why. */
export async function hfJson(url: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
  } catch (error) {
    // fetch says only "fetch failed"; the reason (a refused connection, a DNS failure) is its cause.
    const why = error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
    throw new Error(`could not reach Hugging Face: ${why}`);
  }
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A listing row as a model jevelry can run, or undefined for one it cannot or should not offer. */
function modelOf(row: HfRow): CatalogModel | undefined {
  const repo = text(row.id);
  const type = text(row.gguf?.decision_type);
  const params = row.gguf?.total;
  if (!repo || !type || !Object.hasOwn(MIN_BUILD, type) || typeof params !== "number" || !(params > 0)) return undefined;
  const id = (repo.split("/")[1] ?? repo).toLowerCase().replace(/-gguf$/, "");
  if (id.includes("for-testing")) return undefined;
  // A clef decision header on another architecture is a broken conversion, not a clef model.
  if (type === "clef" && row.gguf?.architecture !== "clef") return undefined;
  const files = (row.siblings ?? []).map((s) => text(s.rfilename)).filter((f): f is string => f !== undefined && !f.toLowerCase().includes("mmproj"));
  const quants: Quant[] = QUANTS.flatMap(({ quant, suffix, perParam }) => {
    const file = files.find((f) => f.toLowerCase().endsWith(suffix));
    return file ? [{ quant, file, bytes: Math.round(params * perParam) }] : [];
  });
  if (quants.length === 0) return undefined;
  const known = SCORES[repo];
  return {
    repo,
    id,
    name: known?.name ?? (repo.split("/")[1] ?? repo).replace(/-GGUF$/, ""),
    decisionType: type,
    params,
    licence: text(row.cardData?.license_name) ?? text(row.cardData?.license) ?? "unknown",
    quants,
    score: known?.score ?? null,
    ...(known?.note ? { note: known.note } : {}),
  };
}

/** Every official decision model jevelry can run, live from Hugging Face: both authors are asked at once. */
export async function listModels(options: { hfUrl: string; fetch?: typeof fetch }): Promise<CatalogModel[]> {
  const pages = await Promise.all(AUTHORS.map((author) =>
    hfJson(`${options.hfUrl}/api/models?author=${author}&filter=gguf&filter=decision-model&expand[]=gguf&expand[]=siblings&expand[]=cardData&limit=200`, options.fetch)));
  return pages.flatMap((page) => (Array.isArray(page) ? (page as HfRow[]) : [])).flatMap((row) => modelOf(row) ?? []);
}

/** The licence in words a person can act on: two of these models are non-commercial and one has a revenue limit. */
export function licenceLabel(licence: string): string {
  if (licence === "apache-2.0") return "Apache-2.0";
  if (licence === "cc-by-nc-4.0") return "CC BY-NC 4.0, non-commercial";
  if (licence === "lfm1.0") return "LFM 1.0, commercial use under $10M revenue";
  return licence;
}

/** One quant of a model on this machine: what it needs, whether it fits and how fast it would answer. */
export interface Choice {
  model: CatalogModel;
  quant: Quant;
  need: number;
  fit: Fit;
  /** Null when the speed cannot be estimated, and for a model that will not fit: it has no speed here. */
  seconds: number | null;
}

function choiceOf(model: CatalogModel, quant: Quant, m: Machine): Choice {
  const need = needBytes({ bytes: quant.bytes, params: model.params, decisionType: model.decisionType });
  const fit = fitOf(need, budgetBytes(m));
  return { model, quant, need, fit, seconds: fit === "won't fit" ? null : secondsPerQuestion({ params: model.params, quant: quant.quant }, m) };
}

/**
 * The most precise quant that runs well wins: prompt speed on Metal is the same for Q4 and Q8, and Q4
 * changes about 5% of d3-flash's answers. Else the smallest that is tight, else the smallest at all.
 */
export function choose(model: CatalogModel, m: Machine): Choice {
  const options = [...model.quants].sort((a, b) => b.bytes - a.bytes).map((q) => choiceOf(model, q, m));
  const smallestFirst = [...options].reverse();
  return options.find((c) => c.fit === "runs well") ?? smallestFirst.find((c) => c.fit === "tight") ?? smallestFirst[0]!;
}

const FIT_ORDER: Fit[] = ["runs well", "tight", "won't fit"];

/** Runs well first, then tight, then won't fit; best score first in each. The first row that runs well is the recommendation. */
export function rank(models: CatalogModel[], m: Machine): Choice[] {
  return models.map((model) => choose(model, m)).sort((a, b) =>
    FIT_ORDER.indexOf(a.fit) - FIT_ORDER.indexOf(b.fit)
    || (b.model.score ?? -Infinity) - (a.model.score ?? -Infinity)
    || a.model.name.localeCompare(b.model.name));
}

/**
 * A row by its id ("vllm-d3-flash"), its repo or its 1-based number. A ":Q4_K_M" or ":Q8_0" suffix
 * forces that quant, whose need and fit are worked out again for `m` (this machine when omitted).
 */
export function findModel(choices: Choice[], wanted: string, m?: Machine): Choice | undefined {
  const given = wanted.trim().toLowerCase();
  if (/^\d+$/.test(given)) return choices[Number(given) - 1];
  const [name, forced] = given.split(":");
  const found = choices.find((c) => c.model.id === name || c.model.repo.toLowerCase() === name);
  if (!found || forced === undefined) return found;
  const quant = found.model.quants.find((q) => q.quant.toLowerCase() === forced);
  return quant ? choiceOf(found.model, quant, m ?? detectMachine()) : undefined;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** Plain text with fixed columns, for `jevelry models --local` and the install prompt. */
export function renderTable(choices: Choice[], m: Machine): string {
  // Memory in GiB, the size a machine is sold as ("24 GB"); everything else in GB like the downloads.
  const ram = Math.round(m.ramBytes / GIB);
  const machine = m.gpu !== null || m.os === "darwin"
    ? `This machine: ${m.chip}, ${ram} GB memory, about ${Math.round(budgetBytes(m) / 1e9)} GB usable by the GPU`
    : `This machine: ${m.chip}, ${ram} GB memory, no supported GPU found (speed not estimated)`;
  const header = ["#", "id", "model", "quant", "download", "needs", "fit", "score", "s/question", "licence"];
  const right = new Set([0, 4, 5, 7, 8]);
  const rows = choices.map((c, i) => [
    String(i + 1),
    c.model.id,
    c.model.name,
    c.quant.quant,
    gb(c.quant.bytes),
    gb(c.need),
    c.fit,
    c.model.score === null ? "-" : c.model.score.toFixed(1),
    c.seconds === null ? "-" : c.seconds.toFixed(1),
    licenceLabel(c.model.licence),
  ]);
  // The row number is at least three wide, so the table is indented by two under the machine line.
  const widths = header.map((h, i) => Math.max(i === 0 ? 3 : h.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string => cells.map((cell, i) => (right.has(i) ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  const notes = choices.filter((c) => c.model.note).map((c) => `${c.model.name}: ${c.model.note}`);
  return [
    machine,
    `Ranked by the ${INDEX.name}, where hosted Jev 1.14 scores ${INDEX.hosted.toFixed(1)}`,
    "",
    line(header),
    ...rows.map(line),
    ...(notes.length > 0 ? ["", ...notes] : []),
  ].join("\n") + "\n";
}
