---
name: request-route
version: 1
model: jev-1.13.0
state:
  required: [request]
  budget_tokens: 8000
questions:
  complexity:
    type: score
    instructions:
      question: "Which of these situations does `request.prompt` read like?"
      inspect: "`request.prompt`, with `request.context` for what it refers to"
      focus: "Count what the answer has to get right at once, and leave the subject out. One thing is the first situation however technical the subject. A named condition the obvious answer would miss, or a second step that builds on the first, is the second. Several conditions that pull against each other are the third. How long the answer would be stays out of this."
    criteria:
      - what: "One step: recall a fact or a definition, use one command or one standard recipe as it is, pull one value out of a text, or make one small change to a short text, such as fixing, shortening, labelling or translating it"
        signals:
          - "what does HTTP 304 mean"
          - "how do I reverse a list in Python"
          - "correct the spelling in this paragraph"
          - "find the phone number in this message"
          - "write a one-line thank-you note"
      - what: "One piece of work with a condition the obvious answer would miss, or two steps where the second builds on the first: a component that must hold under a named condition, an explanation that reasons from a cause to its effect, a rewrite that has to do several named things for a named reader, an extraction or a translation with rules to keep, an analysis of given material"
        signals:
          - "write a rate limiter that allows bursts and refills over time"
          - "change this column's type while the table stays in use"
          - "why does a higher minimum wage not always mean fewer jobs"
          - "rewrite this apology so that it names the mistake, says what we changed and offers a refund"
          - "turn this email into JSON with these six fields, null where one is missing"
      - what: "A design, a plan, a diagnosis or an argument that has to satisfy several conditions at once, where meeting one makes another harder, or that has to hold across several systems or several parties"
        signals:
          - "move this service to another region with no downtime and a way back"
          - "work out what went wrong across these three systems, the cause and not the symptom"
          - "write one statement that legal, engineering and support can all stand behind"
          - "prove that this always terminates"
    thresholds: { act: 0.8, mark: 0.6 }
  needs_tools:
    type: noul
    instructions:
      question: "To answer `request.prompt`, would the model have to do or fetch something: run a command, call a service, open a file or a page it was not given, or look up today's data?"
      inspect: "`request.prompt` and `request.tools`"
      focus: "Look for an action in the world or a fact that changes by the day. Material the person says they are sending along, like this email, these numbers or the code below, counts as given, and so does anything a model knows from training."
    criteria:
      true:
        what: "The answer rests on an action or a lookup: something has to be run, called, opened or checked as of today"
        examples:
          - "what is on my calendar tomorrow"
          - "run the tests and tell me which ones fail"
          - "what did the euro close at today"
          - "check whether the staging deploy went through"
      false:
        what: "The answer can be written from the request, the material it comes with and general knowledge"
        examples:
          - "explain what a mutex is"
          - "make this email sound friendlier"
          - "take the average of these numbers"
          - "here is the stack trace, what does it mean"
    thresholds: { act: 0.8, mark: 0.6 }
---
# request-route

## When to use

Before a request goes to a language model, when you run a small or local model next to a large one and want the small one to take what it can answer.

## State

`request`: `{ "prompt": "...", "context": "...", "tools": "..." }`. `prompt` is the message the model would answer, as the person wrote it. `context` is one sentence your code writes about what came before, like `"fourth message in a conversation about a Postgres migration"`, or `"first message"`. `tools` names what the model could call, in words, like `"web search, shell"`, or `"none"`. Send the last message and not the whole conversation: Jev is more accurate on a short state, and a long one costs tokens on every question.

## Decisions

`complexity` at level 0 with `act` and `needs_tools` no with `act`: send the request to the small model. Anything else goes to the model you would have used without the jevel: a level above 0, a yes, a `mark` or a `fall_back`. A wrong "easy" costs the person a bad answer, and a wrong "hard" costs you one call to the large model, so only a sure answer moves a request down.

## Example

The example state holds a request to translate one sentence, as the first message, with no tools. It answers `complexity` at level 0 and `needs_tools` = no, so the small model takes it.
