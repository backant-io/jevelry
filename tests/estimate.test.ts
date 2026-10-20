import { describe, expect, it } from "vitest";
import { budgetBytes, detectMachine, fitOf, needBytes, secondsPerQuestion } from "../src/estimate.js";
import { LINUX_CPU, M2_16, M4_PRO_24, RTX_4090 } from "./fixtures/sandbox.js";

const GIB = 2 ** 30;

describe("detectMachine", () => {
  // The tests and a person who wants the picker for another machine both depend on this override,
  // and with it set nothing about this machine is read.
  it("takes JEVELRY_MACHINE verbatim, and says so when it is not JSON", () => {
    expect(detectMachine({ JEVELRY_MACHINE: JSON.stringify(RTX_4090) })).toEqual(RTX_4090);
    expect(() => detectMachine({ JEVELRY_MACHINE: "{ nope" })).toThrow(/JEVELRY_MACHINE is not JSON/);
  });
});

describe("budgetBytes, needBytes and fitOf", () => {
  // Metal gives a 24 GiB Mac about 16 GiB for models: offering more is how the GPU gets overcommitted.
  it("gives a Mac 2/3 of its memory up to 32 GiB and 3/4 above, an NVIDIA GPU its VRAM, a CPU 3/4", () => {
    expect(budgetBytes(M4_PRO_24)).toBe(16 * GIB);
    expect(budgetBytes({ ...M4_PRO_24, ramBytes: 64 * GIB })).toBe(48 * GIB);
    expect(budgetBytes(RTX_4090)).toBe(24564 * 2 ** 20);
    expect(budgetBytes(LINUX_CPU)).toBe(48 * GIB);
  });

  // kev keeps full-vocabulary logits for the whole ubatch: a kev that looks like it fits by file
  // size alone can still run the machine out of memory.
  it("adds 3.8 GiB for a kev model and more overhead above 15B parameters", () => {
    const small = { bytes: 4e9, params: 4e9 };
    expect(needBytes({ ...small, decisionType: "kev" }) - needBytes({ ...small, decisionType: "vllm-d3" })).toBeCloseTo(3.8 * GIB);
    expect(needBytes({ bytes: 20e9, params: 27e9, decisionType: "vllm-d3" })).toBe(20e9 + 2.5 * GIB);
    expect(needBytes({ ...small, decisionType: "vllm-d3" })).toBe(4e9 + 1.5 * GIB);
  });

  // "runs well" leaves the rest of the machine room; "tight" works but squeezes; past the budget it never loads.
  it("calls a need runs well up to 90% of the budget less 1 GiB, tight up to the budget, else won't fit", () => {
    const budget = 16 * GIB;
    expect(fitOf(0.9 * 15 * GIB, budget)).toBe("runs well");
    expect(fitOf(0.9 * 15 * GIB + 1, budget)).toBe("tight");
    expect(fitOf(budget, budget)).toBe("tight");
    expect(fitOf(budget + 1, budget)).toBe("won't fit");
  });
});

describe("secondsPerQuestion", () => {
  // The picker's speed column is what a person weighs against the score, so the chip must be read
  // right: an M4 Pro is not an M4, and the 14-core bin is faster than the 12-core one.
  it("matches the longest chip name and the CPU-count bin", () => {
    const flash = { params: 8.95e9, quant: "Q8_0" };
    const pro = secondsPerQuestion(flash, M4_PRO_24)!;
    expect(pro).toBeCloseTo(0.05 + 500 / ((367.1 * 6.74) / 8.95 * 0.9), 6);
    expect(secondsPerQuestion(flash, { ...M4_PRO_24, cpus: 14 })!).toBeLessThan(pro);
    expect(secondsPerQuestion(flash, { ...M4_PRO_24, chip: "Apple M4" })!).toBeGreaterThan(pro);
    expect(secondsPerQuestion({ ...flash, quant: "Q4_K_M" }, M2_16)).toBeCloseTo(0.05 + 500 / ((145.9 * 6.74) / 8.95 * 0.9), 6);
  });

  // A laptop 5090 is half a desktop one; reading it as the desktop card would promise twice the speed.
  it("reads an NVIDIA GPU by its name, laptop parts included", () => {
    const flash = { params: 8.95e9, quant: "Q4_K_M" };
    const desktop = secondsPerQuestion(flash, { ...RTX_4090, gpu: { name: "NVIDIA GeForce RTX 5090", vramBytes: 32 * GIB } })!;
    const laptop = secondsPerQuestion(flash, { ...RTX_4090, gpu: { name: "NVIDIA GeForce RTX 5090 Laptop GPU", vramBytes: 24 * GIB } })!;
    expect(laptop).toBeGreaterThan(desktop * 1.5);
  });

  // No published number means no estimate: a made-up speed would be worse than a dash.
  it("is null for an unknown chip and for a machine without a supported GPU", () => {
    expect(secondsPerQuestion({ params: 8.95e9, quant: "Q8_0" }, { ...M4_PRO_24, chip: "Apple M9 Hyper" })).toBeNull();
    // A later "Apple M10" contains "Apple M1": read as an M1 it would be promised a fraction of its speed.
    expect(secondsPerQuestion({ params: 8.95e9, quant: "Q8_0" }, { ...M4_PRO_24, chip: "Apple M10 Pro" })).toBeNull();
    expect(secondsPerQuestion({ params: 8.95e9, quant: "Q8_0" }, LINUX_CPU)).toBeNull();
  });
});
