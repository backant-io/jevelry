import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync("docs/protocol/ask.schema.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

describe("docs/protocol examples", () => {
  for (const name of ["noul", "choice", "score", "error"]) {
    it(`example-${name}.json validates against ask.schema.json`, () => {
      const doc = JSON.parse(readFileSync(`docs/protocol/example-${name}.json`, "utf8"));
      const ok = validate(doc);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });
  }
  it("rejects a document without protocol", () => {
    expect(validate({ answers: {} })).toBe(false);
  });
  it("rejects an answer with an unknown verdict", () => {
    const doc = JSON.parse(readFileSync("docs/protocol/example-noul.json", "utf8"));
    doc.answers.is_urgent.verdict = "maybe";
    expect(validate(doc)).toBe(false);
  });
});
