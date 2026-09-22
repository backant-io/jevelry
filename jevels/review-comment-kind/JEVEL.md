---
name: review-comment-kind
version: 2
model: jev-1.13.0
state:
  required: [comment]
  budget_tokens: 8000
questions:
  kind:
    type: choice
    instructions:
      question: "What kind of review comment is `comment.text`?"
      inspect: "`comment.text`, with `comment.file` and `comment.snippet` when the state carries them"
      focus: "Classify what the comment is about. A test failure is about the code only when the code is what made it fail."
    criteria:
      defect:
        what: "Points at behaviour of the code that is wrong: a bug, a missing case or a security hole"
        not_for: "A test that failed because the sandbox, the CI, a permission or the machine denied it, which belongs to environment: a test that failed because the sandbox denied a network call is environment, a test that failed because the code is wrong is defect"
        examples:
          - "this divides by the item count before checking whether the list is empty"
          - "the token is logged in plain text here"
          - "expected 3 rows, got 2, the filter drops the last page"
      style:
        what: "Is about naming, formatting, structure or taste, and the code works either way"
        not_for: "A comment about behaviour that is wrong, which belongs to defect"
        examples:
          - "nit: call this retryCount"
          - "this would read better as an early return"
      process:
        what: "Is about the tests to write, the documentation, the commit, the branch or how the change is delivered"
        not_for: "A comment about the CI, the sandbox or the machine the code ran on, which belongs to environment"
        examples:
          - "please add a test for the empty case"
          - "split this into two commits"
          - "update the changelog"
      environment:
        what: "Names the CI, the sandbox, the tooling, a permission or the machine the code ran on as what went wrong, and the code itself is not what the comment is about"
        not_for: "A test that failed because the code is wrong, which belongs to defect"
        examples:
          - "connect EPERM 104.18.2.1:443, the sandbox denied the network call"
          - "the CI runner ran out of disk"
          - "permission denied writing to /var/cache on the build machine"
      question:
        what: "Asks the author to explain something"
        not_for: "A comment that names a bug and phrases it as a question, which belongs to defect"
        examples:
          - "why a map here and a list above?"
          - "what happens when the queue is empty?"
      praise:
        what: "Says the code or the approach is good"
        not_for: "Praise followed by a requested change, which belongs to the kind of that change"
        examples:
          - "nice, much easier to read than the old loop"
          - "good catch on the timezone"
      unclear:
        what: "The comment is too short or too general to place in the six above"
        not_for: "A comment that names a bug, a style point, a process step, the environment, a question or praise, each of which belongs to one of the six above"
        examples:
          - "hmm"
          - "not sure about this"
    verdict: { act: 0.8, mark: 0.6 }
  actionable:
    type: noul
    instructions:
      question: "Does `comment.text` name an edit the author can make to the code?"
      inspect: "`comment.text`"
      focus: "The comment has to say which edit. An opinion, a question or a report about the machine leaves the edit open."
    criteria:
      true:
        what: "The author can read the comment and know which edit to make"
        examples:
          - "move the guard above the division"
          - "rename n to retryCount"
          - "add a test for the empty case"
      false:
        what: "The comment states an opinion, asks a question, gives praise or reports on the environment, and leaves the edit open"
        examples:
          - "nice work"
          - "why a map here?"
          - "the sandbox denied the network call"
    verdict: { act: 0.85, mark: 0.7 }
  blocking:
    type: noul
    instructions:
      question: "Does `comment.text` ask for a change before the pull request is merged?"
      inspect: "`comment.text`"
      focus: "Look for words that hold the merge, and for a defect that would ship if the pull request merged as it stands."
    criteria:
      true:
        what: "The comment says or implies that merging this as it stands would be wrong"
        examples:
          - "please fix before this goes in"
          - "this throws on an empty batch"
      false:
        what: "The comment is fine to address later or in another pull request, or asks for no change"
        examples:
          - "nit, up to you"
          - "nice work"
          - "follow-up ticket is fine"
    verdict: { act: 0.9, mark: 0.75 }
---
# review-comment-kind

## When to use

On each comment that arrives on a pull request, to sort the ones that hold the merge from the ones the author can read later.

## State

`comment`: `{ "author": "...", "text": "...", "file": "...", "snippet": "..." }`. `text` is what the reviewer wrote, and `file` and `snippet` are optional fields carrying the line the comment hangs on; the answers are sharper when you send them.

## Verdicts

`kind` with `act`: label the comment and route it, defects to the author's list, style to a cleanup pass and environment to whoever owns the CI and the sandbox. `mark`: label it and show the author the label. `fall_back`: leave the comment unlabelled.
`actionable` yes with `act`: put the comment in the author's checklist for this pull request. `blocking` yes with `act`: hold the merge until the author marks the comment resolved.

## Example

The example state holds a comment about a division that runs before the empty-list guard, with the file and the line it hangs on. It answers `kind` = `defect`, `actionable` yes and `blocking` yes.
