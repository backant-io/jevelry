# jevlery

A runtime for Jev, TypeSafe's System One model (https://docs.typesafe.ai). Jev takes a state and typed questions and answers with calibrated probabilities; it never generates text. jevlery is what sits around it: jevels (question packs, like skills), verdicts your code can branch on, budgets, retries, and a local log with outcomes so you can measure every question against what later proved true.

## Install

    npm install -g jevlery        # or: npx jevlery ...
    export TYPESAFE_API_KEY=...   # jevlery never reads the key itself; the official SDK does

Node 20 or newer.

## Use

    jevlery check wake-gate
    jevlery ask wake-gate --state @state.json
    jevlery ask wake-gate --state - < state.json
    jevlery ask --questions '{"urgent":{"type":"noul","instructions":"Is it urgent?"}}' --state '"Help!"'
    jevlery outcome <log_id> worth_a_turn no
    jevlery report --jevel wake-gate
    jevlery list | show <jevel> | models

`ask` prints one JSON document on stdout (`docs/protocol/ask.schema.json`): every answer carries the API's raw probabilities plus `certainty` and a `verdict` of `act`, `mark` or `fall_back` from the jevel's thresholds. On failure it prints an error document and exits 2 (bad jevel or state), 3 (rate limited or overloaded, with `retry_after_ms`), 4 (auth), 5 (over budget), 6 (transport) or 7 (an answer this build cannot read).

## Jevels

A jevel is a directory with one `JEVEL.md`: YAML frontmatter the runtime reads, a Markdown body people read. See `jevels/wake-gate/JEVEL.md` and the design (https://github.com/backant-io/jevlery/blob/main/docs/superpowers/specs/2026-09-22-jevlery-design.md). Jevels are found in `--jevels <dir>`, `JEVLERY_JEVELS` (colon-separated), `./jevels`, then `$JEVLERY_HOME/jevels`.

## Environment

`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (SDK); `JEVLERY_MODEL` (default model when the jevel pins none), `JEVLERY_HOME` (default `~/.jevlery`), `JEVLERY_JEVELS`, `JEVLERY_TIMEOUT_MS` (default 30000).

## License

MIT
