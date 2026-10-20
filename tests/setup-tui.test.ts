process.env.TZ = "UTC";
// Whether Jev is set up is read from the temp home alone: never this machine's keychain, never a key the shell exported.
process.env.JEVELRY_KEY_STORE = "file";
delete process.env.TYPESAFE_API_KEY;

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CatalogModel, type Choice, listModels, rank } from "../src/catalog.js";
import type { LocalModel } from "../src/config.js";
import { SetupError, type SetupIO } from "../src/setup.js";
import { App } from "../src/tui/app.js";
import type { SetupSeam } from "../src/tui/setup.js";
import { type FakeHf, startHf } from "./fixtures/hf.js";
import { M4_PRO_24 } from "./fixtures/sandbox.js";

const PEEK = process.env.PEEK === "1";
const SIZES = [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }];
type Size = (typeof SIZES)[number];
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";
const ESC = "\u001B";
const DOWN = "\u001B[B";
const CTRL_P = "\u0010";

let hf: FakeHf;
let models: CatalogModel[];
beforeAll(async () => {
  hf = await startHf();
  models = await listModels({ hfUrl: hf.url });
});
afterAll(async () => hf.close());

/** A temp home; with a stored key it is a jevelry already set up with TypeSafe. */
const home = (key = false): string => {
  const h = mkdtempSync(join(tmpdir(), "jevelry-setup-tui-"));
  if (key) writeFileSync(join(h, "env"), "TYPESAFE_API_KEY=test-key\n");
  return h;
};

/** An install that records what it was asked to install and ends when the test says, so the progress dialog can be read. */
function fakeInstall() {
  const calls: Choice[] = [];
  let io: SetupIO | undefined;
  let settle: (r: LocalModel | Error) => void = () => undefined;
  const install = (choice: Choice, given: SetupIO): Promise<LocalModel> => {
    calls.push(choice);
    io = given;
    return new Promise((resolve, reject) => { settle = (r) => (r instanceof Error ? reject(r) : resolve(r)); });
  };
  return { calls, install, io: () => io!, settle: (r: LocalModel | Error) => settle(r) };
}

const LOCAL: LocalModel = {
  repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B", decisionType: "vllm-d3",
  path: "/nowhere/vllm-d3-flash-Q8_0.gguf", port: 1, alias: "local/vllm-d3-flash-Q8_0",
};

/** Waits until the frame shows `text`, for the steps that resolve a promise first. */
const until = async (frame: () => string | undefined, text: string) => {
  for (let i = 0; i < 50 && !(frame() ?? "").includes(text); i++) await tick(40);
  expect(frame()).toContain(text);
};

/**
 * The App with every part of setup replaced: the 24 GB Mac a too-big model crashed, the fake Hugging Face's models,
 * llama.cpp already in place, and an install that never runs anything. No test here reaches a real binary or the network.
 * `press` waits for what a key opens and a moment more, because a screen takes keys only once its effects have run.
 */
const app = async (h: string, size: Size, setup: SetupSeam = {}) => {
  const r = render(createElement(App, {
    home: h, dirs: [], lines: [], version: "9.9.9", size,
    setup: { machine: M4_PRO_24, listModels: () => Promise.resolve(models), runtimeNeeded: () => false, install: fakeInstall().install, ...setup },
  }));
  const press = async (key: string, shows: string) => {
    r.stdin.write(key);
    await until(r.lastFrame, shows);
    await tick();
  };
  await until(r.lastFrame, "ctrl+p  Commands");
  await tick();
  return { ...r, press };
};

/** The frame fills the terminal exactly: as many lines as rows, none wider than the columns. */
const fills = (frame: string | undefined, size: Size) => {
  if (PEEK) console.log(frame);
  const lines = (frame ?? "").split("\n");
  expect(lines).toHaveLength(size.rows);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(size.columns);
};
/** The frame's words with the dialog's line breaks and padding gone, to find a sentence the dialog wrapped. */
const words = (frame: string | undefined) => (frame ?? "").replace(/\s+/g, " ");

/** s, then "A model on this machine": the ranked list for this machine. */
const toList = async (press: (key: string, shows: string) => Promise<void>) => {
  await press("s", "> TypeSafe, hosted");
  await press(DOWN, "> A model on this machine");
  await press(ENTER, "Apple M4 Pro, 24 GB");
};

