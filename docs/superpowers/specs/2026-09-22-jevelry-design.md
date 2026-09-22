# jevelry: a runtime for Jev, the way Claude Code is a runtime for an LLM

**Repo:** `backant-io/jevelry`, npm package `jevelry`, binary `jevelry`.
**Status:** design, drafted 2026-09-22 from the owner's direction in a brainstorming session.
**Consumer that drives the first release:** Agent Office (`backant-io/agent-office`), whose reflex
layer spawns `jevelry` the way it spawns `claude` and `pi`. The office's own design lives in that
repo; this document is only the runtime.

## 1. Why

Jev (TypeSafe's System One model, `https://docs.typesafe.ai`) evaluates a state against typed
questions and answers with calibrated probabilities: a `choice` from options, a `score` on ordered
levels, a `noul` probability that a yes/no statement holds. It never generates text, never calls a
tool, never holds a conversation. Everything a host has to do around it is the same every time:
hold the key, pin the model, check the budgets, send one state with every question that state
can answer, turn probabilities into a verdict the host can branch on, and remember what was
asked so the answers can be measured against what later happened.

Claude Code is the runtime that does the equivalent work around an LLM: a print mode a program
can drive, skills that package a capability, metering, retries, a local record. jevelry is that
for Jev. A host spawns one binary, reads one JSON document, and never speaks HTTP or holds a
credential.

## 2. What Jev is, and the constraints that follow

Read from the documentation on 2026-09-22 (`jev-1.13.0`, alias `jev-latest`):

- Input is text only: a string, a JSON object, or an array of text. 64k tokens per request for
  the state plus all questions; 32k for the state plus the longest question. Accuracy falls as
  the state fills with detail the question does not need.
- One request evaluates one state; every question in it is evaluated independently and in
  parallel. Asking many questions in one request is the cheap shape.
- Answers: `choice` carries the option, a probability per option and a `confidence`; `score`
  carries a probability-weighted value, the legend, probabilities per level and a `confidence`;
  `noul` carries one probability and no confidence.
- The model is not tuned per account. Domain rules live in the instructions and criteria of each
  question; boundary cases live in the criteria.
- Jaggedness the runtime must respect: literal reading (say the exact condition), no arithmetic
  or counting (count in code, one question per item), no date comparison, no double negatives,
  contradictory instructions and criteria degrade answers, structural identities across separate
  questions do not hold, and an alias moves when a new release ships.
- Pricing is per input token; output is free. Rate limits answer `429`, overload `529`, both with
  a retry delay. Auth is a bearer key; the official SDKs read it from `TYPESAFE_API_KEY`.
- The official JavaScript SDK is `@typesafe-ai/sdk` (0.6.0 at the time of writing, MIT, Node 20
  or newer): `new TypeSafeClient({ apiKey, baseURL, defaultModel, retry, timeout, fetch })`,
  `client.systemOne({ state, questions, model? })` answering `{ answers, model, usage }`,
  retries honouring `Retry-After` by default, typed error classes, and a `fetch` option for
  transport configuration and tests.

## 3. Decisions

1. **TypeScript on the official SDK.** The SDK already owns transport, retries, typed answers and
   errors; reimplementing them in another language would be work with no owner. Node is on
   every machine the first consumer runs on. Startup cost is tens of milliseconds next to a call
   that takes about a hundred.
2. **A jevel is the unit of use, and it is a file.** Adding a use case is adding a directory with
   one `JEVEL.md`, exactly the shape a Claude Code skill has: frontmatter the runtime reads, a body
   a person or an agent reads. No code changes in jevelry and no code changes in the host beyond
   the one hook that builds the state and reads the verdicts.
3. **Verdicts, not floats.** Every answer comes back with its raw probabilities and a verdict
   (`act`, `mark`, `fall_back`) computed from thresholds the jevel declares. The host branches on
   the verdict; the numbers stay for the record.
4. **Composition stays in the host.** Weights, "gate only if A and not B", routing tables: those
   are the host's control flow, which the TypeSafe guidance says code must own. jevelry evaluates
   one jevel against one state and stops.
5. **A local log with outcomes, from day one.** Every ask is appended to a JSONL log under
   `$JEVELRY_HOME`; `jevelry outcome` records what later proved true; `jevelry report` computes
   agreement per question. Calibration then works for any host, not only the office. A host that
   keeps its own record (the office does) keeps it; the log is the runtime's, never the host's
   truth.
6. **No fake mode.** The product is the real call. Tests stub the SDK's `fetch` seam, and hosts
   double jevelry at their own seam (the office doubles its `Reflex` trait in process).
7. **The host keeps the key out of its own hands.** jevelry reads `TYPESAFE_API_KEY` from its own
   environment; a host passes the environment through and never parses, stores or logs the key.
   jevelry never writes it to the log or to stdout.
8. **The protocol is additive and pinned.** The stdout document carries `protocol: 1`. Fields are
   added, never renamed or removed; a host may pin example documents byte for byte.

## 4. A jevel

A directory `jevels/<name>/` holding `JEVEL.md`. The directory name is the jevel's name and
must equal `name` in the frontmatter.

### 4.1 Frontmatter (YAML)

```yaml
---
name: wake-gate                  # required; [a-z0-9-]+; equals the directory name
version: 1                       # required; integer; bumped by hand when questions change
format: 1                        # optional; the JEVEL.md format version, default 1
model: jev-1.13.0                # optional pin; else JEVELRY_MODEL, else the SDK default
state:
  required: [employee, events, candidates, filing]  # top-level keys the state must carry; missing is exit 2
  budget_tokens: 12000           # optional; an estimate over it is exit 5 before any call
verdict:                         # optional jevel-wide defaults for every question
  act: 0.9
  mark: 0.7
questions:
  worth_a_turn:
    type: noul
    instructions: "Does any event in `events` require an act that `employee`, holding `employee.authority`, must perform now?"
    criteria:
      true: "An event names work, a review, a message or a decision only this employee can act on."
      false: "Every event is informational, already handled, or for somebody else."
    verdict: { act: 0.9, mark: 0.7 }
  depth:
    type: score
    instructions: "How much reasoning does acting on `events` need?"
    criteria:
      - "routine: a known verb on a known object"
      - "judgment: a choice between reasonable options"
      - "hard: the answer depends on reading and weighing several records"
    verdict: { act: 0.7 }
  same_as:
    type: noul
    repeat: { over: candidates, as: candidate }
    instructions: "Does `candidate` describe the same incident as `filing`?"
    verdict: { act: 0.85 }
---
```

Field by field:

- `questions` is a non-empty map. Each question carries `type` (`choice` | `score` | `noul`),
  `instructions` (string, object or array, exactly as the API accepts) and `criteria` in the
  API's shape for its type: a map of option to description (or `null`) for `choice`, at most 255
  options; an ordered list of 2 to 10 level descriptions for `score`; an optional `{ true, false }`
  pair for `noul`.
- `verdict` on a question overrides the jevel-wide `verdict`, which overrides the runtime defaults
  (`act: 0.9`, `mark: 0.7`). A threshold is a number in `[0, 1]` and `mark` must not exceed `act`.
- `repeat: { over: <path>, as: <name> }` expands one question into one per element of the array
  at `<path>` in the state. The runtime rewrites the question so that `<name>` becomes the exact
  backticked path of the element (`candidates[3]`), and names the answers `<question>[<index>]`.
  A `repeat` over a path that is not an array in the state is exit 2. This is the only way a jevel
  may ask about a collection: counting and aggregation are the host's.
- `state.required` lists top-level keys; the check is presence, not shape. It is the one place a
  jevel says what it needs, so a host that sends the wrong thing hears it before paying.
- `state.budget_tokens` is a jevel-specific ceiling under the model's hard budget (section 9).

### 4.2 Body (Markdown)

Prose for whoever uses or tunes the jevel. Four headings are conventional and `jevelry check`
warns when one is missing: **When to use**, **State** (what to send and how to filter it),
**Verdicts** (what each verdict means for the host), **Example** (one state and the expected
answers). The body is never sent to the model.

### 4.3 Validation (`jevelry check`)

Refused (exit 2): missing or malformed frontmatter; `name` not matching the directory; an unknown
`type`; `choice` with fewer than 2 or more than 255 options; `score` with fewer than 2 or more
than 10 levels; a threshold outside `[0, 1]` or `mark > act`; `repeat` without `over` and `as`;
a question id that is not `[a-z0-9_]+`; a `repeat` question id colliding with a plain one.

Warned (exit 0, one line each on stderr): a `noul` whose `criteria.true` reads as a negation
("not", "no", "never" as the first word); instructions containing a double negative; a
conventional body heading missing; `model` unpinned (an alias). Warnings are the jaggedness page
written as checks, so a jevel that would answer badly is told before it is used.

### 4.4 Discovery

Jevels resolve, first match wins, from: `--jevels <dir>` (repeatable), each entry of
`JEVELRY_JEVELS` (path list, `:` separated), `./jevels`, `$JEVELRY_HOME/jevels`. `jevelry list`
prints every jevel found with its source directory; `jevelry show <name>` prints the resolved
frontmatter as JSON and the body.

## 5. Verdicts

For each answer the runtime computes a certainty `c` and compares it to the question's thresholds:

- `choice` and `score`: `c = confidence` as the API returns it.
- `noul`: `c = max(noul, 1 - noul)`. The API returns no confidence for a noul; this is the
  distance from indifference. The answer's `yes` is `noul >= 0.5`.

`verdict = act` when `c >= act`, `mark` when `mark <= c < act`, else `fall_back`. The meaning the
host attaches: act on the answer; act and mark the record for review; take the path it took
before jevelry existed. The docs' three-band pattern, made a value.

The raw `probabilities`, `confidence`, `noul`, `score` and `legend` are always returned beside the
verdict, so a host that wants a different certainty measure has what it needs.

## 6. The CLI

```
jevelry ask <jevel> (--state @file | --state - | --state '<json>') [--model <id>] [--jevels <dir>]... [--no-log]
jevelry ask --questions @file.json --state ...      # one-off questions without a jevel
jevelry outcome <log_id> <question> (agree | disagree | <value>) [--note <text>]
jevelry report [--jevel <name>] [--since <iso>] [--json]
jevelry list | show <name> | check <name>
jevelry models
jevelry install [--no-key] [--project] [--agent <names...>]
jevelry install-skill [--project] [--agent <names...>]
```

- `ask` prints exactly one JSON document on stdout: the answers (section 7) on exit 0, an error
  document (section 7.1) on any other exit. Diagnostics go to stderr as sentences, never stack
  traces.
- `--state -` reads stdin. Batches are the host's loop: one `ask` per state.
- `--questions` takes the API's `questions` map verbatim; verdicts use the runtime defaults.
- `outcome` appends an outcome line to the log; `<value>` is compared to the recorded answer to
  derive agree/disagree: a `choice` agrees when the option matches; a `noul` when `yes`/`no`
  matches; a `score` when the given level index equals the recorded `score` rounded to the
  nearest level. A value that names no option, level or yes/no is exit 2.
- `report` reads the log and prints, per jevel and question: asks, verdict counts, outcomes known,
  agreement among `act` verdicts, agreement among `mark` verdicts, mean certainty. `--json` for
  hosts.
- `models` prints `GET /v1/models` through the SDK.
- `install` copies the packaged skill under `skills/jevelry/` into every coding agent directory it
  finds under the home directory (or, with `--project`, into `.claude/skills` and `.agents/skills`
  of the working directory), prints one line per agent, and then asks once for a key unless
  `--no-key` is given; `install-skill` is the copy alone.
- The key resolves in one order, used by every command and by the installer's "already available"
  check: `TYPESAFE_API_KEY` when non-blank, then the macOS keychain entry (service
  `typesafe-api-key`, account `jevelry`), then the `TYPESAFE_API_KEY=` line of
  `$JEVELRY_HOME/env`; `install` stores into the keychain on macOS and into that file elsewhere,
  and `JEVELRY_KEY_STORE=file` forces the file on any machine.

Environment: `TYPESAFE_API_KEY` (required for `ask` and `models`), `TYPESAFE_BASE_URL` (SDK,
optional), `JEVELRY_MODEL` (default model when neither the jevel nor `--model` pins one; else
the SDK default `jev-latest`), `JEVELRY_HOME` (default `~/.jevelry`), `JEVELRY_JEVELS`,
`JEVELRY_TIMEOUT_MS` (default 30000).

Exit codes a host branches on:

| exit | meaning | stderr says |
| --- | --- | --- |
| 0 | answered | nothing |
| 1 | a usage error or an unexpected failure (commander's own message, or an error no other code covers) | one sentence |
| 2 | the jevel or the state is wrong (host defect) | which field, which rule |
| 3 | rate limited or overloaded after the SDK's retries | `retry_after_ms` if the server gave one |
| 4 | authentication refused or key missing | which variable to set |
| 5 | over budget before sending | the estimate and the ceiling |
| 6 | transport failure or timeout after retries | the SDK's message |
| 7 | the API answered something this build cannot read | the offending field |

## 7. The protocol (stdout of `ask`)

```json
{
  "protocol": 1,
  "log_id": "3f0c2e6a-6f1c-4c7b-9a0e-4d1e6a2b7c11",
  "jevel": { "name": "wake-gate", "version": 1 },
  "model": "jev-1.13.0",
  "state_hash": "sha256:…",
  "answers": {
    "worth_a_turn": { "type": "noul", "noul": 0.08, "yes": false, "certainty": 0.92, "verdict": "act" },
    "depth": { "type": "score", "score": 0.4, "legend": { "0": "routine", "1": "judgment", "2": "hard" },
               "probabilities": { "0": 0.7, "1": 0.2, "2": 0.1 }, "confidence": 0.55, "certainty": 0.55, "verdict": "fall_back" },
    "same_as[0]": { "type": "noul", "noul": 0.97, "yes": true, "certainty": 0.97, "verdict": "act" }
  },
  "usage": { "input_tokens": 1412, "output_tokens": 30 }
}
```

- `jevel` is `null` for `--questions`.
- `state_hash` is SHA-256 over the canonical JSON of the state as sent (keys sorted, no
  whitespace), so a host can recognise an identical state without a second call.
- Every answer carries the API's own fields for its type, plus `certainty` and `verdict`; a noul
  adds `yes`.
### 7.1 The error document

On any non-zero exit stdout carries one document instead, so a host reads one place:

```json
{ "protocol": 1, "error": { "exit": 3, "code": "rate_limited", "message": "TypeSafe answered 429 after 2 retries", "retry_after_ms": 1200 } }
```

`code` is one of `bad_input` (2), `rate_limited` and `overloaded` (3), `auth` (4),
`over_budget` (5), `transport` (6), `unreadable_answer` (7). `retry_after_ms` is present only
when the server gave a delay. `field` is present when the runtime itself knows the field at fault
(a defect in the jevel, a defect in the state, an answer it cannot read) and absent when the
refusal came from the API or the SDK, which name the fault in `message` instead: so a `bad_input`
from a 400 or a 422 carries no `field`, and a host reads `field` as optional on every code.

- The document is written under `docs/protocol/` as a JSON Schema and three example documents
  (one per question type), plus one error example. A test asserts the examples validate and that a recorded API response
  from the documentation renders to exactly the committed example. Hosts may pin the examples
  byte for byte. A field is added with a schema change and an example change in the same commit;
  a field is never renamed or removed while `protocol` is 1.

## 8. The log

`$JEVELRY_HOME/log.jsonl`, append-only, one JSON object per line, two kinds:

```json
{"kind":"ask","id":"…","at":"2026-09-22T10:00:00Z","jevel":{"name":"wake-gate","version":1},"model":"jev-1.13.0","state_hash":"sha256:…","answers":{…},"usage":{…},"cwd":"/path/the/host/ran/in"}
{"kind":"outcome","id":"…","question":"worth_a_turn","outcome":"agree","value":null,"note":null,"at":"2026-09-22T10:07:00Z"}
```

- The state itself is not logged, only its hash: the state is the host's data and can be large.
  The answers, which are small and are the thing to measure, are.
- `--no-log` skips the ask line; then `outcome` has nothing to attach to and says so.
- The key is never written. Nothing in the log is ever rewritten; `report` is a fold.
- No rotation in this version. The line is a few hundred bytes and an office asking every
  minute writes under a megabyte a day; rotation is added when a report gets slow, and the
  file's name is fixed so a rotator has one target.

## 9. Budgets

Before any call the runtime estimates tokens as `ceil(bytes(UTF-8) / 3)`, deliberately
pessimistic against the documented 64k total and 32k state-plus-longest-question limits, and
against the jevel's own `budget_tokens`. Over any of them is exit 5 with the estimate, the
ceiling and which limit. The real figure comes back in `usage` and is logged; a host can tune its
filtering against it. The estimate is a guard against sending noise, not a meter.

## 10. Errors

SDK error classes map to the exit codes in section 6: `AuthenticationError` and a missing key to
4; `RateLimitError` and a `529` to 3, with `retry_after_ms` in the error document when the
server gave one; `APIConnectionError` and `APITimeoutError` to 6; `BadRequestError`
and `UnprocessableEntityError` to 2 (the API's message names the field); anything else to 6. An
answer the runtime cannot map onto its protocol (a type it does not know, a missing field) is
exit 7 with the field named: it is never defaulted.

## 11. Repository layout and packaging

```
jevelry/
  bin/jevelry.js              #!/usr/bin/env node; imports ../dist/cli.js
  src/cli.ts                  the entry: builds the program and parses argv
  src/program.ts              commander program; wires the commands
  src/install.ts              the skill copy into the coding agents, and the key prompt
  src/key.ts                  the key: environment, keychain, `$JEVELRY_HOME/env`
  src/jevel.ts                JEVEL.md discovery, parsing, validation, repeat expansion
  src/ask.ts                  builds the SDK request, calls it, shapes the protocol document
  src/verdict.ts              certainty and verdict, pure
  src/budget.ts               the estimate, pure
  src/log.ts                  append and read the JSONL log
  src/report.ts               the fold over the log, pure over lines
  src/protocol.ts             the TypeScript types of the stdout document
  docs/protocol/              ask.schema.json and the three pinned examples
  docs/superpowers/specs/     this document and its successors
  jevels/                     example jevels shipped with the package (used by the tests)
  skills/jevelry/             SKILL.md and references/ for coding agents, installed by `jevelry install`
  package.json                type: module; bin; engines node >= 20; files: dist, bin, jevels, skills, docs/protocol, LICENSE
  tsup.config.ts              entry src/cli.ts and src/index.ts; esm; node20; dts
  vitest.config.ts
```

Dependencies: `@typesafe-ai/sdk`, `commander`, `yaml`. Dev: `typescript`, `tsup`, `vitest`,
`@types/node`. `src/index.ts` exports `loadJevel`, `ask`, `verdictOf`, `estimateTokens` for a
host that prefers in-process use; the CLI is the contract, the library is a convenience.

Scripts: `build` (tsup), `test` (vitest run, after build), `lint` (tsc --noEmit),
`prepublishOnly` (build). Published to npm as `jevelry`; `npx jevelry` works without an install.

## 12. Testing

- Unit: `verdict.ts`, `budget.ts`, `report.ts`, `jevel.ts` (parsing, every refusal and warning in
  4.3, repeat expansion) are pure and tested directly.
- SDK seam: `ask.ts` is tested with a `fetch` passed to `TypeSafeClient` that answers recorded
  response bodies taken from the API documentation, one per question type, plus `401`, `422`,
  `429` with `Retry-After`, `529`, and a body with an unknown answer type. Every exit code in
  section 6 has a test that reaches it.
- CLI: one end-to-end test spawns `bin/jevelry.js` against a `node:http` server started by the
  test and reached through `TYPESAFE_BASE_URL`, with a key in the environment and
  `JEVELRY_HOME` in a temporary directory: `check`, `ask`, `outcome`, `report` in sequence, and
  the stdout document validated against `docs/protocol/ask.schema.json`.
- Protocol pin: the three examples under `docs/protocol/` are produced by the code from the
  recorded responses and compared byte for byte.
- `npm test` never reaches the real API. There is no fake mode in the product; the seam is the
  SDK's own `fetch` option and the base URL.
- Live: `npm run test:live` is the one suite that reaches TypeSafe, on demand, with
  `TYPESAFE_API_KEY` in the environment. The operator's own command line supplies it, from a
  keychain for example; the suite reads only the environment variable, holds no credential store of
  its own, and never prints the key. It lists the models, asks the reference noul and the shipped
  `wake-gate` jevel, validates the documents against the schema, asserts bounds rather than exact
  probabilities (an alias moves), and checks the log never holds the key. Without a key it skips
  itself with one stderr sentence. It is the acceptance run, and the answer to "the recorded bodies
  are claims about the API, not the API".

## 13. Non-goals

No text generation and no chaining of choices to imitate it. No composition language in the
jevel (weights, boolean gates, routing tables): hosts write that in code. No cache of answers
(the host decides what an identical `state_hash` means to it). No daemon, no MCP server, no
browser build. No per-account tuning of the model, which the API does not offer. No rotation of
the log in this version. No interactive question-authoring surface yet; `check` and `show` are
the authoring loop for now.

## 14. Acceptance

- `npx jevelry check wake-gate` on the shipped example refuses each of the 4.3 defects when they
  are introduced and warns on each listed smell.
- `npx jevelry ask wake-gate --state @state.json` with a valid key prints one protocol document,
  exit 0, with a verdict on every question, and appends one line to the log.
- Over-budget state exits 5 before any request is made (the test server sees no request).
- `429` and `529` from the test server exit 3 after the SDK's retries with `retry_after_ms`
  reported; `401` exits 4; a missing key exits 4 without a request.
- `outcome` then `report` shows agreement for the question, and `report --json` is readable by a
  program.
- A jevel with `repeat` over a five-element array sends five questions in one request and returns
  five answers named `<question>[i]`.
- The protocol examples under `docs/protocol/` are byte-identical to what the code produces.
- The key never appears in the log, in stdout, or in any error text.

## 15. What the first consumer needs from this

Agent Office spawns `jevelry ask <jevel> --state -` with the state on stdin, the office's own
jevels directory in `JEVELRY_JEVELS`, and `TYPESAFE_API_KEY` passed through from the daemon's
environment. It maps exit 3 to its provider `paused` (until `retry_after_ms`), exit 4 to
`closed`, exits 2, 5, 6 and 7 to a recorded fallback; reads `model`, `usage.input_tokens`,
`state_hash` and every verdict into its own record; and pins `docs/protocol/` examples in its
conformance tests. Nothing in the office reads the log; the office's record is its own.

---

*Owner-flagged defaults to confirm or amend: license (MIT proposed; backant-memory ships
Elastic-2.0, agentic-engineering-101 ships MIT); runtime default thresholds (`act 0.9`,
`mark 0.7`); the log's location (`~/.jevelry/log.jsonl`); the token estimate divisor (3).*
