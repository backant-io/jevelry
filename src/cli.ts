import { buildProgram } from "./program.js";

/**
 * The entry `bin/jevelry.js` imports. It is the only place the program is parsed, so a test can
 * build the program and read its commands without the process parsing its own argv.
 */
buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.stderr.write(`jevelry: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
