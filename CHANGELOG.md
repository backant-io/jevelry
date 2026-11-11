<a name="0.7.0"></a>
# 0.7.0 (2026-11-11)

The first release with local models.
Numbers are from an M4 Pro with llama.cpp 0.9.0.

### local models

| PR | Type | Description |
| -- | -- | -- |
| #20 | feat | add `install --local` to install and start a local decision model |
| #20 | feat | add `models --local` to list the models that fit this machine |
| #20 | feat | add `stop` to remove the model from memory |
| #20 | feat | add `install --local-url` to use a Jev server that already runs |
| #64 | feat | mark a model as good at 60% of GPU memory or less |
| #64 | feat | select the file with `install --local <id>:Q8_0` or `<id>:Q4_K_M` |
| #65 | perf | use 30 to 39% less memory with Q4_K_M files |
| #29 | feat | warn when a model needs more memory than is free |
| #50 | feat | show Low Power Mode in `models --local` |
| #45 | feat | show the measured speed of each model in `models --local` |
| #62 | feat | rank the models by Jev Decision Index 0.4.1 |
| #62 | feat | add Liquid d1 2B and d1-Omni 2B |
| #43 | feat | offer to remove the previous model file after a model change |
| #56 | fix | exit 5 when a state is too long for the local model |
| #68 | feat | accept 8,192-token states on vLLM-SR d3 and Liquid d1 2B |

### speed

| PR | Type | Description |
| -- | -- | -- |
| #48 | perf | decrease the overhead of a local ask from 34 ms to 8 ms |
| #52 | perf | read the state one time for all questions on Kev and lev |
| #52 | perf | answer three questions on a 7,300-token state in 7.8 s, not 22.7 s |
| #27 | feat | add `--cache` to answer an exact repeat from the log |
| #47 | feat | add `ask --only <names...>` to ask selected questions |
| #40 | perf | remove the examples from `task-difficulty`: 12% fewer tokens |

### footprint

| PR | Type | Description |
| -- | -- | -- |
| #46 | perf | decrease the install from 43 packages to 2 |
| #46 | perf | decrease the package from 1,361 kB to 554 kB |
| #26 | perf | use 71% less server memory for Kev models |
| #42 | fix | stop the growth of the local server log |

### jevels

| PR | Type | Description |
| -- | -- | -- |
| #67 | feat | add `request-route` to send simple requests to a small model |

### measurement

| PR | Type | Description |
| -- | -- | -- |
| #22 | feat | record `ms` in each log line |
| #22 | feat | add `report --speed` with p50, p95 and tokens per second |
| #41 | feat | count cold asks apart from warm asks |
| #23 | feat | add `eval <jevel>`: run the cases, exit 8 on a wrong answer |
| #35 | feat | add `eval --against <file>` to compare two models |
| #38 | feat | add `cases <jevel>` to make cases from reviewed asks |
| #36 | feat | show the overconfidence of each question in `report` |
| #71 | feat | write the thresholds of each model into a `tuned` block |

### upgrade from 0.6.0

- hosted asks and the answer document (protocol 2) do not change
- new log fields: `ms`, `cold`, `request_hash`, `cached_from`
- new commands: `eval`, `cases`, `stop`
- new exit code: 8, from `eval` only
- `T` on the Jevel screen writes into `tuned`, not into the question thresholds
- Node 22 or later, as before
