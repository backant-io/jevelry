<img src="docs/assets/banner.svg" alt="jevelry" width="100%">

<p align="center">
  <a href="#start">Start</a> ·
  <a href="#jevels">Jevels</a> ·
  <a href="#verdicts">Verdicts</a> ·
  <a href="#measure-it">Measure it</a> ·
  <a href="https://docs.typesafe.ai">Jev docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/npm-jevelry-3fb950" alt="npm">
  <img src="https://img.shields.io/badge/node-%3E%3D20-3fb950" alt="Node 20">
  <img src="https://img.shields.io/badge/tests-offline%2C%20live%20on%20demand-3fb950" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

You were probably asking a chat model to "return JSON" so your code could decide something: is this ticket urgent, which team gets it, is this bug report a duplicate of one you already have. Then you parse the text, the parse breaks on a Tuesday, you add a retry, and you still have no idea how sure the model actually was.

You don't have to do that anymore. We have built jevelry, a runtime for Jev, the decision model from TypeSafe. You hand it your state and a jevel, and it hands your code a verdict with the probability and the confidence behind it, so you can branch on it the way you would on any other value.

Think of Jev as a colleague you ask one quick question and who answers with a number, and the jevels are the questions you keep ready for it.

## What is underneath

Jev takes a state (a support ticket, a bug report, the form somebody just filled in) and typed questions, and it answers each one with a calibrated probability. There are three kinds of questions:

| Question | You ask | You get back |
|---|---|---|
| `choice` | which of these options | the option, a probability per option, a confidence |
| `score` | how much, on your own levels | a value between the levels, a probability per level, a confidence |
| `noul` | is this true | one probability, 0 to 1 |

jevelry is everything around that call: it loads your jevel, checks the state before it costs you anything, asks all the questions in one request, turns every answer into a verdict, writes one JSON document to stdout and keeps a log so you can measure the answers later. The official `@typesafe-ai/sdk` underneath reads your key and talks to the API.

## Free

jevelry is free and MIT. TypeSafe charges per input token, 0.042 dollars per million, and output tokens are free. The reference ask in our live test (one question about one sentence) costs 307 input tokens.

## Start simple

Put your key in the environment and ask one of the two jevels that ship with the package:

    export TYPESAFE_API_KEY=...
    npx jevelry ask ticket-triage --state @ticket.json

You get one document back on stdout:

    {
      "protocol": 1,
      "log_id": "becfc166-7921-4fe3-a189-4c2c5b164bce",
      "jevel": {
        "name": "ticket-triage",
        "version": 1
      },
      "model": "jev-1.13.0",
      "state_hash": "sha256:b883d3e23a85340c82fbc76833692e80c5e08f898de8d1d059849d5e29ad418b",
      "answers": {
        "team": {
          "type": "choice",
          "choice": "billing",
          "probabilities": {
            "account": 0,
            "technical": 0,
            "billing": 1,
            "other": 0
          },
          "confidence": 1,
          "certainty": 1,
          "verdict": "act"
        },
        "urgent": {
          "type": "noul",
          "noul": 0.98,
          "yes": true,
          "certainty": 0.98,
          "verdict": "act"
        },
        "frustration": {
          "type": "score",
          "score": 0.73,
          "legend": {
            "0": "calm: neutral or friendly wording",
            "1": "frustrated: annoyed, repeats the problem, mentions earlier attempts",
            "2": "very angry: threatens to leave, insults, or writes in capitals"
          },
          "probabilities": {
            "0": 0.27,
            "1": 0.73,
            "2": 0
          },
          "confidence": 0.59,
          "certainty": 0.59,
          "verdict": "mark"
        }
      },
      "usage": {
        "input_tokens": 588,
        "output_tokens": 77
      }
    }

This is the answer from our live test. Your code reads `verdict` and decides what to do, and the probabilities are in the document if you want to apply your own rule.

## Jevels

A jevel is a folder with one `JEVEL.md` in it, the same way a skill for your coding agent is a folder with one `SKILL.md`. The frontmatter is what jevelry reads, the body is what you and your agents read:

```yaml
---
name: ticket-triage
version: 1
model: jev-1.13.0
state:
  required: [ticket]
questions:
  team:
    type: choice
    instructions: "Which team should handle `ticket`?"
    criteria:
      billing: "Payments, invoices, refunds, subscription changes."
      technical: "Bugs, outages, error messages, integrations, data that looks wrong."
      account: "Login, password, permissions, closing or changing an account."
      other: "Anything the three teams above do not cover, or a message with no request in it."
    verdict: { act: 0.8, mark: 0.6 }
---
```

