# Writing jevels

You were probably about to write a prompt that says "answer with JSON" and hope the model sticks to it. With Jev you write a jevel: a small file that says what the state looks like, which questions to ask about it, and how sure the answer has to be before your code acts on it. This guide walks you through writing one, from the first line to the cases that prove it decides and the report that tells you how it does once it runs in your code.

## Start

A jevel is a folder with one `JEVEL.md` in it. The frontmatter at the top is what jevelry reads, and the body under it is what you and your agents read when you come back to it in three months. The fastest way to start is to copy the nearest of the seventeen that ship with the package, which are listed in `jevels/README.md`, and change it:

    npx jevelry show ticket-triage

Every jevel has a `name` that matches its folder, a `version` you bump when you change a question, a pinned `model`, a `state` block that names the keys your code will send, and a `questions` map. The body carries four headings, `When to use`, `State`, `Decisions` and `Example`, and every shipped jevel also carries an `example.json` you can ask it with and a `cases.json` that proves its questions decide. `npx jevelry check <name>` tells you when something in the file is off.

## Questions

Each question is one decision. A score measures one thing, like severity or urgency, and a noul checks one condition, so a question that feels like it needs an "and" in the middle is usually two questions. Ask both and combine them in your code, because every question in a jevel is answered on its own in the same request, and one more question costs you a few tokens on that request.

Pick the type from the shape of the decision your code makes:

| Your code decides | Type | What comes back |
| --- | --- | --- |
| which of a fixed set of options, like a team or a template | `choice` | the option, a probability for every option and a confidence |
| where something sits on a scale you define, like frustration or risk | `score` | a value that can land between two levels, a probability per level and a confidence |
| whether one condition holds, like "the message asks for a refund" | `noul` | one probability from 0 to 1, and jevelry adds `yes` at 0.5 |

Every `choice` carries a catch-all option, named `other`, `unclear`, `unknown` or whatever reads right for your decision. When none of your options fits, the probability still has to land on one of them, and that option is where it goes, so your code sees a real answer.

When the same question applies to every item in a list, like every open issue that might be a duplicate, write it once with `repeat`:

    same_as:
      type: noul
      repeat: { over: candidates, as: candidate }

jevelry sends one question per item in `candidates`, rewrites `` `candidate` `` to `` `candidates[0]` ``, `` `candidates[1]` `` and so on in the instructions and the criteria, and the answers come back as `same_as[0]`, `same_as[1]`. Filter the list in your code before you send it: the same labels, the last 90 days, a few dozen at most, because Jev is more accurate on a short state and you pay per input token.

## Instructions

Jev reads your question literally, so the instructions are an object that says exactly what to judge and how. `question` is the question itself and names the part of the state it is about with a backticked path like `` `ticket.message` ``. `focus` says what decides the answer, `inspect` says which fields to read, and `compare` says what to hold against what when the question compares two records. This is the `team` question from `ticket-triage`:

    instructions:
      question: "Which team should handle `ticket`?"
      focus: "Classify the one thing the customer asks for. A message that touches several topics belongs to the team that owns the request."
      inspect: "`ticket.subject` and `ticket.message`"

And this is `same_as` from `duplicate-issue`, which holds two records against each other and so carries `compare`:

    instructions:
      question: "Does `candidate` report the same problem as `issue`?"
      inspect: "`issue.title`, `issue.body`, `candidate.title` and `candidate.body`"
      compare: "The behaviour `issue.body` describes against the behaviour `candidate.body` describes"
      focus: "Two reports of one problem stay one problem when the wording, the version number or the browser differ."

"Is this urgent?" reads well to a person and badly to Jev, and "Does `ticket.message` say or imply that the customer needs an answer today?" says where to look and what urgent means for your queue. When you catch yourself explaining what you really meant by a question, that explanation belongs in `question` or `focus`.

## Criteria

The criteria are where the boundary cases live, and Jev reads them next to each other. That is why every entry in one question carries the same fields, and `check` warns you when one option has a field the others lack, because Jev would read that field as something only that option can have.

