# jevelry

> jevelry asks Jev, the decision model from TypeSafe (System One), small typed questions about text or data with one command. Your code or your coding agent gets back a decision, `act`, `mark` or `fall_back`, together with how sure Jev was.

## Install

    npx jevelry install

This installs the jevelry skill into every coding agent it finds and asks for your TypeSafe key, or you set `TYPESAFE_API_KEY` in the environment.

## Ask

    npx jevelry ask ticket-triage --state @ticket.json

The state is a JSON file with the keys the jevel names, and the answer is one JSON document on stdout with an answer per question.

## Decisions

- `act`: Jev is sure, so go ahead with the answer.
- `mark`: Jev is fairly sure, so go ahead and flag it for a person to look at.
- `fall_back`: Jev is unsure, so do what you did before, or look closer yourself.

## Links

- [The sixteen jevels that ship with the package](https://github.com/backant-io/jevelry/blob/main/jevels/README.md): triage, urgency, duplicates, severity, risky changes, failing test causes and more, each with an `example.json` and a `cases.json`.
- [The guide to writing your own jevel](https://github.com/backant-io/jevelry/blob/main/skills/jevelry/references/writing-jevels.md): questions, criteria, state, decisions and the cases that prove it.
