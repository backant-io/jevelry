---
name: log-triage
version: 1
model: jev-1.13.0
state:
  required: [lines]
  budget_tokens: 10000
questions:
  kind:
    type: choice
    instructions: "What do the log lines in `lines` describe?"
    criteria:
      outage: "A service or a dependency is unreachable, and requests to it are failing across the board."
      misconfiguration: "A setting, a path, a credential or a limit is wrong, and the software is doing what it was told."
      bug: "The code hit a case it handles wrongly, such as an unhandled exception or a value that makes sense nowhere."
      noise: "Routine lines, retries that succeeded, or warnings that repeat in normal operation."
      unclear: "The lines say too little to place them in the four above."
    verdict: { act: 0.8, mark: 0.6 }
  needs_a_person:
    type: noul
    instructions: "Do the log lines in `lines` call for somebody to look at them today?"
    criteria:
      true: "Requests, jobs or data are still failing at the end of the burst, or the condition grows worse until somebody steps in."
      false: "The lines are routine, or they show a failure that has already recovered by the end of the burst."
    verdict: { act: 0.85, mark: 0.7 }
  severity:
    type: score
    instructions: "How bad is what `lines` shows?"
    criteria:
      - "info: normal operation, or a failure that recovered on its own"
      - "degraded: part of the work is failing or is slow, and the rest goes through"
      - "down: the work stopped for everyone"
    verdict: { act: 0.75, mark: 0.55 }
---
# log-triage

## When to use

On a burst of log lines your monitoring collected, to tell an outage from a misconfiguration, a bug or noise before a person reads them.

## State

`lines`: an array of log lines as strings, the burst your code grouped, in the order they were written and a few dozen at most. `service` is an optional top-level key naming the service the lines come from; send it when you have it and the `kind` answer gets sharper.

## Verdicts

`kind` with `act`: file the burst under that kind and route it, outages to the on-call and misconfigurations to the owning team. `mark`: file it and show the kind as a guess. `fall_back`: file the burst for a person to read.
`needs_a_person` yes with `act`: raise it today. `severity` at level 2 with `act`: page the on-call.

## Example

The example state holds four lines from `image-resizer` about a profile file that is missing and the requests it rejects. It answers `kind` = `misconfiguration`, `needs_a_person` yes and `severity` at level 1.
