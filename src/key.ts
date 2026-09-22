import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The keychain entry `jevelry install` writes and reads, and the line in `$JEVELRY_HOME/env`. */
export const KEY_SERVICE = "typesafe-api-key";
export const KEY_ACCOUNT = "jevelry";
export const KEY_VARIABLE = "TYPESAFE_API_KEY";

/**
 * The keychain is the default on macOS and the one place a test may never touch: a suite sets
 * `JEVELRY_KEY_STORE=file` and gets the file store, whatever machine it runs on.
 */
function useKeychain(env: NodeJS.ProcessEnv): boolean {
  return process.platform === "darwin" && env.JEVELRY_KEY_STORE !== "file";
}

function keyFile(home: string): string {
  return join(home, "env");
}

/**
 * The environment first, so a host that exports the key for one command gets exactly that key;
 * then the keychain, where `jevelry install` puts it on macOS; then the file, which is every
 * other machine's store. Nothing here is logged: the value is the one secret this runtime holds.
 */
export function resolveKey(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const fromEnv = env[KEY_VARIABLE];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  if (useKeychain(env)) {
    const found = spawnSync("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"], { encoding: "utf8", timeout: 3000 });
    const value = found.status === 0 ? (found.stdout ?? "").trim() : "";
    if (value !== "") return value;
  }
  let text: string;
  try {
    text = readFileSync(keyFile(home), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${KEY_VARIABLE}=`)) continue;
    const value = trimmed.slice(KEY_VARIABLE.length + 1).trim();
    if (value !== "") return value;
  }
  return undefined;
}

/**
 * The value reaches `security` as one argument of the child process, never as part of a shell
 * string, so it is not in a command line a shell would expand or a history would keep. When the
 * keychain refuses (a locked keychain, a machine without `security`) the file is the honest
 * second choice, and the caller prints where the key actually went.
 */
export function storeKey(value: string, env: NodeJS.ProcessEnv, home: string): "keychain" | "file" {
  if (useKeychain(env)) {
    const added = spawnSync("security", ["add-generic-password", "-U", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w", value], { encoding: "utf8", timeout: 3000 });
    if (added.status === 0) return "keychain";
  }
  mkdirSync(home, { recursive: true });
  const file = keyFile(home);
  writeFileSync(file, `${KEY_VARIABLE}=${value}\n`, { mode: 0o600 });
  // `writeFileSync` applies the mode only when it creates the file: a file that was already there
  // would keep whatever mode it had, and a key readable by everything on the machine is the one
  // outcome this store exists to prevent.
  chmodSync(file, 0o600);
  return "file";
}
