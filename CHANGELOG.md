# Changelog

## 0.7.0

The first release with local models. Everything below was merged after 0.6.0 (1 October 2026). Numbers are from the owner's M4 Pro with llama.cpp 0.9.0; the pull request named after each line has how they were measured.

### Local models

- `jevelry install --local` sets up a Jev-compatible decision model on this machine: it picks one that fits, downloads and verifies it, starts llama.cpp's `llama-server` and asks it one question before it writes the config. `jevelry models --local` lists what fits, with size, memory and speed; `jevelry stop` takes the model out of memory; `install --local-url` uses a Jev server that already runs. (#20)
- `models --local` and `install --local` say when a model needs more memory than is free right now, and `models --local` says when the Mac is in Low Power Mode, where a local model answers at about two thirds of its speed. (#29, #30, #50)
- Once a model has answered, `models --local` shows its measured speed next to the estimate. (#45)
- After a switch to another model, `install --local` offers to remove the previous model's file, and removes the folders made for it when they are empty. (#43, #51)
- A state too long for the local model exits 5 with the advice to filter it. It exited 2 with llama-server's own words. (#56)

### Faster

- Local asks no longer go through Node's `fetch`: what jevelry itself adds to a local ask went from 34 ms to 8 ms. (#48, #49)
- A Kev model's server gets four slots that share one context, so it reads the state once for the questions of an ask and not once for every question. On Kev 0.8B: 20% fewer tokens processed over the shipped examples and cases, and three questions about a 7,300-token state in 7.8 s where they took 22.7 s. What it costs: the fourth decimal of a Kev certainty now depends on what the server was asked before. No value and no decision changed in any run. (#52)
- With `--cache`, `jevel(name, { cache: true })` or `JEVELRY_CACHE=1`, an exact repeat of a local ask is answered from the log in a few milliseconds, without the model loaded. Off unless asked for. `jevelry run` has it too, and an index keeps the lookup fast as the log grows. (#27, #33, #44)
- `ask --only <names...>` asks some of a jevel's questions, so a question that decides whether the others matter can be asked first. (#47)
- The `task-difficulty` jevel ships without examples: 12% fewer tokens, with the same answers and decisions on its cases. (#40)

### Lighter

- Every dependency but TypeSafe's SDK is in the build: an install is 2 packages where it was 43, and the package is 547 kB where it was 1,361 kB. (#24, #42, #46)
- Kev models start with a 512-token ubatch: 71% less server memory, with the same answers. (#26)
- The local server's log no longer grows with every ask. (#42)

### Knowing how fast and how good

- Every answered ask is timed: its log line carries `ms`, and `jevelry report --speed` gives the median, the 95th percentile and the tokens a second for each jevel and model. An ask that waited for a model to load, or woke a sleeping one, is counted apart as cold. (#22, #34, #41)
- `jevelry eval <jevel>` asks a jevel's cases and reports how many were right, with an interval, and exits 8 when one was not. `--against <file>` gives the agreement with a saved run of another model. (#23, #35)
- `jevelry cases <jevel>` turns reviewed asks from the log into cases. (#38)
- `jevelry report` shows how far a question's certainty runs ahead of how often people agreed with it. (#36)

### For those who upgrade from 0.6.0

- An ask of hosted Jev works as before. The answer document is still protocol 2.
- Log lines have new fields, all additions: `ms`, `cold`, `request_hash`, `cached_from`.
- New commands: `eval`, `cases`, `stop`. New exit code: 8, from `eval` only.
- Node 22 or newer, as before.
