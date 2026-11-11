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
      "protocol": 2,
      "log_id": "fe899f8e-356a-4301-b8ea-292cb341a8f6",
      "jevel": {
        "name": "ticket-triage",
        "version": 3
      },
      "model": "jev-1.13.0",
      "state_hash": "sha256:b883d3e23a85340c82fbc76833692e80c5e08f898de8d1d059849d5e29ad418b",
      "answers": {
        "team": {
          "type": "choice",
          "choice": "billing",
          "probabilities": {
            "other": 0,
            "technical": 0,
            "account": 0,
            "billing": 1
          },
          "confidence": 1,
          "certainty": 1,
          "decision": "act"
        },
        "urgent": {
          "type": "noul",
          "noul": 0.98,
          "yes": true,
          "certainty": 0.98,
          "decision": "act"
        },
        "frustration": {
          "type": "score",
          "score": 0.24,
          "legend": {
            "0": {
              "what": "The customer states the problem in plain or friendly wording, asks politely, and writes in for the first time",
              "signals": [
                "hi, quick question",
                "thanks in advance",
                "could you have a look"
              ]
            },
            "1": {
              "what": "The customer says they have written before, repeats a problem that is still open, or says plainly that they are annoyed",
              "signals": [
                "this is the third time I am writing",
                "still waiting for an answer",
                "I have tried everything you suggested"
              ]
            },
            "2": {
              "what": "The customer threatens to leave or to escalate, insults the team, or writes in capitals",
              "signals": [
                "cancel my account today",
                "your support is a joke",
                "ABSOLUTELY UNACCEPTABLE"
              ]
            }
          },
          "probabilities": {
            "0": 0.78,
            "1": 0.19,
            "2": 0.03
          },
          "confidence": 0.64,
          "certainty": 0.64,
          "decision": "mark"
        }
      },
      "usage": {
        "input_tokens": 1280,
        "output_tokens": 77
      }
    }

Every answer carries the raw probabilities Jev returned, the `certainty` jevelry computed from them (the confidence for a choice or a score, the distance from 0.5 for a noul) and the `decision` from the jevel's thresholds. `state_hash` is the hash of the state you sent, so you can tell later which state an answer belongs to. `log_id` is the line in `~/.jevelry/log.jsonl` you point `outcome` at.

## Reading it from your code

In a shell, `jq` gets you the decisions:

    npx jevelry ask ticket-triage --state @ticket.json | jq '.answers | map_values(.decision)'

In TypeScript you can skip the CLI:

    import { jevel } from "jevelry";

    const triage = jevel("ticket-triage");
    const d = await triage.decide(state);
    if (d.team?.decision === "act") route(d.team.answer);

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
      "protocol": 2,
      "log_id": "6ff713ca-cf4c-40b3-8ee6-2966a1ec0ce3",
      "jevel": {
        "name": "duplicate-issue",
        "version": 3
      },
      "model": "jev-1.13.0",
      "state_hash": "sha256:519db415584243fda76eed700f344001ee400a3b4386aeb2916b484b62c2c4df",
      "answers": {
        "same_as[0]": {
          "type": "noul",
          "noul": 0.98,
          "yes": true,
          "certainty": 0.98,
          "decision": "act"
        },
        "same_as[1]": {
          "type": "noul",
          "noul": 0.01,
          "yes": false,
          "certainty": 0.99,
          "decision": "act"
        },
        "actionable": {
          "type": "noul",
          "noul": 0.96,
          "yes": true,
          "certainty": 0.96,
          "decision": "act"
        }
      },
      "usage": {
        "input_tokens": 1170,
        "output_tokens": 64
      }
    }

## Routing a request to a small or a large model

When a small or local model sits next to a large one, `request-route` reads a request before any model answers it and says whether the small one can take it. Only a sure answer moves a request down:

    import { jevel } from "jevelry";

    const route = jevel("request-route");

    /** "small" only when Jev is sure the request is one step and needs nothing fetched or run. */
    export async function modelFor(prompt: string, tools: string[] = [], context = "first message"): Promise<"small" | "large"> {
      const d = await route.decide({ request: { prompt, context, tools: tools.length > 0 ? tools.join(", ") : "none" } });
      const oneStep = d.complexity?.decision === "act" && d.complexity.answer === 0;
      const selfContained = d.needs_tools?.decision === "act" && d.needs_tools.answer === false;
      return oneStep && selfContained ? "small" : "large";
    }

