import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CatalogModel, findModel, hfUrl, licenceLabel, listModels, rank, renderTable } from "../src/catalog.js";
import { type FakeHf, ROWS, startHf } from "./fixtures/hf.js";
import { LINUX_CPU, M2_16, M4_PRO_24 } from "./fixtures/sandbox.js";

let hf: FakeHf;
let models: CatalogModel[];
beforeAll(async () => {
  hf = await startHf();
  models = await listModels({ hfUrl: hf.url });
});
afterAll(async () => hf.close());

const byId = (id: string) => models.find((m) => m.id === id);

describe("listModels", () => {
  // Only what llama-server can serve and ggml-org or LiquidAI built may reach the picker: a test
  // build, an unknown decision type or a broken clef conversion would install and then fail.
  it("keeps only supported decision models with a Q8_0 or Q4_K_M file", () => {
    expect(models.map((m) => m.id).sort()).toEqual(["clef", "d1-2b", "d1-3b", "d1-omni-2b", "kev-4b", "openjev", "vllm-d3", "vllm-d3-flash"]);
  });
  // ggml-org and LiquidAI both publish d1-Omni-2B, and both would be listed under one id: a person would see the model
  // twice and could not say which one `install --local d1-omni-2b` means. One row a model, and the copy the index scores.
  it("lists a model once when two authors publish it, keeping the copy the index scores", () => {
    expect(models.filter((m) => m.id === "d1-omni-2b").map((m) => m.repo)).toEqual(["LiquidAI/d1-Omni-2B-GGUF"]);
  });

  // Asking both official authors with the decision filter is what keeps the list to official decision builds.
  it("asks each official author once for gguf decision models", () => {
    const listings = hf.requests.filter((r) => r.url.startsWith("/api/models?"));
    expect(listings.map((r) => new URL(r.url, "http://x").searchParams.get("author")).sort()).toEqual(["LiquidAI", "ggml-org"]);
    for (const r of listings) expect(new URL(r.url, "http://x").searchParams.getAll("filter")).toEqual(["gguf", "decision-model"]);
  });

  // The download size and the fit come from these rows, so the mmproj (a vision projector jevelry
  // never loads) must not pass for the Q8_0 model, and the more precise quant comes first.
  it("lists Q8_0 before Q4_K_M, leaves mmproj files out and estimates sizes from the parameter count", () => {
    const flash = byId("vllm-d3-flash")!;
    expect(flash.quants).toEqual([
      { quant: "Q8_0", file: "vllm-d3-flash-Q8_0.gguf", bytes: Math.round(8.95e9 * 1.07) },
      { quant: "Q4_K_M", file: "vllm-d3-flash-Q4_K_M.gguf", bytes: Math.round(8.95e9 * 0.74) },
    ]);
    expect(flash).toMatchObject({ repo: "ggml-org/vllm-d3-flash-GGUF", name: "vLLM-SR d3-flash 9B", decisionType: "vllm-d3", params: 8.95e9, score: 54.27 });
  });

  // OpenJev and Nimble are non-commercial and Liquid's licence has a revenue limit: a person must see that before downloading.
  it("reads the licence name before the licence and says what it allows", () => {
    expect(byId("d1-3b")?.licence).toBe("lfm1.0");
    expect(licenceLabel("lfm1.0")).toBe("LFM 1.0, commercial use under $10M revenue");
    expect(licenceLabel(byId("openjev")!.licence)).toBe("CC BY-NC 4.0, non-commercial");
    expect(licenceLabel("apache-2.0")).toBe("Apache-2.0");
    expect(licenceLabel("mit")).toBe("mit");
    expect(byId("openjev")).toMatchObject({ score: null, note: expect.stringContaining("not on the index") });
  });

  // A file name with "../" in the listing would be written outside the models folder: it is never offered.
  it("leaves out files whose names are not plain paths", async () => {
    const row = { ...ROWS["ggml-org"]![0]!, siblings: [{ rfilename: "../vllm-d3-flash-Q8_0.gguf" }, { rfilename: "vllm-d3-flash-Q4_K_M.gguf" }] };
    const listing = (async (url: string) => new Response(JSON.stringify(url.includes("author=ggml-org") ? [row] : []))) as unknown as typeof fetch;
    const [model] = await listModels({ hfUrl: "http://hf.test", fetch: listing });
    expect(model?.quants.map((q) => q.file)).toEqual(["vllm-d3-flash-Q4_K_M.gguf"]);
  });

  // The setup cannot go on without the list, so the failure must say where it failed.
  it("throws saying Hugging Face could not be reached", async () => {
    await expect(listModels({ hfUrl: "http://127.0.0.1:9" })).rejects.toThrow(/could not reach Hugging Face/);
    const failing = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
    await expect(listModels({ hfUrl: hf.url, fetch: failing })).rejects.toThrow(/could not reach Hugging Face: .* answered 502/);
  });

  // The tests point it at the fake; nobody else should ever leave huggingface.co.
  it("takes JEVELRY_HF_URL over huggingface.co", () => {
    expect(hfUrl({})).toBe("https://huggingface.co");
    expect(hfUrl({ JEVELRY_HF_URL: "http://127.0.0.1:1234/" })).toBe("http://127.0.0.1:1234");
  });
});