Adding a use case is adding a folder. jevelry finds jevels in `--jevels <dir>`, then `JEVELRY_JEVELS`, then `./jevels`, then `~/.jevelry/jevels`, and it checks them before you spend a token:

    npx jevelry check ticket-triage
    npx jevelry list
    npx jevelry show ticket-triage

`check` refuses a jevel the API would refuse anyway (more than 255 options, a threshold outside 0 to 1, a question without instructions) and warns you about the cases Jev handles poorly: a yes/no question whose "yes" means no, a double negative, a model that is not pinned. Two jevels ship with the package, `ticket-triage` for a support queue and `duplicate-issue` for a bug tracker, so you have something to copy.

## Verdicts

Every answer comes back with a `verdict`, and that is the part your code uses:

| Verdict | Meaning | What your code usually does |
|---|---|---|
| `act` | Jev is sure enough, by the thresholds you set in the jevel | act on the answer |
| `mark` | a reasonable answer with less confidence behind it | act and flag it for a person |
| `fall_back` | not sure | do what you did before jevelry existed |

The thresholds live in the jevel, per question, so a question that skips an expensive step needs a higher bar than a question that only sorts a list. A yes/no question uses how far the probability is from 0.5, a choice or score uses the confidence Jev reports. If you want a different rule, the raw probabilities are in the document as well.

## Measure it

Every ask is appended to `~/.jevelry/log.jsonl` with its answers, its verdicts and a hash of the state. When you later know what was actually true, you tell jevelry, and it tells you how often each question was right:

    npx jevelry outcome becfc166-7921-4fe3-a189-4c2c5b164bce urgent yes
    npx jevelry report --jevel ticket-triage

    jevel          question     asks  act  mark  fall_back  outcomes  agree(act)  agree(mark)  certainty
    ticket-triage  frustration  1     0    1     0          0         -           -            0.59
    ticket-triage  team         1     1    0     0          0         -           -            1.00
    ticket-triage  urgent       1     1    0     0          1         100%        -            0.98

After a few hundred asks that table shows you which thresholds to move and which question to rewrite. For a question that repeats over a list, the answer key carries the index, so you write `same_as[0]`.

## When it fails

`ask` prints one JSON document on stdout in every case. On failure it is an error document and the exit code says what happened, so your code branches on the code and reads the message for a person:

| Exit | Meaning |
|---|---|
| 0 | answered |
| 1 | a usage error or something no other code covers |
| 2 | the jevel or the state is wrong, and the document names the field |
| 3 | rate limited or overloaded, with `retry_after_ms` when TypeSafe gave one |
| 4 | the key is missing or refused, no request was made |
| 5 | over the token budget, no request was made |
| 6 | the network or TypeSafe's servers |
| 7 | TypeSafe answered a shape this build cannot read |

Currently jevelry asks Jev questions and hands you the answers, and that is the whole of it - this is intentional because Jev is built to answer, and in our own experience a small tool that does one thing is the one you can put in front of your own code and forget about. We are working on an authoring loop so you can try questions against a pasted state before you write the jevel.

## How do we know you can trust it

111 tests run offline against recorded answers from TypeSafe's API reference. 4 tests run against the real API on demand with `npm run test:live`, and the last run answered with `jev-1.13.0` in 3.49 seconds for four calls. One of those tests reads the log afterwards and checks that your key stays out of it.

## Use it from code

You can also import it and stay in process:

```ts
import { ask, loadJevel, discoveryDirs } from "jevelry";
```

## Environment

| Variable | What it does | Default |
|---|---|---|
| `TYPESAFE_API_KEY` | your key, read by the SDK | required |
| `TYPESAFE_BASE_URL` | the API root, read by the SDK | `https://api.typesafe.ai` |
| `JEVELRY_MODEL` | the model when a jevel pins none | the SDK default, `jev-latest` |
| `JEVELRY_HOME` | where the log lives | `~/.jevelry` |
| `JEVELRY_JEVELS` | more jevel folders, colon separated | none |
| `JEVELRY_TIMEOUT_MS` | per attempt | `30000` |

## Start

    npm install -g jevelry
    export TYPESAFE_API_KEY=...
    jevelry check ticket-triage
    jevelry ask ticket-triage --state @ticket.json

Get a key and read about Jev at https://docs.typesafe.ai.