describe("the start screen before Jev is set up", () => {
  // Try cannot ask anything before there is a key or a model, so a first run sees that first, one key away.
  it("leads with the setup row when there is no key and no model, and s opens setup, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const { lastFrame, press, unmount } = await app(home(), size);
      fills(lastFrame(), size);
      expect(lastFrame()).toMatch(/> s {2}Set up Jev: a TypeSafe key or a model on this machine\s+needed before Try/);
      expect(lastFrame()).toMatch(/ {2}t {2}Try ticket-triage with a sample ticket/);
      await press("s", "> TypeSafe, hosted");
      fills(lastFrame(), size);
      expect(lastFrame()).toContain("Set up Jev");
      expect(lastFrame()).toMatch(/> TypeSafe, hosted\s+needs an API key/);
      expect(lastFrame()).toMatch(/A model on this machine\s+free, private/);
      unmount();
    }
  });

  // Once Jev answers, the row would only push the things a person came for down a line.
  it("has no setup row and no s key once a key is stored", async () => {
    const { stdin, lastFrame, unmount } = await app(home(true), SIZES[0]!);
    expect(lastFrame()).not.toContain("Set up Jev");
    expect(lastFrame()).toMatch(/> t {2}Try ticket-triage with a sample ticket/);
    stdin.write("s");
    await tick(200);
    expect(lastFrame()).not.toContain("TypeSafe, hosted");
    unmount();
  });

  // Someone on hosted Jev who wants a model on their machine later (or back) still finds setup.
  it("offers Set up Jev in the command palette when Jev is already set up", async () => {
    const { lastFrame, press, unmount } = await app(home(true), SIZES[0]!);
    await press(CTRL_P, "Type to search");
    await press("set up", "> Set up Jev");
    await press(ENTER, "> TypeSafe, hosted");
    expect(lastFrame()).toContain("A model on this machine");
    unmount();
  });
});

describe("setup with TypeSafe", () => {
  // A key typed into a TUI ends up in scrollback and screen recordings; the TUI says where the key goes and touches nothing.
  it("says how to store a key and writes nothing, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const h = home();
      const { lastFrame, press, unmount } = await app(h, size);
      await press("s", "> TypeSafe, hosted");
      await press(ENTER, "Run npx jevelry install --typesafe");
      fills(lastFrame(), size);
      expect(words(lastFrame())).toContain("Run npx jevelry install --typesafe in a terminal, or export TYPESAFE_API_KEY. Get a key at https://docs.typesafe.ai.");
      await press(ESC, "ctrl+p  Commands");
      expect(readdirSync(h)).toEqual([]);
      // Still not set up: the row stays until a key is stored.
      expect(lastFrame()).toMatch(/> s {2}Set up Jev/);
      unmount();
    }
  });
});

