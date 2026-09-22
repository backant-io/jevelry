# The jevels that ship with jevelry

Sixteen decisions in general shapes, each with the questions, the thresholds and one `example.json` you can ask it with straight away:

    npx jevelry show ticket-triage
    npx jevelry ask ticket-triage --state @jevels/ticket-triage/example.json

| Jevel | When to use it | Questions | State keys |
| --- | --- | --- | --- |
| `alert-cause` | an alert fired and whoever opens it wants a first hypothesis | `cause`, `actionable`, `same_as_open_incident` | `alert`, `recent_changes`, optional `open_incidents` |
| `change-risk` | a pull request before merge, to decide how many eyes it needs | `risk`, `breaking`, `needs_owner_approval` | `change` |
| `checklist-compliance` | a report that claims to follow a checklist | `followed`, `deviation_kind`, `deviation_explained` | `checklist`, `report` |
| `duplicate-issue` | a new issue in your tracker, against the open ones | `same_as` (one per candidate), `actionable` | `issue`, `candidates` |
| `escalation-route` | a request or an incident lands in a shared inbox | `route`, `urgent`, `breaks_a_rule` | `request`, `context` |
| `issue-readiness` | a new issue or proposal before it reaches a backlog | `readiness`, `missing` | `issue` |
| `log-triage` | a burst of log lines, before a person reads them | `kind`, `needs_a_person`, `severity` | `lines`, optional `service` |
| `meeting-notes` | notes after a meeting, for the decision log | `decision_reached`, `owners_assigned`, `follow_up_needed`, `tone` | `notes` |
| `message-triage` | an inbound message in mail or chat | `kind`, `urgency`, `from_a_customer` | `message` |
| `notification-triage` | a batch of notifications collected for one person | `worth_interrupting`, `handle`, `depth` | `person`, `notifications` |
| `pr-description-check` | a pull request description against its diff summary | `describes_the_change`, `mentions_tests`, `leaves_work_out`, `risk_noted` | `pr` |
| `reply-check` | a reply to a question or a report, to close the thread or keep it open | `addresses_it`, `next` | `question`, `reply` |
| `review-comment-kind` | a comment on a pull request, to sort it | `kind`, `actionable`, `blocking` | `comment` |
| `review-quality` | a finished code review, as a whole | `thoroughness`, `constructive`, `found_a_real_defect` | `review` |
| `task-difficulty` | a task before you route it to a model or a person | `depth`, `needs_specialist`, `well_specified` | `task` |
| `ticket-triage` | a new support ticket, before a person reads it | `team`, `urgent`, `frustration` | `ticket` |

Take the one nearest to your decision, copy its folder into your own `jevels/` folder, change the `name` to match the new folder, rewrite the questions and the criteria in the words your state uses, and run `npx jevelry check <name>` until it prints 0 warnings. The thresholds that ship here are a starting point and you move them once the report has a few hundred asks behind it, and the whole method is in `skills/jevelry/references/writing-jevels.md`.