For a `choice`, every option is `{ what, not_for, examples }`. `what` says what the option covers, `not_for` names the neighbouring option it gets mixed up with and why that one wins, and `examples` are two or three short phrases the way your state would say them. Two of the four options of `team` in `ticket-triage`:

    billing:
      what: "A charge, an invoice, a refund, a price or a subscription change"
      not_for: "A feature that fails, which belongs to technical, or a password, which belongs to account"
      examples:
        - "I was charged twice for invoice 8841"
        - "Cancel my subscription and refund this month"
        - "The invoice shows the wrong VAT number"
    other:
      what: "A message that asks for none of the three above, or that asks for nothing at all"
      not_for: "A message that names a charge, a broken feature or a login, each of which belongs to one of the three above"
      examples:
        - "Thanks, that worked"
        - "Do you sponsor conferences?"

For a `score`, every level is `{ what, signals }` and describes a situation you would recognise in the state, from low to high. Jev judges each level on its own and sees no level number, so a level that says "more than the previous one" gives it nothing to match. Write what the state looks like at that level, with a few phrases that mark it. The `frustration` levels of `ticket-triage`:

    criteria:
      - what: "The customer states the problem in plain or friendly wording, asks politely, and writes in for the first time"
        signals:
          - "hi, quick question"
          - "thanks in advance"
          - "could you have a look"
      - what: "The customer says they have written before, repeats a problem that is still open, or says plainly that they are annoyed"
        signals:
          - "this is the third time I am writing"
          - "still waiting for an answer"
          - "I have tried everything you suggested"
      - what: "The customer threatens to leave or to escalate, insults the team, or writes in capitals"
        signals:
          - "cancel my account today"
          - "your support is a joke"
          - "ABSOLUTELY UNACCEPTABLE"

For a `noul`, the criteria are `{ true: { what, examples }, false: { what, examples } }`, and the question is phrased so that yes means the condition holds. A `true` that starts with "not" confuses the model and `check` warns you about it. The `urgent` question of `ticket-triage`:

    criteria:
      true:
        what: "The customer names today or an hour today, says that work or money is blocked while this is open, or asks for an immediate fix"
        examples:
          - "I need the refund today, my accountant closes the books this afternoon"
          - "We cannot invoice anyone until this is back"
          - "Our shop has been down since this morning"
      false:
        what: "The customer asks a question or reports something that can wait for the normal queue"
        examples:
          - "Have a look whenever you get to it"
          - "Just so you know, the label is misspelled"
          - "How do I add a second seat?"

Jev reads what the text says and what it clearly implies, and it counts, calculates and compares dates poorly. So your code does the counting and the date math and puts the result into the state as words, like `"age": "over a day old"` or `"when": "six minutes before the alert"`, and the question asks about meaning. If the question is "are there more than three failed logins", you count in code and ask Jev whether a message describes a login problem. Write the criteria in the words your state uses, and ask the direct way, because a double negative gets read at face value and `check` warns you about that too.

## State

The state is the material you would hand a panel of experts before asking them the question: everything relevant and only that, rendered for a reader. A field the questions skip costs accuracy on every question, and a raw event record with ids and timestamps reads worse than the same event written as a sentence. Two shipped jevels show how: the State section of `notification-triage` renders each notification as `{ "from": "...", "about": "...", "text": "..." }` in plain words, and the State section of `alert-cause` sends the gap between each change and the alert as `"when": "six minutes before the alert"`, which your code works out from the two timestamps.

Name the keys your questions read in `state.required`, so a missing key is refused before anything is sent:

    state:
      required: [ticket]
      budget_tokens: 8000

`budget_tokens` is your own ceiling under Jev's limits (32k tokens for the state plus the longest question, 64k for everything). When your code sends more than that, `ask` exits with code 5 before it costs you anything. The `ticket-triage` example costs 1,280 input tokens with its three questions, and the `duplicate-issue` example with two candidates costs 1,170, because every question sends its framing and its criteria along with the state.

