---
name: jevelry
description: Use when the code you are working on needs a judgment call about text or data (route this, is this urgent, is this a duplicate, how severe is this) and you would otherwise ask an LLM to return JSON. jevelry asks Jev, TypeSafe's decision model, through a jevel file and hands your code a verdict.
---

# jevelry

You are probably about to write a prompt that asks a chat model to return JSON so the code can branch on it. With jevelry you write a jevel instead, a small file with typed questions, and the code branches on a verdict. This skill tells you how to install it, how to write a jevel, and how to wire the answer into the code you are working on.

## Install

Run this in the project:

    npx jevelry install

It puts this skill into every coding agent it finds on the machine and asks for the TypeSafe key, which you can skip with Enter. When the person already has the key in their keychain or in `TYPESAFE_API_KEY`, you are done. If you only need the skill, `npx jevelry install-skill` does that part alone.

## When to reach for it

Use a jevel when the code needs one of these and the input is text or a record:

- route something to one of a fixed set of destinations (a team, a template, a handler)
- rate something on a scale you define (urgency, severity, frustration, risk)
- check whether a statement is true of a document or a message (is this a refund request, does this bug report have steps)
- decide the same thing for every item in a list (which open issues duplicate this one)

Keep arithmetic, counting, date comparison and anything a regex can find in the code. Jev answers questions about meaning.

## Commands

| Command | What it does |
|---|---|
| `npx jevelry install` | installs this skill into every agent found, then asks for the key (skippable) |
| `npx jevelry install-skill [--project]` | installs the skill only |
| `npx jevelry list` | the jevels jevelry can find |
| `npx jevelry show <jevel>` | the resolved frontmatter and the body |
| `npx jevelry check <jevel>` | refuses a jevel the API would refuse and warns about questions Jev handles poorly |
| `npx jevelry ask <jevel> --state @file` | asks every question in the jevel about the state, prints one JSON document |
| `npx jevelry ask --questions '<json>' --state '<json>'` | a one-off ask with the API's question shape |
| `npx jevelry outcome <log_id> <question> <value>` | records what proved true (`agree`, `disagree`, an option, a level index, `yes`, `no`) |
| `npx jevelry report [--jevel <name>] [--json]` | agreement per question from the log |
| `npx jevelry models` | the model names the account may send |

Jevels are found in `--jevels <dir>`, then `JEVELRY_JEVELS` (colon separated), then `./jevels`, then `~/.jevelry/jevels`. Keep the project's jevels in `./jevels/` so a person reviews them with the code.

## Write a jevel

Read `references/writing-jevels.md` before you write one; it is the whole method. The short version: copy a shipped jevel (`npx jevelry show ticket-triage`), the catalogue is `jevels/README.md`, pick the question type from the shape of the decision (`choice` for one of a set, `score` for a level, `noul` for yes or no), write the exact condition and point it at the state with a backticked path, put the boundary cases and an `other` option in the criteria, name the state keys in `state.required`, set `act` and `mark` by what a wrong answer costs, and run `check` until it prints 0 warnings.

## Wire the answer in

`ask` prints exactly one JSON document on stdout:

    {
      "protocol": 1,
      "log_id": "...",
      "jevel": { "name": "ticket-triage", "version": 1 },
      "model": "jev-1.13.0",
      "state_hash": "sha256:...",
      "answers": {
        "team": { "type": "choice", "choice": "billing", "probabilities": { "billing": 0.9, "technical": 0.06, "account": 0.03, "other": 0.01 }, "confidence": 0.87, "certainty": 0.87, "verdict": "act" },
        "urgent": { "type": "noul", "noul": 0.93, "yes": true, "certainty": 0.93, "verdict": "act" }
      },
      "usage": { "input_tokens": 300, "output_tokens": 30 }
    }

The values above are illustrative. The code reads `verdict` per answer and branches: `act` means use the answer, `mark` means use it and flag the case for a person, `fall_back` means do what the code did before the jevel existed. The raw probabilities are there when the code needs its own rule. Answers for a `repeat` question are named `same_as[0]`, `same_as[1]` and so on.

On failure the document is `{ "protocol": 1, "error": { "exit": 3, "code": "rate_limited", "message": "...", "retry_after_ms": 1200 } }` and the exit code says what happened: 2 the jevel or state is wrong (the document names the field), 3 rate limited or overloaded, 4 the key is missing or refused, 5 over the token budget, 6 network, 7 an answer this build cannot read. 4 and 5 make no request. Branch on the exit code, show the message to a person.

From TypeScript or JavaScript the same functions are importable: `import { ask, loadJevel, discoveryDirs } from "jevelry"`. Every other language spawns the CLI and parses stdout.

## Rules

- Keep the key out of your output, your logs and every commit. The SDK reads `TYPESAFE_API_KEY`, and jevelry also looks in the keychain and in `~/.jevelry/env`.
- Questions and thresholds stay in `./jevels/<name>/JEVEL.md`, in one place, so the person you work with reviews them before they merge. Say in your summary which jevel you wrote and what its thresholds are.
- Run `check` before `ask`, and ask three states (an obvious yes, an obvious no, an unsure one) before you wire a verdict into anything.
- Pin `model` to a concrete version and bump `version` when you change a question.
- Reference: https://docs.typesafe.ai for Jev itself; `references/writing-jevels.md` and `references/protocol.md` in this skill for the file format and the document.
