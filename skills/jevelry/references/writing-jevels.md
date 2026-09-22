# Writing jevels

You were probably about to write a prompt that says "answer with JSON" and hope the model sticks to it. With Jev you write a jevel instead: a small file that says what the state looks like, which questions to ask about it, and how sure the answer has to be before your code acts on it. This guide walks you through writing one, from the first line to the report that tells you whether it works.

## What a jevel is

A jevel is a folder with one `JEVEL.md` in it. The frontmatter at the top is what jevelry reads, and the body under it is what you and your agents read when you come back to it in three months. The fastest way to start is to copy the nearest of the sixteen that ship with the package and change it:

    npx jevelry show ticket-triage

Every jevel has a `name` that matches its folder, a `version` you bump when you change a question, a pinned `model`, a `state` block that names the keys your code will send, and a `questions` map. That is the whole format, and `npx jevelry check <name>` tells you when something in it is off.

## Pick the question type

Jev answers three kinds of questions and the type you pick decides what comes back, so pick it from the shape of the decision your code has to make.

Use a `choice` when your code will branch on one of a fixed set of options, like which team gets a ticket or which of five templates fits a document. You get the option, a probability for every option and a confidence.

Use a `score` when the answer is a level on a scale you define, like how frustrated a customer is or how risky a change looks. You give the levels in order, from low to high, and you get a value that can land between two levels, a probability per level and a confidence.

Use a `noul` when the answer is yes or no, like whether a message asks for a refund or whether a bug report has steps to reproduce. You get one probability from 0 to 1, and jevelry adds `yes` for you at 0.5.

A question that feels like it needs two types is usually two questions. Ask both and combine them in your code, because every question in a jevel is answered on its own in the same request, and one more question costs you a few tokens on the same request.

## Write the question

Jev reads your question literally, so write the exact condition and nothing you would expect a person to infer. Point the question at the part of the state it is about with a backticked path like `` `ticket.message` `` or `` `candidates[0].title` ``, and Jev will look there.

A question that reads well to a human and badly to Jev:

    instructions: "Is this urgent?"

The same question written for Jev:

    instructions: "Does `ticket.message` say or imply that the customer needs an answer today?"

The second one names where to look and what "urgent" means for your queue. When you catch yourself explaining what you really meant by a question, that explanation belongs in the instruction.

Keep the arithmetic in your code, because Jev counts, compares dates and does math poorly, so if the question is "are there more than three failed logins" you count in code and ask Jev something it is good at, like whether a message describes a login problem.

## Write the criteria

The criteria are where the boundary cases live. For a `choice`, describe every option in the words your state uses, and add an `other` or `unclear` option so Jev has somewhere to put the cases you did not think of. When none of your options fits, the probability still has to land on one of them, and the `other` option is where it goes, so your code sees a real answer.

    criteria:
      billing: "Payments, invoices, refunds, subscription changes."
      technical: "Bugs, outages, error messages, integrations, data that looks wrong."
      account: "Login, password, permissions, closing or changing an account."
      other: "Anything the three teams above do not cover, or a message with no request in it."

For a `score`, give two to ten levels in order, each with a short description of what that level looks like in the state. For a `noul`, describe what a yes looks like under `true` and what a no looks like under `false`, and write `true` as a yes. A `true` that starts with "not" confuses the model and `check` warns you about it.

## Ask about a list

When the same question applies to every item in a list, like every open issue that might be a duplicate, write it once with `repeat`:

    same_as:
      type: noul
      repeat: { over: candidates, as: candidate }
      instructions: "Does `candidate` report the same problem as `issue`?"

jevelry sends one question per item in `candidates`, rewrites `` `candidate` `` to `` `candidates[0]` ``, `` `candidates[1]` `` and so on, and answers come back as `same_as[0]`, `same_as[1]`. Filter the list in your code before you send it: the same labels, the last 90 days, a few dozen at most. Jev is more accurate on a short state and you pay per input token.

## Send the right state

The state is the material you would hand a colleague before asking the question, and only that. Name the keys your questions read in `state.required` so a missing key is refused before anything is sent, and give the state a structure so you can point at parts of it:

    state:
      required: [ticket]
      budget_tokens: 8000

