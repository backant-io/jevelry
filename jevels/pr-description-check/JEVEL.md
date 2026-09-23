---
name: pr-description-check
version: 3
model: jev-1.13.0
state:
  required: [pr]
  budget_tokens: 10000
questions:
  describes_the_change:
    type: noul
    instructions:
      question: "Does `pr.body` describe the change that `pr.diff_summary` shows?"
      compare: "the work `pr.body` describes against the files listed in `pr.diff_summary`"
      focus: "Judge whether a reader of the body would expect the main files in the diff summary. A body that covers the main change and skips a file still describes the change."
    criteria:
      true:
        what: "The body names the change the main files in the diff summary carry"
        examples:
          - "the body says the pricing table is cached, and the diff adds src/pricing/cache.ts"
          - "the body says the --dry flag is renamed, and the diff edits src/cli/flags.ts"
      false:
        what: "The body is a template, a line that names no change, or a description of work the files in the diff summary do not show"
        examples:
          - "Fixes stuff, see ticket"
          - "the body talks about the login page and the diff edits the billing worker"
    thresholds: { act: 0.85, mark: 0.7 }
  mentions_tests:
    type: noul
    instructions:
      question: "Does `pr.body` say how the change was tested?"
      inspect: "`pr.body`"
      focus: "Look for tests the author added or ran, or a manual check the author did. Test files in the diff summary count only when the body mentions them."
    criteria:
      true:
        what: "The body names tests that were added or run, or a manual check that was done"
        examples:
          - "added unit tests for the refresh timer"
          - "ran the quote suite locally"
          - "clicked through checkout on staging"
      false:
        what: "The body says nothing about how the change was tested"
        examples:
          - "a body that only describes the change"
          - "Fixes stuff, see ticket"
    thresholds: { act: 0.85, mark: 0.7 }
  leaves_work_out:
    type: noul
    instructions:
      question: "Does `pr.diff_summary` touch something that `pr.body` is silent about?"
      compare: "each file in `pr.diff_summary` against the work `pr.body` describes"
      focus: "Go through the files one by one. A test file for the described work is covered by the body. A migration, a config change or a second feature the body leaves unmentioned is work the body leaves out."
    criteria:
      true:
        what: "The diff touches a file or an area the description is silent about"
        examples:
          - "the description says rename a flag, and the diff also adds a migration"
          - "the description covers a cache, and the diff also drops a database index"
          - "Fixes stuff, and the diff edits five files across three services"
      false:
        what: "Every file in the diff summary belongs to the work the body describes, tests for that work included"
        examples:
          - "the body renames a flag, and the diff edits the flag parser, the docs and the flag test"
          - "the body adds a cache, and the diff adds the cache file and its test"
    thresholds: { act: 0.85, mark: 0.7 }
  risk_noted:
    type: noul
    instructions:
      question: "Does `pr.body` name something to watch when this change ships?"
      inspect: "`pr.body`"
      focus: "Look for a named risk, a migration, a rollback plan, a feature flag or a behaviour change users will notice. Only what `pr.body` says counts; a migration or a flag that appears in the diff summary and goes unmentioned in the body is left out of this."
    criteria:
      true:
        what: "The body names a risk, a migration, a rollback, a feature flag or a behaviour change to watch"
        examples:
          - "the old flag keeps working for one release and prints a warning"
          - "roll back by reverting, the migration is reversible"
          - "behind the new_checkout flag"
      false:
        what: "The body describes the work and names nothing to watch after it ships"
        examples:
          - "a body that describes the change and its tests only"
          - "Fixes stuff, see ticket"
    thresholds: { act: 0.8, mark: 0.6 }
---
# pr-description-check

## When to use

On a pull request when it opens, to tell the author what the description leaves for the reviewer to work out.

## State

`pr`: `{ "title": "...", "body": "...", "diff_summary": "..." }`. `diff_summary` is one entry per file with the path and the added and removed line counts, which your code builds from the diff, so the questions compare the description against the change while the whole patch stays at home.

## Decisions

`describes_the_change` no with `act`: comment on the pull request and ask the author to describe the change the diff shows. `mentions_tests` no with `act`: ask how it was tested. `leaves_work_out` yes with `act`: list the files the body passes over and ask the author to cover them. `risk_noted` no with `act`: ask what to watch after it ships.
Each of the four with `mark`: post the same comment and address it to the reviewer as well. `fall_back`: leave the pull request alone.

## Example

The example state holds a pull request that caches the pricing table, with the tests named in the body and a migration in the diff summary the body passes over. It answers `describes_the_change` yes, `mentions_tests` yes, `leaves_work_out` yes and `risk_noted` no.