describe("rank and choose", () => {
  // A 27B model crashed this 24 GiB Mac's GPU today: the picker exists so that never happens again.
  // A model runs well up to 60% of the usable memory, 9 GiB here: the 9B's Q8_0 needs 10.4 GiB and is a tight fit,
  // its Q4_K_M needs 7.7 GiB and runs well, so that is the one recommended.
  it("never offers a 27B as runnable on an Apple M4 Pro with 24 GB, and recommends vllm-d3-flash at Q4_K_M", () => {
    const ranked = rank(models, M4_PRO_24);
    for (const c of ranked.filter((c) => c.model.params > 20e9)) expect(c.fit).toBe("won't fit");
    expect(ranked[0]).toMatchObject({ model: { id: "vllm-d3-flash" }, quant: { quant: "Q4_K_M" }, fit: "runs well" });
  });

  // On 16 GB 60% of the usable memory is 5.8 GiB: a 9B is a tight fit even at Q4_K_M, and the first model that
  // runs well is a 4B at Q4_K_M.
  it("gives a 16 GB Mac a 4B model at Q4_K_M first, and calls the 9B tight even at Q4_K_M", () => {
    const ranked = rank(models, M2_16);
    expect(ranked[0]).toMatchObject({ model: { id: "kev-4b" }, quant: { quant: "Q4_K_M" }, fit: "runs well" });
    expect(ranked.find((c) => c.model.id === "vllm-d3-flash")).toMatchObject({ quant: { quant: "Q4_K_M" }, fit: "tight" });
  });

  // The order is the advice: what runs well first, best score first, a model without a score after the scored ones.
  it("orders by fit, then score with null last, then name", () => {
    const ranked = rank(models, M4_PRO_24);
    const fits = ranked.map((c) => c.fit);
    expect(fits).toEqual([...fits].sort((a, b) => ["runs well", "tight", "won't fit"].indexOf(a) - ["runs well", "tight", "won't fit"].indexOf(b)));
    expect(ranked.filter((c) => c.fit === "runs well").map((c) => c.model.id)).toEqual(["vllm-d3-flash", "kev-4b", "d1-2b", "d1-omni-2b", "d1-3b"]);
    expect(ranked.filter((c) => c.fit === "won't fit").map((c) => c.model.id)).toEqual(["vllm-d3", "clef", "openjev"]);
  });

  // A model that cannot load has no speed on this machine; showing one would invite a try.
  it("gives a model that won't fit no seconds per question", () => {
    expect(rank(models, M4_PRO_24).find((c) => c.model.id === "vllm-d3")?.seconds).toBeNull();
  });
});

