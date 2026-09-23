process.env.TZ = "UTC";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadJevel } from "../src/jevel.js";
import { type AskLine, readLog } from "../src/log.js";
import { App } from "../src/tui/app.js";
import { checkDraft, editDraft, exampleOf, layout, rowOf } from "../src/tui/try.js";
import { type TestServer, startServer } from "./fixtures/server.js";

const SHIPPED = join(process.cwd(), "jevels");
const triage = loadJevel("ticket-triage", [SHIPPED]).jevel;
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());
const client = () => new TypeSafeClient({ apiKey: "test-key", baseURL: server.url, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
const home = () => mkdtempSync(join(tmpdir(), "jevelry-try-"));
const asks = async (h: string) => (await readLog(h)).filter((l): l is AskLine => l.kind === "ask");
/** Waits until the frame shows `text`, for the ask's round trip to the local server. */
const until = async (frame: () => string | undefined, text: string) => {
  for (let i = 0; i < 50 && !(frame() ?? "").includes(text); i++) await tick(40);
  expect(frame()).toContain(text);
};
const tryApp = (h: string, size = { columns: 80, rows: 24 }) =>
  render(createElement(App, { home: h, dirs: [SHIPPED], lines: [], size, screen: "try", jevel: "ticket-triage", client: client(), version: "9.9.9" }));
/** Try opens to read; e starts editing, with the cursor at the end of the text. */
const editing = async (stdin: { write: (s: string) => void }) => { stdin.write("e"); await tick(); };

describe("the Try text area", () => {
  // The text wraps at spaces, so a customer's message reads as words in a narrow column.
  it("cuts long lines at the last space that fits, and finds the cursor's row", () => {
    const rows = layout('{"m": "one two three"}\n}', 10);
    expect(rows.map((r) => '{"m": "one two three"}\n}'.slice(r.start, r.start + r.len))).toEqual(['{"m": ', '"one two ', 'three"}', "}"]);
    expect(rowOf(rows, 0)).toBe(0);
    // Right after a row that is cut is the next row's first character.
    expect(rowOf(rows, 6)).toBe(1);
    // The end of a line stays on that line.
    expect(rowOf(rows, 22)).toBe(2);
    expect(rowOf(rows, 24)).toBe(3);
  });

  it("types, deletes and moves by rows, and turns a pasted CRLF into newlines", () => {
    let d = { text: "ab\ncd", at: 5 };
    d = editDraft(d, "", { backspace: true }, 20);
    expect(d).toEqual({ text: "ab\nc", at: 4 });
    d = editDraft(d, "", { upArrow: true }, 20);
    expect(d.at).toBe(1);
    d = editDraft(d, "x", {}, 20);
    expect(d).toEqual({ text: "axb\nc", at: 2 });
    d = editDraft(d, "1\r\n2", {}, 20);
    expect(d.text).toBe("ax1\n2b\nc");
    // Keys that are not text change nothing.
    expect(editDraft(d, "", { escape: true }, 20)).toBe(d);
  });

  // The person sees why enter will not ask before they press it.
  it("says what is wrong: not JSON, a missing key the jevel requires, or nothing", () => {
    expect(checkDraft(exampleOf(triage), triage)).toHaveProperty("state");
    expect(checkDraft("{", triage)).toMatchObject({ error: expect.stringMatching(/^not JSON yet: /) });
    expect(checkDraft("{}", triage)).toEqual({ error: "state is missing the required key `ticket`" });
    expect(checkDraft("42", triage)).toEqual({ error: "the state must be a string, a JSON object or an array" });
  });
});

describe("Try", () => {
  // The first minute: the example is there, enter asks, the answer comes back as bars, and the ask is in the log.
  it("opens on the jevel's example, and enter asks Jev and shows every question's answer and decision, at 80x24 and 120x40", async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]) {
      const h = home();
      const { stdin, lastFrame, unmount } = tryApp(h, size);
      await tick();
      const frame = lastFrame() ?? "";
      expect(frame.split("\n")).toHaveLength(size.rows);
      for (const l of frame.split("\n")) expect(l.length).toBeLessThanOrEqual(size.columns);
      expect(frame).toContain("Try ticket-triage  v3");
      expect(frame).toContain('"subject": "Charged twice"');
      expect(frame).toContain("valid state · enter asks Jev");
      expect(frame).toContain("questions: team (choice), urgent");
      stdin.write(ENTER);
      await until(lastFrame, "team = billing");
      const answered = lastFrame() ?? "";
      expect(answered).toMatch(/> billing\s+█+\S*\s+0\.90/);
      expect(answered).toContain("urgent = yes   act 0.97");
      expect(answered).toContain("frustration = level 0   act 0.72");
      expect(answered).toContain("jev-1.13.0 · ");
      expect(answered).toContain("logged");
      await until(lastFrame, "r ask again");
      const logged = await asks(h);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0" });
      // r asks again, and that ask is logged too.
      stdin.write("r");
      await tick(300);
      expect(await asks(h)).toHaveLength(2);
      unmount();
    }
  });

  it("shows the JSON error under the text while you type, and enter does not ask until it is fixed", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    await editing(stdin);
    stdin.write(BACKSPACE);
    await tick();
    expect(lastFrame()).toContain("not JSON yet:");
    stdin.write(ENTER);
    await tick(200);
    expect(await asks(h)).toHaveLength(0);
    expect(lastFrame()).not.toContain("team = billing");
    stdin.write("}");
    await tick();
    expect(lastFrame()).toContain("valid state · enter asks Jev");
    unmount();
  });

  it("takes a paste whole, newlines included, as text", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    await editing(stdin);
    for (let i = 0; i < 200; i++) stdin.write(BACKSPACE);
    await tick();
    stdin.write('\x1b[200~{"ticket": {\n "subject": "Pasted", "message": "hq q"}}\x1b[201~');
    await tick();
    expect(lastFrame()).toContain('"subject": "Pasted"');
    // Letters that are shell keys elsewhere (h, q) are text here: still on Try.
    expect(lastFrame()).toContain("valid state · enter asks Jev");
    unmount();
  });

  // Jev being unavailable is weather: the screen says what happened and that every question fell back.
  it("says when Jev could not answer, and logs the failed ask", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    await editing(stdin);
    for (let i = 0; i < 200; i++) stdin.write(BACKSPACE);
    stdin.write('{"ticket": {"subject": "x", "message": "y"}, "fail": 429}');
    await tick();
    stdin.write(ENTER);
    await until(lastFrame, "Jev could not answer: rate_limited");
    expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Every question is fall_back, so your code decides.");
    expect((await asks(h))[0]).toMatchObject({ error: { code: "rate_limited" } });
    unmount();
  });

  // A newcomer's second screen: every shell key works on arrival, and nothing they press lands in the JSON by surprise.
  it("opens to read, e edits, ctrl+p still opens the palette while editing, esc stops editing, p picks another jevel", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    expect(lastFrame()).toContain("State  e edits");
    expect(lastFrame()).toContain("enter ask  e edit  p other jevel");
    stdin.write("?");
    await tick();
    expect(lastFrame()).toContain("Keys");
    stdin.write(ESC);
    await tick();
    await editing(stdin);
    expect(lastFrame()).toContain("State  editing");
    stdin.write("\u0010");
    await tick();
    expect(lastFrame()).toContain("Commands");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("State  editing");
    expect(lastFrame()).toContain("valid state · enter asks Jev");
    stdin.write(ESC);
    await tick();
    stdin.write("p");
    await tick();
    expect(lastFrame()).toContain("Try a jevel");
    for (const ch of "failing") stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("Try failing-test");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("Try ticket-triage with a sample ticket");
    unmount();
  });

  // The ask was typed here by the person reading it, so it keeps its state: the card later shows what Jev saw.
  it("logs the state it asked with", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    expect(lastFrame()).toContain("asks Jev live, and logs the ask with its state");
    await editing(stdin);
    for (let i = 0; i < 200; i++) stdin.write(BACKSPACE);
    stdin.write('{"ticket": {"subject": "Mine", "message": "typed here"}}');
    await tick();
    stdin.write(ENTER);
    await until(lastFrame, "team = billing");
    expect((await asks(h))[0]?.state).toEqual({ ticket: { subject: "Mine", message: "typed here" } });
    unmount();
  });

  // Someone who just installed jevelry: an empty log, one key, and they are asking Jev.
  it("the start screen on an empty log opens Try on ticket-triage with its example", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = render(createElement(App, { home: h, dirs: [SHIPPED], lines: [], size: { columns: 80, rows: 24 }, client: client() }));
    await tick();
    expect(lastFrame()).toContain("Try ticket-triage with a sample ticket");
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("Try ticket-triage");
    expect(lastFrame()).toContain('"subject": "Charged twice"');
    stdin.write(ENTER);
    await until(lastFrame, "team = billing");
    unmount();
  });

  // An edit lives only while jevelry runs, so q asks first; an untouched example quits at once.
  it("keeps an edit across screens, and q asks before quitting with one", async () => {
    const h = home();
    const { stdin, lastFrame, unmount } = tryApp(h);
    await tick();
    await editing(stdin);
    for (let i = 0; i < 200; i++) stdin.write(BACKSPACE);
    stdin.write('{"ticket": {"subject": "Kept"}}');
    await tick();
    stdin.write(ESC);
    await tick();
    stdin.write("y");
    await tick();
    stdin.write("t");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("Try alert-cause");
    stdin.write("p");
    await tick();
    for (const ch of "ticket") stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('"subject": "Kept"');
    stdin.write(ESC);
    await tick();
    stdin.write("q");
    await tick();
    expect(lastFrame()).toContain("Quit jevelry?");
    expect(lastFrame()).toContain("The state you edited in Try is kept only while");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).not.toContain("Quit jevelry?");
    unmount();
  });
});
