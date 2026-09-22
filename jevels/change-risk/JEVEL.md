---
name: change-risk
version: 2
model: jev-1.13.0
state:
  required: [change]
  budget_tokens: 10000
questions:
  risk:
    type: score
    instructions:
      question: "Which of these situations does `change` read like?"
      inspect: "`change.title`, `change.description` and every path in `change.files`"
      focus: "Judge what the change touches, by the paths in `change.files` and by what the description says it alters. The size of the diff stays out of this."
    criteria:
      - what: "Everything the change touches is documentation, tests, copy or comments, and the running behaviour of the product stays as it is"
        signals:
          - "paths under docs/ or tests/ only"
          - "a wording change in a label or a README"
          - "a comment added beside code that stays as it is"
      - what: "The change rewrites logic behind an interface that stays the same, so callers keep calling it the way they call it today"
        signals:
          - "a function rewritten with the same signature"
          - "a retry loop or a cache replaced inside one module"
          - "paths under src/ with no schema, no migration and no public route among them"
      - what: "The change touches a schema, a migration, authentication, payments or a public interface, and a mistake in it reaches stored data, money or callers outside the codebase"
        signals:
          - "a path under migrations/"
          - "paths under payments or auth"
          - "a request or response field that changes type"
          - "a public route added or removed"
    verdict: { act: 0.75, mark: 0.55 }
  breaking:
    type: noul
    instructions:
      question: "Does `change` alter behaviour that existing callers or users depend on?"
      inspect: "`change.description` for what alters, and `change.files` for where it alters"
      focus: "Judge one thing: whether code or a person using the product today has to change something of their own to keep working after this merges."
    criteria:
      true:
        what: "An interface, a default, a response shape, a database column or a command changes so that existing use has to follow the change"
        examples:
          - "the amount field takes integer minor units and the decimal form is rejected with a 400"
          - "the endpoint moved and the old path returns 404"
          - "the environment variable was renamed"
      false:
        what: "Existing use keeps working exactly as it works today, and anything new is added beside what is already there"
        examples:
          - "a new optional field, with the old default kept"
          - "a rewrite behind the same function signature"
          - "a typo fixed in a label"
    verdict: { act: 0.9, mark: 0.75 }
  needs_owner_approval:
    type: noul
    instructions:
      question: "Do the paths in `change.files` reach an area where the owning team should approve before the change merges?"
      inspect: "every path in `change.files`"
      focus: "Read the paths one at a time. A single path in a guarded area answers this yes, whatever the other paths are."
    criteria:
      true:
        what: "A path in the list sits in one of these areas: authentication or sessions, payments or billing, a database migration, deployment or cloud configuration, or a public interface such as an API route or a published client"
        examples:
          - "migrations/2026-09-22-amounts-to-minor-units.sql"
          - "src/payments/charge.ts"
          - "src/auth/session.ts"
          - "infra/terraform/main.tf"
          - "src/api/routes/public.ts"
      false:
        what: "Every path in the list sits in an area a reviewer from any team can judge: product code behind an internal interface, a background worker, a report, copy, documentation or tests"
        examples:
          - "src/jobs/cleanup.ts"
          - "src/reports/table.tsx"
          - "docs/guide.md"
          - "tests/reports/table.test.ts"
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
