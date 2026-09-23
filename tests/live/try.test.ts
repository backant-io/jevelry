import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { type AskLine, readLog } from "../../src/log.js";
import { App } from "../../src/tui/app.js";

const key = process.env.TYPESAFE_API_KEY;
const haveKey = key !== undefined && key.trim() !== "";
const live = haveKey ? describe : describe.skip;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The first thing someone does after installing: open Try on ticket-triage and press enter.
live("Try in the TUI against the real API", () => {
  it("asks ticket-triage with its example through the default client, shows the answer and logs the ask", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-live-try-"));
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [join(process.cwd(), "jevels")], lines: [], size: { columns: 120, rows: 40 }, screen: "try", jevel: "ticket-triage" }));
    await tick(100);
    stdin.write("\r");
    for (let i = 0; i < 300 && !(lastFrame() ?? "").includes("r ask again"); i++) await tick(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("team = billing");
    expect(frame).toMatch(/urgent = (yes|no) {3}(act|mark|fall_back) \d\.\d\d/);
    expect(frame).toContain("jev-1.13.0 · ");
    const asks = (await readLog(home)).filter((l): l is AskLine => l.kind === "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.error).toBeUndefined();
    expect(asks[0]?.jevel).toEqual({ name: "ticket-triage", version: 3 });
    unmount();
  });
});