describe("setup with a model on this machine", () => {
  // The list comes live from Hugging Face and takes a moment; the screen says what it is waiting for.
  it("says it is reading Hugging Face while the list loads, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      let release: (m: CatalogModel[]) => void = () => undefined;
      const { lastFrame, press, unmount } = await app(home(), size, { listModels: () => new Promise((resolve) => { release = resolve; }) });
      await press("s", "> TypeSafe, hosted");
      await press(DOWN, "> A model on this machine");
      await press(ENTER, "Reading decision models from Hugging Face");
      fills(lastFrame(), size);
      release(models);
      await until(lastFrame, "Apple M4 Pro, 24 GB");
      unmount();
    }
  });

  // The picker exists to choose a model this machine can run: each row says its download, whether it fits, how good it is and how fast.
  it("lists the ranked models for this machine with download, fit, score and seconds, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const { lastFrame, press, unmount } = await app(home(), size);
      await toList(press);
      fills(lastFrame(), size);
      // The recommendation is the first row and the cursor is on it.
      expect(lastFrame()).toMatch(/> vLLM-SR d3-flash 9B Q8_0\s+9\.6 GB · runs well · 55\.8 · 2\.1s/);
      expect(lastFrame()).toMatch(/vLLM-SR d3 27B Q4_K_M\s+19\.9 GB · too big · 66\.3 · -/);
      expect(lastFrame()).toMatch(/OpenJev 27B Q4_K_M\s+19\.9 GB · too big · - · -/);
      expect(lastFrame()).not.toContain("won't fit");
      unmount();
    }
  });

  // A 27B model on a 24 GB Mac is what crashed this machine's GPU: the TUI says why and never starts the install.
  it("refuses a model too big for a 24 GB Mac with a toast, and never calls install", async () => {
    const inst = fakeInstall();
    const { lastFrame, press, unmount } = await app(home(), SIZES[0]!, { install: inst.install });
    await toList(press);
    const ranked = rank(models, M4_PRO_24);
    const tooBig = ranked.findIndex((c) => c.fit === "won't fit");
    expect(ranked[tooBig]?.model.name).toBe("vLLM-SR d3 27B");
    for (let i = 1; i <= tooBig; i++) await press(DOWN, `> ${ranked[i]!.model.name}`);
    await press(ENTER, "needs about 22.6 GB; this machine has about 17.2 GB for models");
    expect(lastFrame()).not.toContain("enter install");
    expect(lastFrame()).toContain("Apple M4 Pro, 24 GB");
    expect(inst.calls).toEqual([]);
    unmount();
  });

  // A download of gigabytes is a decision: the person sees everything that decides it before anything happens.
  it("confirms with the model's repo, quant, download, memory, fit, score against hosted Jev, speed and licence, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const inst = fakeInstall();
      const { lastFrame, press, unmount } = await app(home(), size, { install: inst.install });
      await toList(press);
      await press(ENTER, "Install vLLM-SR d3-flash 9B");
      fills(lastFrame(), size);
      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/repo {6}ggml-org\/vllm-d3-flash-GGUF/);
      expect(frame).toMatch(/quant {5}Q8_0/);
      expect(frame).toMatch(/download {2}about 9\.6 GB/);
      expect(frame).toMatch(/needs {5}11\.2 GB of about 17\.2 GB for models/);
      expect(frame).toMatch(/fit {7}runs well/);
      expect(frame).toMatch(/score {5}55\.8, hosted Jev 61\.5 \(Jev Decision Index 0\.3\.2\)/);
      expect(frame).toMatch(/speed {5}about 2\.1 s\/question/);
      expect(frame).toMatch(/licence {3}Apache-2\.0/);
      expect(frame).toContain("enter install   esc back");
      // llama.cpp is there and new enough: nothing about Homebrew.
      expect(frame).not.toContain("Homebrew");
      // esc goes back to the list without installing.
      await press(ESC, "Apple M4 Pro, 24 GB");
      expect(inst.calls).toEqual([]);
      unmount();
    }
  });

  // Homebrew changes the person's machine; the confirm dialog is where they hear it will run, because the install itself does not ask again.
  it("says Homebrew will install or upgrade llama.cpp when the model's type needs it, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const asked: string[] = [];
      const { lastFrame, press, unmount } = await app(home(), size, { runtimeNeeded: (type) => { asked.push(type); return true; } });
      await toList(press);
      await press(ENTER, "Install vLLM-SR d3-flash 9B");
      fills(lastFrame(), size);
      expect(lastFrame()).toContain("Homebrew will install or upgrade llama.cpp");
      expect(asked).toEqual(["vllm-d3"]);
      unmount();
    }
  });

  // Gigabytes take minutes: the screen shows the step and how far the download is, then says when Jev runs here.
  it("installs with a progress bar, then says Jev runs on the model and drops the setup row, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const inst = fakeInstall();
      const { lastFrame, press, unmount } = await app(home(), size, { install: inst.install });
      await toList(press);
      await press(ENTER, "Install vLLM-SR d3-flash 9B");
      await press(ENTER, "Installing vLLM-SR d3-flash 9B");
      expect(inst.calls.map((c) => [c.model.id, c.quant.quant])).toEqual([["vllm-d3-flash", "Q8_0"]]);
      // The confirm dialog asked already, Homebrew included, so the installer's own questions are answered yes.
      expect(await inst.io().confirm("install llama.cpp with Homebrew (brew install llama.cpp)?")).toBe(true);
      inst.io().progress("download", 4.2e9, 9.6e9);
      await until(lastFrame, "Downloading vllm-d3-flash-Q8_0.gguf");
      fills(lastFrame(), size);
      expect(lastFrame()).toMatch(/█+\S*\s+43% {2}4\.2 of 9\.6 GB/);
      inst.io().progress("loading the model");
      await until(lastFrame, "loading the model");
      expect(lastFrame()).not.toContain("43%");
      inst.settle(LOCAL);
      await until(lastFrame, "Jev now runs on vLLM-SR d3-flash 9B on this machine");
      expect(lastFrame()).not.toContain("Set up Jev");
      expect(lastFrame()).toMatch(/> t {2}Try ticket-triage with a sample ticket/);
      unmount();
    }
  });

  // A failed setup is only fixable with its reason: the installer's message is shown as it is.
  it("shows a SetupError's message, and the setup row stays, at 80x24 and 120x40", async () => {
    for (const size of SIZES) {
      const inst = fakeInstall();
      const { lastFrame, press, unmount } = await app(home(), size, { install: inst.install });
      await toList(press);
      await press(ENTER, "Install vLLM-SR d3-flash 9B");
      await press(ENTER, "Installing vLLM-SR d3-flash 9B");
      inst.settle(new SetupError("brew install llama.cpp failed with exit 1:\nError: the fake brew was told to fail"));
      await until(lastFrame, "Setup stopped");
      await tick();
      fills(lastFrame(), size);
      expect(lastFrame()).toContain("brew install llama.cpp failed with exit 1:");
      expect(lastFrame()).toContain("Error: the fake brew was told to fail");
      await press(ESC, "ctrl+p  Commands");
      expect(lastFrame()).toMatch(/> s {2}Set up Jev/);
      unmount();
    }
  });

  // Without the list there is nothing to choose from; the reason Hugging Face could not be read is the way forward.
  it("says why Hugging Face could not be read", async () => {
    const { lastFrame, press, unmount } = await app(home(), SIZES[0]!, { listModels: () => Promise.reject(new Error("could not reach Hugging Face: connect ECONNREFUSED 127.0.0.1:9")) });
    await press("s", "> TypeSafe, hosted");
    await press(DOWN, "> A model on this machine");
    await press(ENTER, "Setup stopped");
    fills(lastFrame(), SIZES[0]!);
    expect(lastFrame()).toContain("could not reach Hugging Face: connect ECONNREFUSED 127.0.0.1:9");
    unmount();
  });
});
