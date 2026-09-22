# Examples

The README shows you the part of an answer your code reads. This page shows you the whole document and the commands around it, on two of the jevels that ship with the package, with the numbers from our live run.

## The whole document

    npx jevelry ask ticket-triage --state @ticket.json

`ticket.json`:

    {
      "ticket": {
        "subject": "Charged twice",
        "message": "I was charged twice for order A-104 and I need this fixed today, my accountant is waiting.",
        "customer_since": "2024-03"
      }
    }

What comes back on stdout, exactly as printed:

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

Every answer carries the raw probabilities Jev returned, the `certainty` jevelry computed from them (the confidence for a choice or a score, the distance from 0.5 for a noul) and the `verdict` from the jevel's thresholds. `state_hash` is the hash of the state you sent, so you can tell later which state an answer belongs to. `log_id` is the line in `~/.jevelry/log.jsonl` you point `outcome` at.

## Reading it from your code

In a shell, `jq` gets you the verdicts:

    npx jevelry ask ticket-triage --state @ticket.json | jq '.answers | map_values(.verdict)'

In TypeScript you can skip the CLI:

    import { ask, loadJevel, discoveryDirs } from "jevelry";
    import { TypeSafeClient } from "@typesafe-ai/sdk";

    const { jevel } = loadJevel("ticket-triage", discoveryDirs({ cwd: process.cwd(), home: process.env.HOME ?? "" }));
    const result = await ask({ client: new TypeSafeClient(), state, jevel });
    if (result.ok && result.document.answers.team?.verdict === "act") {
      route(result.document.answers.team.choice);
    }

## A question over a list

    npx jevelry ask duplicate-issue --state @issue.json

`issue.json` holds the new issue and the open ones your code preselected:

    {
      "issue": { "title": "Export button does nothing on Safari", "body": "Clicking Export on the reports page does nothing in Safari 17. Chrome works. Expected a CSV download." },
      "candidates": [
        { "title": "Export fails in Safari 17", "body": "The CSV export silently fails on Safari 17.2, works on Chrome." },
        { "title": "Dark mode colours wrong on the settings page", "body": "Labels are unreadable in dark mode." }
      ]
    }

The answers come back as `same_as[0]` and `same_as[1]`, one per candidate, plus `actionable` for the issue itself:

    {
      "protocol": 1,
      "log_id": "11be7d18-f67b-4bb6-9ecc-bd49a0fd3854",
      "jevel": {
        "name": "duplicate-issue",
        "version": 1
      },
      "model": "jev-1.13.0",
      "state_hash": "sha256:519db415584243fda76eed700f344001ee400a3b4386aeb2916b484b62c2c4df",
      "answers": {
        "same_as[0]": {
          "type": "noul",
          "noul": 0.97,
          "yes": true,
          "certainty": 0.97,
          "verdict": "act"
        },
        "same_as[1]": {
          "type": "noul",
          "noul": 0.01,
          "yes": false,
          "certainty": 0.99,
          "verdict": "act"
        },
        "actionable": {
          "type": "noul",
          "noul": 0.95,
          "yes": true,
          "certainty": 0.95,
          "verdict": "act"
        }
      },
      "usage": {
        "input_tokens": 610,
        "output_tokens": 64
      }
    }

## Telling jevelry what was true

When the ticket above turns out to be urgent after all, or when it does not, you record it against the `log_id` and the question, and the report shows you how the question is doing:

    npx jevelry outcome <log_id> urgent yes
    npx jevelry report --jevel ticket-triage

    jevel          question     asks  act  mark  fall_back  outcomes  agree(act)  agree(mark)  certainty
    ticket-triage  frustration  1     0    1     0          0         -           -            0.59
    ticket-triage  team         1     1    0     0          0         -           -            1.00
    ticket-triage  urgent       1     1    0     0          1         100%        -            0.98

`agree(act)` is the share of `act` verdicts that matched reality, and that is the number you move a threshold by. A question that agrees 95% of the time at `act: 0.85` can probably come down; one that agrees 70% of the time goes up or gets rewritten.

## When it fails

A failure is one JSON document too, so the same parser handles it:

    {
      "protocol": 1,
      "error": {
        "exit": 3,
        "code": "rate_limited",
        "message": "TypeSafe answered 429 after the SDK's retries",
        "retry_after_ms": 1200
      }
    }

The exit code says what happened (2 the jevel or the state, 3 rate limited or overloaded, 4 the key, 5 the budget, 6 the network, 7 an answer this build cannot read), the document names the field when jevelry knows it, and `retry_after_ms` is there when TypeSafe said how long to wait.
