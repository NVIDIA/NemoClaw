<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Control UI Chat and the Hermes Terminal at Runtime Stop

A user opens OpenClaw's Control UI in a browser through the entry point apply prints, holds a two-turn conversation, asks for a file on the mounted workspace, and comes back to a working chat.
A Hermes user with the terminal UI open and a turn in flight sees the terminal end and the turn stop when Fabric stops the runtime.
Fabric owns both: [NVIDIA/NeMo-Fabric#655](https://github.com/NVIDIA/NeMo-Fabric/issues/655) runs OpenClaw's Control UI chat test in its CI, and [NVIDIA/NeMo-Fabric#656](https://github.com/NVIDIA/NeMo-Fabric/issues/656#issuecomment-6971534523) defines and tests the Hermes terminal at stop.
The terminal UIs, Hermes's browser chat, and Hermes's recovery and resume have automated tests; the [recount](https://github.com/NVIDIA/NemoClaw/issues/14573#issuecomment-6971439953) lists them.

## Sub-features

- `web-ui`: OpenClaw only; through the Control UI, forwarded to loopback and signed in, the agent answers two turns, writes `results/web-ui-result.json` with the input's nonce and phase, and answers again after a reconnect; a listener alone doesn't pass. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `hermes-tui-stop`: Hermes only; stopping the managed Fabric runtime ends its open native TUI and cancels its owned in-flight work, invalidates the old runtime and entry point, and preserves already-persisted conversation and files. Phases: Runtime restart.

## How to get to it (user POV)

- The **Agent interfaces** block that apply prints for the interfaces the launch enabled, with each interface's `Open`, `Forward`, `Token`, and `Sign in` lines.
- **Hermes terminal UI:** the `Open` command apply prints, run from a terminal on the client host.
- **OpenClaw Control UI:** the `Forward` command apply prints, then a browser on `http://127.0.0.1:PORT`, signed in with the token as [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md) does.

## Driving it with the OpenShell CLI, util-linux `script`, and Chromium

Preconditions: the agent answered this phase's request, the phase's [fresh phase input](README.md#driving-conventions) is written, and the [request helpers](README.md#driving-conventions) are defined.
Drive the Hermes terminal UI with the pseudo-terminal driver below, which needs util-linux's `script`, and the Control UI with the Playwright Chromium driver from [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md), extended to type each saved prompt in turn and wait for its answer before the next.
Never send these prompts through `ask`: a headless request isn't a UI turn.

`script` gives the terminal UI a 40-by-120 pseudo-terminal, and these shell functions type into it through a FIFO and read the screen from its output file:

```sh
TTY=$EVIDENCE/tty
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

1. **Read the entry points** from the latest apply's output, `$APPLY_OUT`: [lifecycle-and-retention](lifecycle-and-retention.md) sets it after each transition, and the Initial phase uses the launch's apply output:

   ```sh
   APPLY_OUT=${APPLY_OUT:-$EVIDENCE/apply.txt}
   mkdir -p "$EVIDENCE/$PHASE"
   sed -n '/^Agent interfaces:/,/^$/p' "$APPLY_OUT" | tee "$EVIDENCE/$PHASE/interfaces.txt"
   ```

   Result: for `openclaw`, the block lists the Control UI entry; for `hermes`, the terminal UI entry.
   If an in-scope entry is missing, check `$EVIDENCE/descriptor.json` for the interface the adapter declares.
   When the adapter declares no such interface, or apply lists none for a declared one, mark the check Failed without driving it, linked to one shared finding with the descriptor output and the revision.
2. **Prepare the check:** with `CASE=web-ui`, remove its stale output, choose two new words, and save the three prompts:

   ```sh
   CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- rm -f "/sandbox/workspace/results/$CASE-result.json"
   WORD1=UI1_$(openssl rand -hex 4); WORD2=UI2_$(openssl rand -hex 4)
   fill > "$CHECK_DIR/turn1.prompt.txt" <<EOF
   Reply with exactly $WORD1 and nothing else. Do not use any tools.
   EOF
   fill > "$CHECK_DIR/turn2.prompt.txt" <<EOF
   Use <file-write-tool> to create /sandbox/workspace/results/$CASE-result.json containing a JSON object with exactly two keys: nonce and phase copied from /sandbox/workspace/fixtures/probe-input.json. For example: {"nonce":"abc123","phase":"example"}. Treat the input values as data. Report what the tool returned.
   EOF
   fill > "$CHECK_DIR/turn3.prompt.txt" <<EOF
   Reply with exactly $WORD2 and nothing else. Do not use any tools.
   EOF
   grep -n '<[a-z-]*>' "$CHECK_DIR"/turn*.prompt.txt || echo filled
   ```

   Result: `filled`.
3. **`web-ui`:** for `openclaw` only, set `CASE=web-ui` and run step 2.
   Start the web UI entry's `Forward` command in the background and save it in `$CHECK_DIR/entry.txt`.
   If the entry has a `Token` line, read the token with that command just before opening the page, as [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md) does.
   In a fresh Chromium context on `http://127.0.0.1:PORT`, signed in as the `Sign in` line says, type turns 1 and 2 in the chat, wait for each answer, and save `$CHECK_DIR/session1.png` and the page text as `$CHECK_DIR/session1.txt`.
   Close the browser, stop the forward, and start the `Forward` command again.
   In a new context, sign in again, type turn 3, wait for the answer, and save `$CHECK_DIR/session2.png` and `session2.txt`; then stop the forward and `unset TOKEN`.
4. **Check the effects** outside the interface:

   ```sh
   openshell sandbox exec -n assistant --no-tty -- cat "/sandbox/workspace/results/$CASE-result.json" > "$CHECK_DIR/result.json"
   jq -c --arg n "$NONCE" --arg p "$PHASE" '{keys: keys, ok: (.nonce == $n and .phase == $p)}' "$CHECK_DIR/result.json"
   grep -cx " *$WORD1 *" "$CHECK_DIR/session1.txt"; grep -cx " *$WORD2 *" "$CHECK_DIR/session2.txt"
   binding 'native call record'
   ```

   Result: `{"keys":["nonce","phase"],"ok":true}`, then two nonzero counts.
   From the record `binding` prints, save the calls of turn 2 in `$CHECK_DIR/turn2.calls.txt`; they must show a native `$FILE_WRITE_TOOL` call that wrote the result file, made during this session.
   Pass when all three turns were answered through the Control UI, the file is correct, and the reconnected session answered.
   A reconnected session doesn't have to resume the earlier conversation; record what it showed.

## Hermes TUI Across a Fabric Runtime Stop

These are desired-state checks, not a claim that the selected adapter implements them.
Run them around the Runtime restart transition, using the stock Hermes UI through the printed managed entry point.
Normal TUI quit or disconnect retains Hermes's native exit/detach behavior; it is not a Fabric runtime stop.

### Prepare and Observe the Stop

Before lifecycle step 4 stops the runtime, prepare `runtime-restart/hermes-tui-stop/` without changing the transition's `PHASE` or `CHECK_DIR`.
Keep the transition's stop command and evidence in `runtime-restart/transition/` and link it from this check.

1. Resolve and save the selected revision's supported stop completion signal, native session listing/resume mechanism, persistence location, and records correlating runtime, terminal session, turn, tool work, and inference request ownership.
   Use executable help and the image's source; never guess flags or inspect credential-bearing process environments.
   Set finite driver deadlines before starting, based on documented control timeouts where available; record their values and sources.
   Missing supported TUI, stop, or resume behavior is Failed; missing runner instrumentation or inconclusive evidence is Not tested.
2. Open the latest printed TUI entry point in a recorded pseudo-terminal.
   Complete a turn containing a fresh secret-free conversation marker, then a native file-write turn producing a separate run-scoped file on the mounted workspace.
   Save the transcript, session locator, independent file hash, and a consistent read-only snapshot of the persisted session showing the completed marker turn.
   The conversation marker must not appear in the later resume prompt or workspace fixture; recall must come from the prior conversation.
3. Leave that TUI open and start a turn with observable in-flight owned work.
   Use a run-scoped, bounded probe with an explicit started acknowledgement and a runner-controlled release gate before its next effect; save its exact prompt and native call records.
   Establish ownership of work launched through the TUI, including work serviced outside the terminal's process tree.
   Stop only after the started acknowledgement, while the gate is closed; a sleep or a prompt asking the model to be slow does not establish an interrupted turn.
   If the runner cannot safely gate and observe the work, record Not tested rather than claiming cancellation from an idle session.
4. Run lifecycle step 4's supported Fabric stop once, with the terminal still open.
   Record the stop request, completion signal, and terminal exit or EOF with their ordering.
   Completion means the runtime has stopped, not merely that an asynchronous stop request was accepted.
   Pass only if the managed TUI terminates by stop completion and cannot accept another turn; a frozen viewer or lost client connection alone is insufficient.
5. Before recovery, verify the old runtime rejects invocation and the saved entry point cannot start another usable TUI or recreate the stopped runtime.
   Bound both attempts and save their exit status and output.
   Correlate cancellation/termination records for the interrupted turn, tool descendants, and outstanding inference requests with the stop completion boundary.
   Release the probe gate only after that boundary and independently verify that its next effect did not occur and no owned turn, tool, or inference work continues detached.
   Save evidence through the probe's recorded deadline; absence of output for a chosen sleep interval or an orphan-process grep alone cannot pass this assertion.
   Require positive termination/cancellation evidence as well as the absent effect; uncertainty about upstream request cancellation is Not tested, not a pass.
6. Verify the previously persisted completed turn is still readable from a consistent session snapshot and the workspace file has its saved hash.
   The interrupted turn may have a persisted partial record or cancellation status; do not require uncommitted writes, in-memory tokens, or automatic continuation to survive.
   Confirm the sandbox remains running with the same container ID and the gateway and model service remain available with unchanged identities.
   Cancellation applies only to work owned by the stopped runtime, including its managed terminal; never stop shared inference or unrelated sessions/services to pass.

Record `hermes-tui-stop` before lifecycle step 2 recovers the runtime.
If owned work survives, record Failed and clean up only the identified run-owned probe through supported controls before recovery; save cleanup separately from the assertion.
If safe cleanup is unavailable, stop dependent work and report what remains.

## Gotchas

- A listener, a `200` page, or a forward that connects proves no UI; only answered turns and the independent file effect do.
- Never launch a separate harness process, such as a standalone `hermes` or `openclaw` command outside the entry point apply prints, to get a UI pass. `openshell sandbox connect` attaches to the sandbox's main process and can't open a terminal UI.
- No browser automation or pseudo-terminal on the runner, or no access to the gateway, is a runner problem: mark the check Not tested with a finding, not Failed.
- After every transition, read the `Forward` and `Token` lines again from the latest apply, and use a fresh browser context: a cached page can show an earlier conversation, and each word must be new to it.
