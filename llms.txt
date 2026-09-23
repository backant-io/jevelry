# jevelry

> jevelry asks Jev, the decision model from TypeSafe (System One), small typed questions about text or data with one command. Your code or your coding agent gets back a decision, `act`, `mark` or `fall_back`, together with how sure Jev was.

## Install

    npx jevelry install

This installs the jevelry skill into every coding agent it finds and asks for your TypeSafe key, or you set `TYPESAFE_API_KEY` in the environment. jevelry runs on Node 22 or newer.

## Ask

    npx jevelry ask ticket-triage --state @ticket.json

The state is a JSON file with the keys the jevel names, and the answer is one JSON document on stdout with an answer per question.

## In your program

When the decision happens inside your own code, install jevelry in the project, load the jevel once when the program starts and call `decide` where the code decides:

    npm install jevelry

```ts
import { jevel } from "jevelry";

const triage = jevel("ticket-triage");

const d = await triage.decide({ ticket });
switch (d.team?.decision) {
  case "act": route(ticket, d.team.answer); break;
  case "mark": route(ticket, d.team.answer); flagForQueueOwner(ticket); break;
  case "fall_back": leaveInGeneralQueue(ticket); break;
}
```

When Jev cannot answer, every question comes back `fall_back` with the reason in `d.error`, so the code keeps its old path. `npx jevelry types --out src/jevels.d.ts` writes the types, so `d.team.answer` is typed as the options of the jevel.

## Decisions

- `act`: Jev is sure, so go ahead with the answer.
- `mark`: Jev is fairly sure, so go ahead and flag it for a person to look at.
- `fall_back`: Jev is unsure, so do what you did before, or look closer yourself.

`npx jevelry tui` opens a full-screen view of your decisions: Home shows how Jev decided today, Review lets a person press `c` (correct) or `w` (wrong) on each `mark`, and Try asks a jevel live with its example state.

`npx jevelry run <jevel> --state @file` asks a jevel whose options name commands, like `failing-test`, and runs the one Jev picks: `act` runs it, `mark` asks you first and `fall_back` runs the jevel's `fall_back` command.

## Links

- [The seventeen jevels that ship with the package](https://github.com/backant-io/jevelry/blob/main/jevels/README.md): triage, urgency, duplicates, severity, risky changes, failing test causes and more, each with an `example.json` and a `cases.json`.
- [The guide to writing your own jevel](https://github.com/backant-io/jevelry/blob/main/skills/jevelry/references/writing-jevels.md): questions, criteria, state, decisions and the cases that prove it.