describe("findModel", () => {
  const ranked = () => rank(models, M4_PRO_24);

  // `jevelry install --local <x>` takes what the table shows: the id, the repo or the row number.
  it("finds a row by id, repo or 1-based number, and nothing for an unknown name", () => {
    expect(findModel(ranked(), "kev-4b")?.model.id).toBe("kev-4b");
    expect(findModel(ranked(), "ggml-org/Kev-4B-GGUF")?.model.id).toBe("kev-4b");
    expect(findModel(ranked(), "1")?.model.id).toBe("vllm-d3-flash");
    expect(findModel(ranked(), "0")).toBeUndefined();
    expect(findModel(ranked(), "nope")).toBeUndefined();
  });

  // Forcing a quant must not carry over the other quant's fit: a forced Q8_0 of a 27B still won't fit.
  it("forces a quant with a suffix and works its need and fit out again", () => {
    const q8 = findModel(ranked(), "vllm-d3-flash:q8_0", M4_PRO_24)!;
    expect(q8.quant.quant).toBe("Q8_0");
    expect(q8.need).toBeGreaterThan(findModel(ranked(), "vllm-d3-flash")!.need);
    expect(q8.fit).toBe("tight");
    expect(findModel(rank(models, M2_16), "vllm-d3-flash:Q8_0", M2_16)).toMatchObject({ quant: { quant: "Q8_0" }, fit: "tight" });
    expect(findModel(ranked(), "clef:Q8_0", M4_PRO_24)).toBeUndefined();
  });
});

describe("renderTable", () => {
  // The table is what a person decides on, so every column it promises must be there and readable.
  it("prints the machine, the index and one fixed-column row per model, with dashes for unknowns and the notes after", () => {
    const text = renderTable(rank(models, M4_PRO_24), M4_PRO_24);
    const lines = text.split("\n");
    expect(lines[0]).toBe("This machine: Apple M4 Pro, 24 GB memory, about 17 GB usable by the GPU");
    expect(lines[1]).toBe("Ranked by the Jev Decision Index 0.4.1, where hosted Jev 1.14 scores 60.2");
    expect(lines[3]).toMatch(/^ {2}# {2}id +model +quant +download +needs {2}fit +score {2}s\/question {2}licence$/);
    expect(lines[4]).toMatch(/^ {2}1 {2}vllm-d3-flash +vLLM-SR d3-flash 9B +Q4_K_M +6\.6 GB +8\.2 GB {2}runs well +54\.3 +2\.1 {2}Apache-2\.0$/);
    const openjev = lines.find((l) => l.includes("OpenJev 27B ")) ?? "";
    expect(openjev).toMatch(/won't fit +- +- {2}CC BY-NC 4\.0, non-commercial$/);
    // Fixed columns: every row's licence starts where the header's does.
    const at = lines[3]!.indexOf("licence");
    for (const row of lines.slice(4, 10)) expect(row.slice(at - 2, at)).toBe("  ");
    expect(text).toContain("\nOpenJev 27B: not on the index; ");
    expect(text.endsWith("\n")).toBe(true);
  });

  // "runs well" is judged against what the GPU may use at most. Measured here: an 11.2 GB model read "runs well"
  // while about 10 GB was free, and loading into memory other programs hold is what pushes them out.
  it("names the models that need more memory than is free right now, and says nothing when all of them have room", () => {
    const GIB = 2 ** 30;
    const busy = renderTable(rank(models, M4_PRO_24), { ...M4_PRO_24, freeBytes: 6 * GIB });
    const note = busy.trimEnd().split("\n").at(-1) ?? "";
    expect(note).toMatch(/^About 6\.4 GB of memory is free right now\. These need more, so close other programs before you install one: /);
    // 11.2 GB and 6.6 GB do not fit in 6.4 GB; d1-3b's 4.5 GB does, and a model that will not fit at all is not offered here.
    expect(note).toContain("vllm-d3-flash");
    expect(note).toContain("kev-4b");
    expect(note).not.toContain("d1-3b");
    expect(note).not.toContain("openjev");
    expect(renderTable(rank(models, M4_PRO_24), { ...M4_PRO_24, freeBytes: 20 * GIB })).not.toContain("free right now");
    // Another machine's picks, from JEVELRY_MACHINE, carry no free memory: this machine's would say nothing about it.
    expect(renderTable(rank(models, M4_PRO_24), M4_PRO_24)).not.toContain("free right now");
  });

  // Without a known GPU there is no published speed to scale, and the line says so instead of guessing.
  it("says no supported GPU was found on a CPU-only machine", () => {
    expect(renderTable(rank(models, LINUX_CPU), LINUX_CPU).split("\n")[0]).toBe("This machine: AMD EPYC 7763 64-Core Processor, 64 GB memory, no supported GPU found (speed not estimated)");
  });
});
