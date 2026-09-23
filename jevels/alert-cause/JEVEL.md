---
name: alert-cause
version: 3
model: jev-1.13.0
state:
  required: [alert, recent_changes]
  budget_tokens: 10000
questions:
  cause:
    type: choice
    instructions:
      question: "What most likely caused `alert`, given `recent_changes`?"
      inspect: "`alert.service` and `alert.detail`, and `recent_changes[].when` with `recent_changes[].kind` and `recent_changes[].what`"
      focus: "Pick the one area the alert detail and the changes point at. A change that landed minutes before the alert and touched the service or the code path the alert names is the strongest signal in the state."
    criteria:
      code_change:
        what: "A deploy, a merge or a config change in `recent_changes` landed shortly before the alert and touched the service or the code path the alert names"
        not_for: "A host, a disk or a certificate that failed, which belongs to infrastructure, or a provider outside your systems, which belongs to external_dependency"
        examples:
          - "deployed the charge path six minutes before the alert"
          - "merged a change to the endpoint the alert names"
          - "turned on a flag in the failing service minutes earlier"
      infrastructure:
        what: "A host, a container, a disk, a network path or a certificate inside your own systems is the part that failed"
        not_for: "A deploy that shipped code minutes earlier, which belongs to code_change, or a provider outside your systems, which belongs to external_dependency"
        examples:
          - "disk usage above 85% on node-7"
          - "the certificate expired at midnight"
          - "pods restarting on one node"
      external_dependency:
        what: "A third party the service calls is failing: a payment provider, a cloud provider or an API outside your systems, and the alert or the changes say so"
        not_for: "Your own host or network, which belongs to infrastructure, or your own deploy, which belongs to code_change"
        examples:
          - "the payment provider status page reports an outage"
          - "calls to the provider time out while our own endpoints answer"
          - "the upstream API returns 503 for every request"
      load:
        what: "Traffic, queue depth or resource use rose, and the system is serving the work slowly or turning it away because there is more of it than the system has room for"
        not_for: "A deploy shortly before the alert that touched the failing path, which belongs to code_change, or a host that failed, which belongs to infrastructure"
        examples:
          - "requests per second tripled in ten minutes"
          - "the queue grew to 40000 jobs"
          - "the connection pool is saturated and latency rose with the traffic"
      unknown:
        what: "The alert detail and the changes name none of the four areas above"
        not_for: "An alert that names one failing area, which belongs to the option that covers that area"
        examples:
          - "a monitor says a threshold was crossed and says nothing more"
          - "the changes list is empty and the detail names no failing part"
    thresholds: { act: 0.75, mark: 0.55 }
  actionable:
    type: noul
    instructions:
      question: "Does `alert.detail` name a symptom a responder can act on?"
      inspect: "`alert.detail`, with `alert.name` for context"
      focus: "A symptom says what is failing and how it shows: the endpoint, the response code, the error, or the work that stopped. A crossed threshold on its own leaves the symptom open."
    criteria:
      true:
        what: "The detail says what is failing and how it shows, so a responder knows where to look"
        examples:
          - "5xx responses rose to 7.1% and every failing response comes from the /charge endpoint"
          - "every charge attempt comes back as a 503 from the payment provider"
          - "the nightly export job exited with status 1"
      false:
        what: "The detail reports a crossed threshold, a monitor number, or a line that leaves open what is failing"
        examples:
          - "Monitor 412 triggered"
          - "value above the configured limit"
    thresholds: { act: 0.8, mark: 0.6 }
  same_as_open_incident:
    type: noul
    instructions:
      question: "Does `alert` describe the same failure as one of the incidents in `open_incidents`?"
      compare: "The service and the symptom in `alert` against the service and the symptom in each incident in `open_incidents`"
      focus: "Treat an empty `open_incidents`, and a state that carries none, as a clear board, and the answer on a clear board is false."
    criteria:
      true:
        what: "One of the incidents in `open_incidents` covers the same service and the same symptom as the alert, so this alert belongs to that incident"
        examples:
          - "the incident is about 502s on api-gateway and the alert is about 502s on api-gateway"
          - "the incident names the same host filling up as the alert"
      false:
        what: "The incidents in `open_incidents` cover other services or other symptoms, or `open_incidents` is an empty array, or the state carries no `open_incidents` at all"
        examples:
          - "the state carries an empty list of open incidents"
          - "the open incident is about the search service and the alert is about the payment provider"
    thresholds: { act: 0.85, mark: 0.7 }
---
# alert-cause

## When to use

When an alert fires, to give whoever opens it a first hypothesis and to tell it apart from an incident that is already open.

## State

`alert`: `{ "name": "...", "service": "...", "started_at": "...", "detail": "..." }`. `recent_changes`: an array of `{ "at": "...", "when": "...", "kind": "...", "what": "..." }`, narrowed in your code to the systems the alert touches and to the hours before `alert.started_at`. `when` is the gap between the change and the alert in words, such as `"six minutes before the alert"` or `"the day before the alert"`, and your code works it out from the two timestamps, because Jev reads a timestamp as text while it reads those words as the gap they name. `at` stays in the record for whoever opens the alert afterwards. `open_incidents` is optional and holds the incidents you have open in the same shape as the alert; leave it out or send an empty array when the board is clear, and `same_as_open_incident` answers no.

## Decisions

`cause` with `act`: put the hypothesis at the top of the alert and link the change it points at. `mark`: put it there and say it is a guess. `fall_back`: open the alert with the changes listed underneath it.
`actionable` no with `act`: send the alert back to the team that owns the rule and ask for the service, the symptom and the start time.
`same_as_open_incident` yes with `act`: attach the alert to that incident and stay silent on the pager.

## Example

The example state holds a 5xx alert on `checkout-api` six minutes after a deploy to the charge path, with an empty incident board. It answers `cause` = `code_change`, `actionable` yes and `same_as_open_incident` no.