## Decisions

Every answer comes back with a decision, `act`, `mark` or `fall_back`, and the thresholds that decide it live on the question:

    thresholds: { act: 0.85, mark: 0.7 }

A `choice` or `score` is judged on the confidence Jev reports, and a `noul` on how far its probability sits from 0.5, so a noul of 0.08 is as sure as one of 0.92. Above `act` your code acts on the answer, between `mark` and `act` it acts and flags the case for a person, and below `mark` it does what it did before the jevel existed.

Set them by what a wrong answer costs. A question that only sorts a queue can act at 0.7. A question that skips a step a person would otherwise do should sit at 0.9, and you lower it later with the report in front of you. The runtime defaults are 0.9 and 0.7, and you can set jevel-wide defaults in a `thresholds` block at the top and override them per question. The values in the shipped jevels are a starting point, and the report is what moves them.

## Commands

A choice question can name a command for each of its options, and `jevelry run` runs the one Jev picks. One question per jevel carries the `run` block, and it maps option names to commands:

    questions:
      cause:
        type: choice
        instructions: { question: "...", focus: "..." }
        criteria: { defect: {...}, environment: {...}, flaky: {...}, other: {...} }
        thresholds: { act: 0.9, mark: 0.7 }
        run:
          flaky: "npm test -- --retry={{retries}}"
          environment: "gh issue create --label ci --title 'The sandbox blocked the test run' --body 'See the CI log of this run'"
      retries:
        type: choice
        instructions: { question: "...", focus: "..." }
        criteria: { "1": {...}, "2": {...}, "3": {...} }
        thresholds: { act: 0.8, mark: 0.6 }
    fall_back: "echo 'Jev is unsure, look at the failing test yourself'"

An option you leave out of `run` runs nothing when Jev picks it, which is what you want for `other`. `{{retries}}` is an argument: it names another choice question of the jevel and gets the option Jev picked there, or it names a noul and gets `true` or `false`. That is the only thing jevelry puts into a command, so the option names of an argument may only use letters, digits, dot, underscore and hyphen, and `check` refuses the jevel otherwise. Your state reaches the command as data, as JSON on stdin and in a file whose path is in `JEVELRY_STATE`, next to `JEVELRY_DECISION` (`act`, `mark` or `fall_back`), `JEVELRY_OPTION` and `JEVELRY_LOG_ID`. What the command reads on stdin is your whole state, customer text included, so only pass it on to places where that text may go. An option name that starts with `-` reads like a flag to most commands, so start the options of an argument with a letter or a digit.

The call is as sure as the least sure answer behind it. When Jev picks `flaky` at 0.97 and 2 retries at 0.72, the call is 0.72, and the thresholds of `cause` turn that into the decision: `act` runs the command, `mark` asks you first or runs with `--yes`, and `fall_back` runs the top-level `fall_back` command when the jevel has one. So give every argument clear criteria of its own, because one unsure argument pulls the whole call down to `mark`.

In your program, `run` takes a handler per option in place of the shell commands:

```ts
const failing = jevel("failing-test");
const { ran } = await failing.run({ test }, {
  flaky: (args) => rerun(test, Number(args.retries)),
  environment: () => reportToCiOwner(test),
  fall_back: () => leaveForAPerson(test),
}, { confirm: (option, certainty) => askTheOnCall(option, certainty) });
```

When you leave out `confirm`, a `mark` runs nothing and `ran.confirmed` is `false`, and with `{ shell: true }` the jevel's own commands run for every option you gave no handler. When your program gets SIGINT, SIGTERM or SIGHUP while such a command runs, jevelry passes the signal on to the command, removes the state file and returns `{ exit, ms, signal }` in `ran.result`, and your program decides whether to stop. A command keeps your terminal, so a `sudo` or `git` prompt in it works the way it does in your shell.

## Prove it

