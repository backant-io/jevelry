---
name: run-gate
version: 1
model: jev-1.13.0
questions:
  cause:
    type: choice
    instructions: "What made `test` fail?"
    criteria:
      flaky: "the test fails now and then"
      defect: "the code is wrong"
      other: "anything else"
    thresholds: { act: 0.85, mark: 0.7 }
    run:
      flaky: 'printf "%s %s %s" "$JEVELRY_DECISION" "$JEVELRY_OPTION" "{{retries}} {{loud}}" > "$RUN_OUT/args"; cat > "$RUN_OUT/stdin.json"; cp "$JEVELRY_STATE" "$RUN_OUT/file.json"; echo "$JEVELRY_STATE" > "$RUN_OUT/path"; echo ran; exit 3'
      defect: 'echo "$JEVELRY_STATE" > "$RUN_OUT/path"; sleep 5'
      other: 'read typed < /dev/tty; printf "%s" "$typed" > "$RUN_OUT/tty"' 
  retries:
    type: choice
    instructions: "How many reruns would `test` need?"
    criteria: { "1": "once", "2": "twice" }
  loud:
    type: noul
    instructions: "Does `test` print a lot?"
fall_back: 'echo fell back > "$RUN_OUT/fall_back"'
---
# run-gate

A fixture whose `cause` runs a command that writes what it received into `$RUN_OUT`.
