---
name: alert-cause
version: 1
model: jev-1.13.0
state:
  required: [alert, recent_changes]
  budget_tokens: 10000
questions:
  cause:
    type: choice
    instructions: "What most likely caused `alert`, given `recent_changes`?"
    criteria:
      code_change: "A deploy or a merge in `recent_changes` lines up with the alert in time and touches the area it fires on."
      infrastructure: "A host, a container, a disk, a network path or a certificate, named in the alert or in `recent_changes`."
      external_dependency: "A third party API, a payment provider or another service outside your systems is failing."
      load: "Traffic, queue depth or resource use rose, and the system is doing its normal work slowly."
      unknown: "The alert and the changes give too little to point at any of the four above."
    verdict: { act: 0.75, mark: 0.55 }
  actionable:
    type: noul
    instructions: "Does `alert` give somebody enough to start working on it?"
    criteria:
      true: "The alert names the service, the symptom and when it started."
      false: "The alert is a bare threshold or a line that leaves the symptom open."
    verdict: { act: 0.8, mark: 0.6 }
  same_as_open_incident:
    type: noul
    instructions: "Does `alert` describe the same failure as one of the incidents in `open_incidents`?"
    criteria:
      true: "An open incident covers the same service and the same symptom, so this alert belongs to it."
      false: "The open incidents cover other services or other symptoms, or the list is empty."
    verdict: { act: 0.85, mark: 0.7 }
---
# alert-cause

## When to use

When an alert fires, to give whoever opens it a first hypothesis and to tell it apart from an incident that is already open.

## State

`alert`: `{ "name": "...", "service": "...", "started_at": "...", "detail": "..." }`. `recent_changes`: an array of `{ "at": "...", "kind": "...", "what": "..." }` covering the hours before the alert, narrowed in your code to the systems the alert touches. `open_incidents` is optional and holds the incidents you have open in the same shape as the alert; leave it out or send an empty array when the board is clear, and `same_as_open_incident` answers no.

## Verdicts

`cause` with `act`: put the hypothesis at the top of the alert and link the change it points at. `mark`: put it there and say it is a guess. `fall_back`: open the alert with the changes listed underneath it.
`actionable` no with `act`: send the alert back to the team that owns the rule and ask for the service, the symptom and the start time.
`same_as_open_incident` yes with `act`: attach the alert to that incident and stay silent on the pager.

## Example

The example state holds a 5xx alert on `checkout-api` six minutes after a deploy to the charge path, with an empty incident board. It answers `cause` = `code_change`, `actionable` yes and `same_as_open_incident` no.