`budget_tokens` is your own ceiling under Jev's limits (32k tokens for the state plus the longest question, 64k for everything). When your code sends more than that, `ask` exits with code 5 before it costs you anything. The reference ask in our live test, one question about one sentence, costs 307 input tokens, and the two-question ask with two candidates costs 615.

## Set the thresholds

Every answer comes back with a verdict, `act`, `mark` or `fall_back`, and the thresholds that decide it live on the question:

    verdict: { act: 0.85, mark: 0.7 }

A `choice` or `score` is judged on the confidence Jev reports, and a `noul` on how far its probability sits from 0.5, so a noul of 0.08 is as sure as one of 0.92. Above `act` your code acts on the answer, between `mark` and `act` it acts and flags the case for a person, and below `mark` it does what it did before the jevel existed.

Set them by what a wrong answer costs. A question that only sorts a queue can act at 0.7. A question that skips a step a person would otherwise do should sit at 0.9, and you lower it later with the report in front of you. The runtime defaults are 0.9 and 0.7, and you can set jevel-wide defaults in a `verdict` block at the top and override them per question.

## Check it

Before you spend a token, run:

    npx jevelry check <name>

It refuses a jevel the API would refuse anyway: a choice with fewer than two or more than 255 options, a score with fewer than two or more than ten levels, a threshold outside 0 to 1, a `mark` above `act`, a question with no instructions, a name that differs from the folder. It warns you about the cases Jev handles poorly: a `true` that starts with "not", a double negative in a question, a `repeat.as` that is also a required key, a body missing one of the four headings, and a model given as an alias. Fix the warnings too, because each one is a way to get a confident wrong answer.

## Try it

Write three states, one where the answer is obvious, one where it is obviously the other way, and one you are unsure about yourself, and ask each:

    npx jevelry ask <name> --state @obvious.json
    npx jevelry ask <name> --state @opposite.json
    npx jevelry ask <name> --state @unsure.json

Read the probabilities, and if the obvious case is under your `act` threshold, the question is probably unclear, and rewriting it usually beats lowering the threshold. When you know later what was actually true, tell jevelry and read the report:

    npx jevelry outcome <log_id> urgent yes
    npx jevelry report --jevel <name>

After a few hundred asks the report shows you, per question, how often `act` verdicts agreed with reality, and that is the number you move thresholds by.

## Version it

Bump `version` whenever you change a question or a threshold, so the log tells the asks apart. Keep `model` pinned to a concrete version like `jev-1.13.0`. An alias like `jev-latest` moves when TypeSafe ships a release, and thresholds you tuned on one version usually need a look on the next, so move the pin yourself after reading the report.

## A jevel from scratch

Say your support inbox needs sorting, and the decision your code makes is which queue a ticket goes to and whether it jumps to the top, so that is a `choice` and a `noul`, and since angry customers get a person first, a `score` for frustration as well.

1. Create `jevels/ticket-triage/JEVEL.md` and write the frontmatter: `name: ticket-triage`, `version: 1`, `model: jev-1.13.0`, `state.required: [ticket]`.
2. Write the `team` choice with four options, `billing`, `technical`, `account` and `other`, each described in the words your customers use.
3. Write the `urgent` noul: "Does `ticket.message` say or imply that the customer needs an answer today?" with a `true` that names deadlines, blocked work and requests for an immediate fix.
4. Write the `frustration` score with three levels, calm, frustrated, very angry, each with what it looks like in a message.
5. Set `act` at 0.8 for the team, 0.85 for urgency, 0.7 for frustration.
6. Write the four headings in the body: when to use it, what state to send, what your code does with each verdict, and one example state with the answers you expect.
7. Run `npx jevelry check ticket-triage`, then ask it three tickets, then wire the verdicts into your code.

That is the jevel that ships with the package, so you can read the finished version with `npx jevelry show ticket-triage` while you write yours.

## Before you hand it over

- Every question names the part of the state it reads, with a backticked path.
- Every `choice` has an `other` or `unclear` option, and every `true` reads as a yes.
- Counting, dates and math happen in your code, and the jevel asks about meaning.
- The state has only what the questions need, and `state.required` lists the keys.
- Thresholds match what a wrong answer costs, and the body says what your code does with each verdict.
- `model` is pinned, `version` is set, and `check` prints 0 warnings.
- You asked it three states and read the probabilities, and the questions and thresholds sit in the `jevels/` folder where a person will review them.
