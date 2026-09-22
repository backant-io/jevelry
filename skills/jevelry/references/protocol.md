# The protocol

`jevelry ask` writes exactly one JSON document on stdout, pretty printed with two spaces and one
trailing newline, and nothing else. Diagnostics go to stderr, each line prefixed with `jevelry: `.
On exit 0 the document is the answer document below; on any other exit it is the error document.
The schema is `docs/protocol/ask.schema.json` in the package, with one example per answer type.

## The answer document

| Field | Type | What it is |
|---|---|---|
| `protocol` | `1` | the version of this document; fields are added, never renamed or removed |
| `log_id` | string or null | the id of the log line for this ask, and the id `outcome` takes; null with `--no-log` or when the log could not be written |
| `jevel` | object or null | `{ "name": ..., "version": ... }`, null for a `--questions` ask |
| `model` | string | the model that answered, for example `jev-1.13.0` |
| `state_hash` | string | `sha256:` and 64 hex characters over the canonical JSON of the state as sent |
| `answers` | object | question name to answer; a `repeat` question is named `<question>[0]`, `<question>[1]` and so on |
| `usage` | object | `{ "input_tokens": ..., "output_tokens": ... }`, integers |

Every answer carries `type`, `certainty` (0 to 1) and `verdict` (`act`, `mark` or `fall_back`),
plus the fields of its own type.

### `noul`

| Field | Type | What it is |
|---|---|---|
| `noul` | number 0 to 1 | the probability that the condition is true |
| `yes` | boolean | `noul >= 0.5` |
| `certainty` | number 0 to 1 | the distance from indifference, `max(noul, 1 - noul)` |

### `choice`

| Field | Type | What it is |
|---|---|---|
| `choice` | string | the option with the highest probability |
| `probabilities` | object | one number per option, by option name |
| `confidence` | number 0 to 1 | how sure the model is of the option it picked |
| `certainty` | number 0 to 1 | the confidence, repeated as the value the verdict was computed from |

### `score`

| Field | Type | What it is |
|---|---|---|
| `score` | number | the level, which can land between two levels |
| `legend` | object | the level index to its description, as the jevel wrote it |
| `probabilities` | object | one number per level index |
| `confidence` | number 0 to 1 | how sure the model is of the level |
| `certainty` | number 0 to 1 | the confidence, repeated as the value the verdict was computed from |

## The error document

    { "protocol": 1, "error": { "exit": 3, "code": "rate_limited", "message": "TypeSafe answered 429 after the SDK's retries", "retry_after_ms": 1200 } }

`error` carries `exit`, `code` and `message` always. `retry_after_ms` is there only when the
server gave a delay. `field` is there only when jevelry itself knows the field at fault, so a
`bad_input` that came from the API carries a message and no field.

| Code | Exit | What happened |
|---|---|---|
| `bad_input` | 2 | the jevel or the state is wrong; `field` names it when jevelry found it |
| `rate_limited` | 3 | rate limited after the SDK's retries |
| `overloaded` | 3 | TypeSafe answered 529 after the SDK's retries |
| `auth` | 4 | the key is missing or refused; no request was made when it was missing |
| `over_budget` | 5 | the estimate is over a limit; no request was made |
| `transport` | 6 | the network, a timeout, or anything no other code covers |
| `unreadable_answer` | 7 | TypeSafe answered a shape this build cannot read |

Exit 0 is an answer and exit 1 is a usage error from the command line, which prints no document.
