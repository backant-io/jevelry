---
name: review-comment-kind
version: 1
model: jev-1.13.0
state:
  required: [comment]
  budget_tokens: 8000
questions:
  kind:
    type: choice
    instructions: "What kind of review comment is `comment.text`?"
    criteria:
      defect: "It points at behaviour that is wrong, a bug, a missing case or a security hole."
      style: "It is about naming, formatting, structure or taste, and the code works either way."
      process: "It is about tests, documentation, the commit, the branch or how the change is delivered."
      question: "It asks the author to explain something."
      praise: "It says the code or the approach is good."
      unclear: "The comment is too short or too general to place in the five above."
    verdict: { act: 0.8, mark: 0.6 }
  actionable:
    type: noul
    instructions: "Does `comment.text` tell the author something concrete to change?"
    criteria:
      true: "The author can read it and know which edit to make."
      false: "It states an opinion or asks a question and leaves the edit open."
    verdict: { act: 0.85, mark: 0.7 }
  blocking:
    type: noul
    instructions: "Does `comment.text` ask for a change before the pull request is merged?"
    criteria:
      true: "The comment says or implies that merging this as it stands would be wrong."
      false: "The comment is fine to address later or in another pull request."
    verdict: { act: 0.9, mark: 0.75 }
---
# review-comment-kind

## When to use

On each comment that arrives on a pull request, to sort the ones that hold the merge from the ones the author can read later.

## State

`comment`: `{ "author": "...", "text": "...", "file": "...", "snippet": "..." }`. `text` is what the reviewer wrote, and `file` and `snippet` are optional fields carrying the line the comment hangs on; the answers are sharper when you send them.

## Verdicts

`kind` with `act`: label the comment and route it, defects to the author's list and style to a cleanup pass. `mark`: label it and show the author the label. `fall_back`: leave the comment unlabelled.
`actionable` yes with `act`: put the comment in the author's checklist for this pull request. `blocking` yes with `act`: hold the merge until the author marks the comment resolved.

## Example

The example state holds a comment about a division that runs before the empty-list guard, with the file and the line it hangs on. It answers `kind` = `defect`, `actionable` yes and `blocking` yes.
