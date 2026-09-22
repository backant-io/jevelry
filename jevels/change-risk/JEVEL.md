---
name: change-risk
version: 1
model: jev-1.13.0
state:
  required: [change]
  budget_tokens: 10000
questions:
  risk:
    type: score
    instructions: "How risky is merging `change`?"
    criteria:
      - "low: a small, contained edit, and a mistake shows up right away"
      - "medium: several files or a shared path, and a mistake reaches some users"
      - "high: data, money, authentication or a migration, and a mistake is expensive to undo"
    verdict: { act: 0.75, mark: 0.55 }
  breaking:
    type: noul
    instructions: "Does `change` alter behaviour that existing callers or users depend on?"
    criteria:
      true: "An interface, a default, a response shape, a database column or a command changes in a way existing use has to follow."
      false: "Existing use keeps working exactly as it does today."
    verdict: { act: 0.9, mark: 0.75 }
  needs_owner_approval:
    type: noul
    instructions: "Does `change.files` touch an area where the owning team should approve before it merges?"
    criteria:
      true: "The files sit in authentication, payments, data migrations, infrastructure or a public interface."
      false: "The files sit in an area a reviewer from any team can judge."
    verdict: { act: 0.85, mark: 0.7 }
---
# change-risk

## When to use

On a pull request before it merges, to decide how many eyes it needs and whether the release notes have to warn anybody.

## State

`change`: `{ "title": "...", "description": "...", "files": ["..."] }`. `files` is the list of paths the change touches, which your code reads from the diff; it carries most of the risk signal, so send all of it.

## Verdicts

`risk` at level 2 with `act`: require a second reviewer and a release window. Level 0 with `act`: let it merge on one approval. `mark`: apply the level and flag the pull request for the release owner. `fall_back`: use the review rules you had before this jevel.
`breaking` yes with `act`: hold the merge until the change carries a migration note. `needs_owner_approval` yes with `act`: request review from the owning team and hold the merge until it arrives.

## Example

The example state holds a billing change that moves amounts to integer minor units and migrates the stored rows. It answers `risk` at level 2, `breaking` yes and `needs_owner_approval` yes.
