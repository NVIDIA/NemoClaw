<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deep Agents Code Terminal

The author enables `harness.settings.interfaces.terminal`, as [docs/agents-inference/interfaces.md](../../../../docs/agents-inference/interfaces.md#open-deep-agents-codes-terminal) documents.
Apply prints the command that opens `dcode`'s terminal UI with the current runtime's launcher, and no forward or token.
In a terminal, the UI uses the configured model and answers a prompt; Ctrl-D quits it.

## Sub-features

- **DT1:** Apply lists `assistant/terminal` under **Agent interfaces** with an `Open` command, its `noexec` form, and `Sign in:  none…`.
- **DT2:** The `Open` command starts `dcode`'s terminal UI on the configured model, which answers a prompt with the requested word.
- **DT3:** Ctrl-D ends the session with exit status 0.
- **DT4:** After a sandbox replacement, the old launcher no longer exists, and the `Open` command from the latest apply works.

## How to get to it (user POV)

- The `Open` command apply prints, run from a terminal on the client host with the gateway and workspace selected; the `sh` form for an artifacts directory mounted `noexec`.
- `openshell sandbox connect` attaches to the sandbox's main process, not a shell, so it can't open the terminal UI.

## Driving it with the OpenShell CLI and util-linux `script`

Preconditions: [deploy-and-answer](deploy-and-answer.md)'s DA1 passed with the agent file's YAML edits; GNU coreutils and sed, and util-linux's `script`, are on the host.

The terminal UI needs a terminal; `script` gives it a 40-by-120 pseudo-terminal, and these shell functions type into it through a FIFO and read the screen from its output file, as the `interfaces_live` test does:

```sh
TTY=$RUN_DIR/tty
# Start COMMAND in a new pseudo-terminal with HOME as its client home.
term_open() {
  rm -rf "$TTY" && mkdir -p "$TTY" && mkfifo "$TTY/in"
  env -u OPENSHELL_GATEWAY HOME="$2" XDG_CONFIG_HOME="$2/.config" \
    script --quiet --flush --return --command "stty rows 40 cols 120 && exec $1" /dev/null \
    < "$TTY/in" > "$TTY/raw" 2>&1 &
  TERM_PID=$!
  exec 3> "$TTY/in"
}
term_mark() { stat -c %s "$TTY/raw"; }
# What the terminal showed after MARK, without control sequences; a carriage return starts a new line.
# The C locale makes [@-~] a byte range; in en_US.UTF-8 it misses letters such as K.
term_shown() {
  tail -c "+$(( ${1:-0} + 1 ))" "$TTY/raw" \
    | LC_ALL=C sed -E 's#\x1b\[[0-?]*[ -/]*[@-~]##g; s#\x1b[]P_^][^\x07\x1b]*(\x07|\x1b\\)##g; s#\x1b[()*+].##g; s#\x1b.##g' \
    | tr '\r' '\n'
}
# Type KEYS into the terminal. The subshell takes the SIGPIPE if the session has ended.
term_send() { kill -0 "$TERM_PID" 2> /dev/null && ( printf '%b' "$1" >&3 ) 2> /dev/null; }
# Wait up to SECONDS for a line after MARK to match the grep -E PATTERN; GREP_FLAGS such as -x apply.
# After the time runs out or the session ends, check once more.
term_wait() {
  local end=$(( $(date +%s) + $3 )) last=
  until term_shown "$1" | LC_ALL=C grep -qE ${4:-} -- "$2"; do
    [ -z "$last" ] || return 1
    [ "$(date +%s)" -lt "$end" ] && kill -0 "$TERM_PID" 2> /dev/null || last=1
    sleep 0.5
  done
}
# Wait up to SECONDS for the session to end, close the input, and set TERM_EXIT to its
# exit status, or to FAIL after killing it. Call it directly, not in $(...): a subshell can't wait for it.
term_close() {
  local i
  for i in $(seq $(( $1 * 2 ))); do kill -0 "$TERM_PID" 2> /dev/null || break; sleep 0.5; done
  exec 3>&-
  if kill -0 "$TERM_PID" 2> /dev/null; then
    kill "$TERM_PID"; wait "$TERM_PID"; TERM_EXIT=FAIL
  else
    wait "$TERM_PID"; TERM_EXIT=$?
  fi
}
```

1. **DT1:**
   ```sh
   sed -n '/^Agent interfaces:/,/^$/p' "$EVIDENCE/apply.txt" | tee "$EVIDENCE/interfaces.txt"
   OPEN=$(sed -n 's|^    Open:     \(openshell sandbox exec .*\)$|\1|p' "$EVIDENCE/apply.txt")
   echo "$OPEN"
   ```
   Result: `assistant/terminal` with `Open:`, the `noexec` form, and `Sign in:  none…`; then `openshell sandbox exec -n assistant --tty -- /sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/interfaces/terminal`.
2. **DT2 and DT3:**
   ```sh
   WORD=TERM$(date +%s | tail -c 7)
   TERMINAL_HOME=$(mktemp -d)
   term_open "$OPEN" "$TERMINAL_HOME"
   # A new home asks for a name and a model; Escape skips both and keeps the configured model.
   term_wait 0 'Enter to continue|Context:' 120 && UI=ok || UI=FAIL
   # A terminal reads Escape followed at once by a key as Alt and that key.
   term_send '\033'; sleep 2
   START=$(term_mark); term_send "Reply with exactly $WORD"
   term_wait "$START" "$WORD" 15
   START=$(term_mark); term_send '\r'
   # The answer is a line holding the word alone; the prompt line also says "Reply with exactly".
   term_wait "$START" "[[:space:]▎▌│●•>]*$WORD[[:space:]▎▌│●•>]*" 200 -x && REPLY_=ok || REPLY_=FAIL
   # Ctrl-D before the answer finishes interrupts the turn, which the UI reports as it quits.
   sleep 3; term_send '\004'
   term_close 30
   term_shown "$START" | grep -q 'Interrupted by user' && REPLY_=FAIL
   term_shown 0 > "$EVIDENCE/terminal-$WORD.txt"
   printf 'ui %s\nreply %s\nexit %s\n' "$UI" "$REPLY_" "$TERM_EXIT" | tee "$EVIDENCE/terminal.txt"
   rm -rf "$TERMINAL_HOME" "$TTY"
   grep -c 'openai:' "$EVIDENCE/terminal-$WORD.txt"
   ```
   Result: `ui ok`, `reply ok`, `exit 0`; then a nonzero count: the status line names the configured model, such as `openai:nemotron-3.5-super-vl`.
3. **DT4:** after [exposure-change](exposure-change.md) replaced the sandbox:
   ```sh
   script --quiet --return --command "$OPEN" /dev/null < /dev/null 2>&1 | tail -1 | tee "$EVIDENCE/old-launcher.txt"
   OPEN=$(sed -n 's|^    Open:     \(openshell sandbox exec .*\)$|\1|p' "$EVIDENCE/change-apply.txt")
   ```
   Result: `No such file or directory` for the old launcher. Then repeat step 2 with the new `$OPEN` and a new word.

## Gotchas

- The first-run screen appears once per runtime home; a second session in the same runtime goes straight to the prompt. The driver accepts either.
- Sending Ctrl-D before the answer finishes interrupts the turn: the transcript then shows `Interrupted by user`, which the driver counts as a failure.
- The terminal's session is separate from Fabric's invocations: it doesn't show them, and the runtime's own thread can't be resumed while the runtime holds it.
- The launcher refuses to start, printing `This NeMo Fabric runtime is not running.`, when the runtime has stopped.
- `dcode` notes that web search is disabled without a Tavily key; that doesn't affect this feature.
