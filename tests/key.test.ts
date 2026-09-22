import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKey, storeKey } from "../src/key.js";

// Every env here carries JEVELRY_KEY_STORE=file: the suite must never read from or write to the
// machine's real keychain, which is the owner's and is not a fixture.
const FILE_STORE = { JEVELRY_KEY_STORE: "file" } as NodeJS.ProcessEnv;
const home = () => mkdtempSync(join(tmpdir(), "jevelry-key-"));

describe("resolveKey", () => {
  it("prefers a non-blank environment value over the file", () => {
    const dir = home();
    storeKey("from-the-file", FILE_STORE, dir);
    expect(resolveKey({ ...FILE_STORE, TYPESAFE_API_KEY: "from-the-env" }, dir)).toBe("from-the-env");
    // A blank variable is a host that exported nothing, not a host that means "no key".
    expect(resolveKey({ ...FILE_STORE, TYPESAFE_API_KEY: "   " }, dir)).toBe("from-the-file");
  });

  it("falls back to the file in the jevelry home", () => {
    const dir = home();
    storeKey("from-the-file", FILE_STORE, dir);
    expect(resolveKey(FILE_STORE, dir)).toBe("from-the-file");
  });

  it("is undefined when neither the environment nor the file has one", () => {
    expect(resolveKey(FILE_STORE, home())).toBeUndefined();
  });
});

describe("storeKey", () => {
  it("writes the file readable by its owner alone, creating the home, and says where it went", () => {
    const dir = join(home(), "not-yet-there");
    expect(storeKey("a-key", FILE_STORE, dir)).toBe("file");
    const file = join(dir, "env");
    expect(readFileSync(file, "utf8")).toBe("TYPESAFE_API_KEY=a-key\n");
    // A key readable by every process on the machine is the thing this file exists to avoid.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces the line on a second store instead of appending a second one", () => {
    const dir = home();
    storeKey("first", FILE_STORE, dir);
    storeKey("second", FILE_STORE, dir);
    expect(readFileSync(join(dir, "env"), "utf8")).toBe("TYPESAFE_API_KEY=second\n");
    expect(resolveKey(FILE_STORE, dir)).toBe("second");
  });
});
