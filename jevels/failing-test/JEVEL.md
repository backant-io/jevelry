---
name: failing-test
version: 1
model: jev-1.13.0
state:
  required: [test]
  budget_tokens: 8000
questions:
  cause:
    type: choice
    instructions:
      question: "What made the test in `test` fail: the code, the machine it ran on, or bad luck with timing?"
      inspect: "`test.output` for the error, `test.change` for what the commit touched, `test.history` for how the test behaved before"
      focus: "Decide from what the output and the history say. A failure the history calls rare or random is timing; a failure that started with a commit touching the code under test is the code; a denied connection, a missing tool or a full disk is the machine."
    criteria:
      defect:
        what: "The code under test is wrong: an assertion shows a wrong value or a thrown error, and the test passed before a change to that code"
        not_for: "A test that fails now and then with the same code, which belongs to flaky, or one the machine stopped, which belongs to environment"
        examples:
          - "expected 3 rows, got 2, right after the change to the filter"
          - "TypeError: cannot read properties of undefined, the commit renamed that field"
          - "passed on every run until this commit"
      environment:
        what: "The machine, the sandbox or the CI stopped the test: a denied connection or permission, a missing tool, a full disk, a service that is down"
        not_for: "A test that fails now and then on the same machine with a timeout, which belongs to flaky"
        examples:
          - "connect EPERM 104.18.2.1:443, the sandbox denied the network call"
          - "ENOSPC: no space left on device"
          - "psql: command not found"
      flaky:
        what: "The test fails now and then with the same code, from timing, ordering or a race, and passes when you run it again"
        not_for: "A test that started failing with a commit that touched the code under test, which belongs to defect"
        examples:
          - "timed out waiting for the button, passes on a rerun"
          - "fails about once a week, nobody changed the code"
          - "only fails when the tests run in parallel"
      other:
        what: "The output and the history are too thin or too mixed to say which of the three it is"
        not_for: "A failure with a clear assertion, a clear machine error or a clear history, each of which belongs to one of the three above"
        examples:
          - "Error: something went wrong"
          - "exit code 1, no other output"
    thresholds: { act: 0.9, mark: 0.7 }
    run:
      defect: "echo \"the code is wrong, fix it before you rerun the test\""
      environment: "echo \"the machine stopped the test, report it to whoever owns the CI\""
      flaky: "echo \"rerun with {{retries}} retries\""
  retries:
    type: choice
    instructions:
      question: "How often has the test in `test` failed before, going by `test.history`?"
      inspect: "`test.history`"
      focus: "Read only what the history says about earlier runs. The more often it failed before, the more reruns it needs to pass once."
    criteria:
      "1":
        what: "The history shows the test failing rarely or never before, so one rerun is enough"
        not_for: "A test the history says fails now and then, which belongs to 2"
        examples:
          - "passed on every run for the last month"
          - "first failure in months"
          - "passed on every run until this commit"
      "2":
        what: "The history shows the test failing now and then, around once a week or once in a few dozen runs"
        not_for: "A test the history says fails in a large share of runs, which belongs to 3"
        examples:
          - "fails about once a week and passes on a rerun"
          - "failed twice this month"
      "3":
        what: "The history shows the test failing often, in a large share of recent runs"
        not_for: "A test the history says fails only now and then, which belongs to 2"
        examples:
          - "fails in about a third of the runs this week"
          - "red most mornings, green after a rerun"
    thresholds: { act: 0.8, mark: 0.6 }
fall_back: "echo \"Jev is unsure, read the failing output yourself\""
---
# failing-test

## When to use

When a test fails in CI or on your machine and you want the next step to happen on its own: rerun a flaky test, send a machine failure to whoever owns the CI, or stop and fix the code. Ask it with `jevelry run failing-test`, which runs the command of the cause Jev picks.

## State

`test`: `{ "name": "...", "output": "...", "change": "...", "history": "..." }`. `output` is the tail of the failing output, `change` is one line on what the commit touched, and `history` says in words how the test behaved before, like `"fails about once a week"`, which your code works out from the CI runs.

## Decisions

`cause` picks the command, and `retries` is the argument of the `flaky` command, so a `flaky` call is only as sure as the less sure of the two answers. On `act` the command runs, on `mark` `jevelry run` asks you first or runs it with `--yes`, and on `fall_back` the `fall_back` command runs, which here tells you to read the output yourself. The commands only print what they would do, so you replace them with your own, like `npm test -- --retry={{retries}}` for `flaky`.

## Example

The example state holds a checkout test that timed out waiting for a button and that fails about once a week. It answers `cause` = `flaky` and `retries` = `2`, so `jevelry run` prints `rerun with 2 retries`.
