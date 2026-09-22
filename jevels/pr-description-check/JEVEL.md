---
name: pr-description-check
version: 1
model: jev-1.13.0
state:
  required: [pr]
  budget_tokens: 10000
questions:
  describes_the_change:
    type: noul
    instructions: "Does `pr.body` describe the work that `pr.diff_summary` shows?"
    criteria:
      true: "A reader of the body would expect the files and the edits the diff summary lists."
      false: "The body is generic, stale, or describes other work than the diff summary shows."
    verdict: { act: 0.85, mark: 0.7 }
  mentions_tests:
    type: noul
    instructions: "Does `pr.body` say how the change was tested?"
    criteria:
      true: "The body names tests that were added or run, or the manual check that was done."
      false: "The body leaves testing open."
    verdict: { act: 0.85, mark: 0.7 }
  leaves_work_out:
    type: noul
    instructions: "Does `pr.diff_summary` list work that `pr.body` passes over?"
    criteria:
      true: "The diff summary holds files or edits the body is silent about."
      false: "Every part of the diff summary is covered by the body."
    verdict: { act: 0.85, mark: 0.7 }
  risk_noted:
    type: noul
    instructions: "Does `pr.body` say what could go wrong when this change ships?"
    criteria:
      true: "The body names a risk, a migration, a rollback, a feature flag or a behaviour change to watch."
      false: "The body describes the work and leaves the risk open."
    verdict: { act: 0.8, mark: 0.6 }
---
# pr-description-check

## When to use

On a pull request when it opens, to tell the author what the description leaves for the reviewer to work out.

## State

`pr`: `{ "title": "...", "body": "...", "diff_summary": "..." }`. `diff_summary` is one entry per file with the path and the added and removed line counts, which your code builds from the diff, so the questions compare the description against the change while the whole patch stays at home.

## Verdicts

`describes_the_change` no with `act`: comment on the pull request and ask the author to describe the change the diff shows. `mentions_tests` no with `act`: ask how it was tested. `leaves_work_out` yes with `act`: list the files the body passes over and ask the author to cover them. `risk_noted` no with `act`: ask what to watch after it ships.
Each of the four with `mark`: post the same comment and address it to the reviewer as well. `fall_back`: leave the pull request alone.

## Example

The example state holds a pull request that caches the pricing table, with the tests named in the body and a migration in the diff summary the body passes over. It answers `describes_the_change` yes, `mentions_tests` yes, `leaves_work_out` yes and `risk_noted` no.
