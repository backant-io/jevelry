---
name: log-triage
version: 2
model: jev-1.13.0
state:
  required: [lines]
  budget_tokens: 10000
questions:
  kind:
    type: choice
    instructions:
      question: "What do the log lines in `lines` describe?"
      inspect: "every line in `lines`, and `service` when the state carries it"
      focus: "Read the lines for the part that failed and for what the software was told to do. The loudest line decides the kind."
    criteria:
      outage:
        what: "A service or a dependency is unreachable, and the requests to it in these lines fail across the board"
        not_for: "A setting the software was handed wrongly, which belongs to misconfiguration, or failures on some requests while others go through, which belongs to bug"
        examples:
          - "dial tcp 10.0.3.9:5432: connect: connection refused"
          - "upstream returned 503 for every request in the window"
          - "the payment provider is unreachable and each attempt times out"
      misconfiguration:
        what: "A setting, a path, a credential or a limit is wrong, and the software is doing exactly what it was told to do"
        not_for: "Code that hit a case it handles wrongly, which belongs to bug, or a dependency that is unreachable, which belongs to outage"
        examples:
          - "open /etc/resizer/profiles.yaml: no such file or directory"
          - "unknown region eu-centarl-1"
          - "permission denied for user reporting"
      bug:
        what: "The code hit a case it handles wrongly: an unhandled exception, a stack trace, or a value that makes sense nowhere"
        not_for: "A warning that repeats in normal operation, which belongs to noise, or a dependency that is unreachable, which belongs to outage"
        examples:
          - "panic: runtime error: index out of range [4] with length 3"
          - "NullPointerException at OrderMapper.map(OrderMapper.java:88)"
          - "wrote -1 rows to the ledger"
      noise:
        what: "Routine lines, retries that succeeded, or a known warning that repeats while the work goes through"
        not_for: "An unhandled exception or a stack trace, which belongs to bug"
        examples:
          - "retry 1 succeeded after 210ms"
          - "deprecated field client_id used, see the migration guide"
          - "GET /health 200"
      unclear:
        what: "The lines say too little to place them in the four above"
        not_for: "Lines that name an unreachable dependency, a wrong setting, an exception or a routine warning, each of which belongs to one of the four above"
        examples:
          - "task 41 finished with status 3"
          - "closing"
    verdict: { act: 0.8, mark: 0.6 }
  needs_a_person:
    type: noul
    instructions:
      question: "Do the lines in `lines` call for somebody to look at them today?"
      inspect: "every line in `lines`, and the last lines of the burst in particular"
      focus: "What decides this is whether work is still failing where the burst ends, or whether the lines get worse as they go."
    criteria:
      true:
        what: "Requests, jobs or data are still failing in the last lines of the burst, or the lines report a condition that grows worse line by line"
        examples:
          - "the last lines are still rejecting requests with a 400"
          - "each line reports more dropped jobs than the line before it"
          - "the burst ends with the process exiting"
      false:
        what: "The lines are routine, or a failure in them has recovered by the last line"
        examples:
          - "retry succeeded, and the lines after it are 200s"
          - "INFO lines about a job that finished"
    verdict: { act: 0.85, mark: 0.7 }
  severity:
    type: score
    instructions:
      question: "Which of these situations do `lines` read like?"
      inspect: "every line in `lines`"
      focus: "Judge how much of the work in these lines is getting through. How alarming the wording is stays out of this."
    criteria:
      - what: "The lines are informational and the requests and jobs in them succeeded"
        signals:
          - "INFO lines and 200 responses"
          - "a retry that succeeded on the next attempt"
          - "a nightly job that finished and reported its rows"
      - what: "Part of the work in the lines is failing and the service is still doing the rest: one kind of request, one profile or one dependency fails while the other work goes through"
        signals:
          - "ERROR on some requests and 200 on others"
          - "requests for one profile rejected with a 400 while the service serves the other profiles"
          - "one dependency failing and the rest of the work going through"
      - what: "The work stopped for everybody: every request in the lines is failing, or the process is gone, so nothing is getting through"
        signals:
          - "connection refused on every attempt"
          - "the process exited and the next lines are restart attempts"
          - "503 on every response in the burst"
    verdict: { act: 0.75, mark: 0.55 }
---
# log-triage

## When to use

On a burst of log lines your monitoring collected, to tell an outage from a misconfiguration, a bug or noise before a person reads them.

## State

`lines`: an array of log lines as strings, the burst your code grouped, in the order they were written and twenty at most, because a long burst costs accuracy on every question. `service` is an optional top-level key naming the service the lines come from; send it when you have it and the `kind` answer gets sharper.

## Verdicts

`kind` with `act`: file the burst under that kind and route it, outages to the on-call and misconfigurations to the owning team. `mark`: file it and show the kind as a guess. `fall_back`: file the burst for a person to read.
`needs_a_person` yes with `act`: raise it today. `severity` at level 2 with `act`: page the on-call.

## Example

The example state holds five lines from `image-resizer` about a profile file that is missing, the requests it rejects, and one request for another profile that goes through. It answers `kind` = `misconfiguration`, `needs_a_person` yes and `severity` at level 1.
