#!/usr/bin/env node
// A fake Homebrew for the tests: it reaches no network and installs nothing but a link to the fake
// llama-server, into FAKE_BREW_INSTALL_TO when a test sets it. FAKE_BREW_EXIT makes it fail.
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [verb, formula] = process.argv.slice(2);
process.stdout.write(`==> ${verb === "upgrade" ? "Upgrading" : "Installing"} ${formula}\n`);
process.stderr.write(`==> Pouring ${formula}--0.7.0.arm64_sequoia.bottle.tar.gz\n`);
const exit = Number(process.env.FAKE_BREW_EXIT ?? 0);
if (exit !== 0) process.stderr.write(`Error: ${formula}: the fake brew was told to fail\n`);
else if (process.env.FAKE_BREW_INSTALL_TO) symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "llama-server.mjs"), join(process.env.FAKE_BREW_INSTALL_TO, "llama-server"));
process.exit(exit);