Before you wire a decision into anything, you prove that the questions decide, and you do that with a `cases.json` next to the `JEVEL.md`. It is a JSON array of cases, and each case has a `name`, a `state` your jevel accepts and an `expect` that says what a correct answer looks like for each question, by its answer name (a `repeat` question appears as `same_as[0]`). A string expects that choice, `true` or `false` expects that noul answer, and a whole number expects the score to round to that level, and in each of those the decision must be `act` or `mark`. A `null` says the case is unclear, so the decision must stay below `act`. A question you leave out of `expect` is asked and left alone. One case from `ticket-triage`:

    {
      "name": "fourth mail about a team locked out since this morning",
      "state": {
        "ticket": {
          "subject": "Password reset mail still missing",
          "message": "Fourth time I am writing about this. The password reset mail for admin@northwind.example still has not arrived, and my whole team has been locked out of the dashboard since this morning.",
          "customer_since": "2022-06"
        }
      },
      "expect": { "team": "account", "urgent": true, "frustration": 1 }
    }

Write three kinds of case: one that is clear one way, one that is clear the other way, and one a colleague would ask you a question back about, which expects `null`. Make them realistic, a message a person would actually write or a diff summary a tool would actually print, because a clear case in real life is clear in a messy way.

Every shipped jevel follows the same rules, and the shipped test enforces them: at least three cases, every question expected with a value in at least two of them and with at least two different values across them (a noul seen `true` and `false`, a choice seeing two options, a score seeing two levels), at least one case with a `null`, and each state under 1,500 characters and under the jevel's `budget_tokens`. The same test holds every shipped jevel to the shape in this guide, instructions as an object with a `question` and the same fields on every criteria entry, and `check` prints `0 warnings` for each of them.

To ask every case in this repository against the real API, with the key read from the environment:

    TYPESAFE_API_KEY=... npm run test:live -- tests/live/jevels.test.ts

In your own project you ask each case the way the suite does and read the answers next to `expect`:

    jq -c '.[]' jevels/<name>/cases.json | while read -r c; do
      printf '%s\n' "$c" | jq -r .name
      npx jevelry ask <name> --state "$(printf '%s\n' "$c" | jq -c .state)" | jq -c '.answers | map_values({choice, yes, score, decision})'
    done

A clear case that Jev gets wrong, or gets right at `fall_back`, means the criteria or the state are wrong, and you rewrite them. Rewriting the question usually beats lowering the threshold. You move an expectation only when the expectation itself was the mistake, and you say so in the commit.

## Tuning

When you know later what was actually true, tell jevelry and read the report:

    npx jevelry outcome <log_id> urgent yes
    npx jevelry report --jevel <name>

After a few hundred asks the report shows you, per question, how often `act` decisions agreed with reality, and that is the number you move thresholds by. A question that agrees 95% of the time can probably act lower, and one that agrees 70% of the time goes up or gets rewritten, with a new case for the state it got wrong.

Bump `version` each time you change a question or a threshold, so the log tells the asks apart. Keep `model` pinned to a concrete version like `jev-1.13.0`. An alias like `jev-latest` moves when TypeSafe ships a release, and thresholds you tuned on one version usually need a look on the next, so move the pin yourself once the cases pass on the new version and the report looks right.

## Checklist

- Every question is one decision, every `choice` has a catch-all option like `other` or `unclear`, and every noul's `true` reads as a yes.
- Every `instructions` is an object whose `question` names the state it reads with a backticked path.
- Every criteria entry in a question has the same fields: `{ what, not_for, examples }` for options, `{ what, signals }` for score levels that describe situations, `{ true: { what, examples }, false: { what, examples } }` for a noul.
- Counting, dates and math happen in your code, and the state carries the result as words.
- The state has only what the questions need, rendered for a reader, and `state.required` lists the keys.
- Thresholds match what a wrong answer costs, and the body says what your code does with each decision.
- `model` is pinned, `version` is set, and `check` prints 0 warnings.
- `cases.json` holds at least three realistic cases, one of them unclear, and every clear case lands on its expected answer at `act` or `mark` against the real API.