A `mark`, a `fall_back`, a higher level and a yes all go to the large model. So does a request Jev could not read at all: when TypeSafe is busy or the local model is down, `decide` hands every question back as `fall_back` and does not throw, so the router fails open to the model you would have used anyway. To choose among more than two models, map the levels yourself: level 0 to the cheapest, level 2 to the strongest, and anything below `act` to your default.

With a model on this machine (`npx jevelry install --local d1-2b`) no request leaves it before you have decided where it goes. Measured that way on Liquid d1 2B, on an M4 Pro in Low Power Mode: a decision took 0.8 s at the median and 0.9 s at the 95th percentile, for about 890 input tokens.

How good the decision is was measured on labels jevelry's authors did not write: the 150 reference phrases of bifrost's complexity router, 50 each simple, medium and complex ([`exemplars.go`](https://github.com/maximhq/bifrost/blob/dev/plugins/routing/complexity/exemplars.go), Apache-2.0). Half of them were used to tune the wording of the three levels. The other half was asked once, afterwards, each as a first message with no tools:

| Of the 75 held-back phrases | Liquid d1 2B | vLLM-SR d3-flash 9B, Q4_K_M |
| --- | --- | --- |
| level equal to bifrost's label | 50 (55-76%) | 62 (73-90%) |
| sent to the small model | 15 | 4 |
| of those, simple / medium / complex | 14 / 1 / 0 | 4 / 0 / 0 |
| of the 25 simple phrases, sent to the small model | 14 (37-73%) | 4 (6-35%) |

The brackets are 95% intervals. The thresholds in the jevel were set on Liquid d1 2B. The 9B model reads the levels better and is less sure of itself: its answers at the first level have a median certainty of 0.63, where the 2B model's have 0.85, so at `act: 0.8` it moves little. With the threshold at 0.5 it would have sent 15 of the 25 simple phrases to the small model and nothing else, but that figure is read off the same phrases it is reported on. Set the threshold on the model you run, with `jevelry report` once you have outcomes, as for any jevel. The Jevel screen of `jevelry tui` does it per model: the threshold it proposes for one model goes into the jevel's `tuned` block under that model's name, and the other model keeps the thresholds of the question.

It has not been asked of hosted Jev. `npx jevelry eval request-route` asks its six cases of whichever model you have set up, and the logic above is held by `tests/route-recipe.test.ts`.

## Telling jevelry what was true

When you find out whether the ticket above was really urgent, you record it against the `log_id` and the question, and the report shows you how the question is doing:

    npx jevelry outcome <log_id> urgent yes
    npx jevelry report --jevel ticket-triage

    jevel          question     asks  act  mark  fall_back  outcomes  agree(act)  agree(mark)  certainty  overconfident
    ticket-triage  frustration  1     0    1     0          0         -           -            0.64       -
    ticket-triage  team         1     1    0     0          0         -           -            1.00       -
    ticket-triage  urgent       1     1    0     0          1         100%        -            0.98       -2 pts

`agree(act)` is the share of `act` decisions that matched reality, and that is the number you move a threshold by. `overconfident` is how far the model's certainty ran ahead of how often a person agreed, over the answers that were reviewed: `+20 pts` is a model that was sure 87% of the time and right 67%, and a threshold on it lets through more wrong answers than its number says. A question that agrees 95% of the time at `act: 0.85` can probably come down; one that agrees 70% of the time goes up or gets rewritten.

## When it fails

A failure is one JSON document too, so the same parser handles it:

    {
      "protocol": 2,
      "error": {
        "exit": 3,
        "code": "rate_limited",
        "message": "TypeSafe answered 429 after the SDK's retries",
        "retry_after_ms": 1200
      }
    }

The exit code says what happened (2 the jevel or the state, 3 rate limited or overloaded, 4 the key, 5 the budget, 6 the network, 7 an answer this build cannot read), the document names the field when jevelry knows it, and `retry_after_ms` is there when TypeSafe said how long to wait.
