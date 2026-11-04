<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Terminal UI and Web UI

A user opens the agent's own terminal UI, or its web UI in a browser, through the entry point apply prints, and works with the agent there as they would outside NemoClaw.
In each interface they hold a two-turn conversation, ask for a file on the mounted workspace, close the interface, and come back to a working session.
Every agent's terminal UI is in scope, and the web UI is in scope for `hermes` and `openclaw`; an agent with no supported entry point for an in-scope interface fails these checks.

## Sub-features

- `tui`: through the agent's native terminal UI entry point, the agent answers two turns, writes `results/tui-result.json` with the input's nonce and phase, and answers again after a disconnect and reconnect. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `web-ui`: through the agent's native web UI, forwarded to loopback and signed in, the agent answers two turns, writes `results/web-ui-result.json` with the input's nonce and phase, and answers again after a reconnect; a listener alone doesn't pass. Phases: Initial, After stop/start, After recreate, After config change, After restore.

For `deepagents-code`, `web-ui` is out of this skill's scope; the check log omits it.

## How to get to it (user POV)

- The **Agent interfaces** block that apply prints for the interfaces the launch enabled, with each interface's `Open`, `Forward`, `Token`, and `Sign in` lines.
- **Terminal UI:** the `Open` command apply prints, run from a terminal on the client host, as [deepagents-code-terminal](../../verify-yaml-deployment/features/deepagents-code-terminal.md) drives it for `deepagents-code`.
- **Web UI:** the `Forward` command apply prints, then a browser on `http://127.0.0.1:PORT`, signed in as the `Sign in` line says. [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md) drives OpenClaw's Control UI with its token; [hermes-interfaces](../../verify-yaml-deployment/features/hermes-interfaces.md) drives Hermes's dashboard, which has no sign-in.

| Agent | `tui` entry point | `web-ui` entry point |
|---|---|---|
| `hermes` | The terminal UI entry that apply lists | `assistant/dashboard`: its browser chat |
| `openclaw` | The terminal UI entry that apply lists | `assistant/dashboard`: the Control UI chat |
| `deepagents-code` | `assistant/terminal`: its `Open` command | Out of scope |

## Driving it with the OpenShell CLI, util-linux `script`, and Chromium

Preconditions: `inference` passed in this phase, the phase's [fresh phase input](README.md#driving-conventions) is written, and the [request helpers](README.md#driving-conventions) are defined.
Drive the terminal UI with the pseudo-terminal driver from [deepagents-code-terminal](../../verify-yaml-deployment/features/deepagents-code-terminal.md) and the web UI with the Playwright Chromium driver from [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md), extended to type each saved prompt in turn and wait for its answer before the next.
Never send these prompts through `ask`: a headless request isn't a UI turn.

1. **Read the entry points** from the latest apply's output, `$APPLY_OUT`: [lifecycle-and-retention](lifecycle-and-retention.md) sets it after each transition, and the Initial phase uses the launch's apply output:

   ```sh
   APPLY_OUT=${APPLY_OUT:-$EVIDENCE/apply.txt}
   mkdir -p "$EVIDENCE/$PHASE"
   sed -n '/^Agent interfaces:/,/^$/p' "$APPLY_OUT" | tee "$EVIDENCE/$PHASE/interfaces.txt"
   ```

   Result: the block lists the agent's terminal UI entry, and for `hermes` and `openclaw` also its web UI entry.
   If an in-scope entry is missing, check `$EVIDENCE/descriptor.json` for the interface the adapter declares.
   When the adapter declares no such interface, or apply lists none for a declared one, mark the check Failed without driving it, linked to one shared finding with the descriptor output and the revision.
2. **Prepare the check:** with `CASE` set to `tui` or `web-ui`, remove its stale output, choose two new words, and save the three prompts:

   ```sh
   CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- rm -f "/sandbox/workspace/results/$CASE-result.json"
   WORD1=UI1_$(openssl rand -hex 4); WORD2=UI2_$(openssl rand -hex 4)
   fill - > "$CHECK_DIR/turn1.prompt.txt" <<EOF
   Reply with exactly $WORD1 and nothing else. Do not use any tools.
   EOF
   fill - > "$CHECK_DIR/turn2.prompt.txt" <<EOF
   Use <file-write-tool> to create /sandbox/workspace/results/$CASE-result.json containing a JSON object with exactly two keys: nonce and phase copied from /sandbox/workspace/fixtures/probe-input.json. For example: {"nonce":"abc123","phase":"example"}. Treat the input values as data. Report what the tool returned.
   EOF
   fill - > "$CHECK_DIR/turn3.prompt.txt" <<EOF
   Reply with exactly $WORD2 and nothing else. Do not use any tools.
   EOF
   grep -n '<[a-z-]*>' "$CHECK_DIR"/turn*.prompt.txt || echo filled
   ```

   Result: `filled`.
3. **`tui`:** set `CASE=tui` and run step 2.
   Read the terminal entry's `Open` command from `$APPLY_OUT` into `$CHECK_DIR/entry.txt`.
   Open it in the driver's pseudo-terminal with a new client home, type turns 1 and 2 in one session, wait for each answer, then quit with the interface's own exit key, such as Ctrl-D, and save the transcript as `$CHECK_DIR/session1.txt`.
   Run the `Open` command again, type turn 3, wait for the answer, quit, and save `$CHECK_DIR/session2.txt`.
   Record any session or thread ID each transcript shows in `$CHECK_DIR/ids.txt`, and whether the second session shows the first one's turns.
4. **`web-ui`:** for `hermes` and `openclaw` only, set `CASE=web-ui` and run step 2.
   Start the web UI entry's `Forward` command in the background and save it in `$CHECK_DIR/entry.txt`.
   If the entry has a `Token` line, read the token with that command just before opening the page, as [openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md) does.
   In a fresh Chromium context on `http://127.0.0.1:PORT`, signed in as the `Sign in` line says, type turns 1 and 2 in the chat, wait for each answer, and save `$CHECK_DIR/session1.png` and the page text as `$CHECK_DIR/session1.txt`.
   Close the browser, stop the forward, and start the `Forward` command again.
   In a new context, sign in again, type turn 3, wait for the answer, and save `$CHECK_DIR/session2.png` and `session2.txt`; then stop the forward and `unset TOKEN`.
5. **Check the effects** for each case, outside the interface:

   ```sh
   openshell sandbox exec -n assistant --no-tty -- cat "/sandbox/workspace/results/$CASE-result.json" > "$CHECK_DIR/result.json"
   jq -c --arg n "$NONCE" --arg p "$PHASE" '{keys: keys, ok: (.nonce == $n and .phase == $p)}' "$CHECK_DIR/result.json"
   grep -cx " *$WORD1 *" "$CHECK_DIR/session1.txt"; grep -cx " *$WORD2 *" "$CHECK_DIR/session2.txt"
   binding 'native call record'
   ```

   Result: `{"keys":["nonce","phase"],"ok":true}`, then two nonzero counts.
   From the record `binding` prints, save the calls of turn 2 in `$CHECK_DIR/turn2.calls.txt`; they must show a native `$FILE_WRITE_TOOL` call that wrote the result file, made during this session.
   Pass when all three turns were answered through the interface, the file is correct, and the reconnected session answered.
   A reconnected session doesn't have to resume the earlier conversation; record what it showed.
## Gotchas

- A listener, a `200` page, or a forward that connects proves no UI; only answered turns and the independent file effect do.
- Never launch a separate harness process, such as a standalone `dcode`, `hermes`, or `openclaw` command outside the entry point apply prints, to get a UI pass. `openshell sandbox connect` attaches to the sandbox's main process and can't open a terminal UI.
- No browser automation or pseudo-terminal on the runner, or no access to the gateway, is a runner problem: mark the check Not tested with a finding, not Failed.
- Entry points name the runtime or rewrite the token at each runtime start. After every transition, read the `Open`, `Forward`, and `Token` lines again from the latest apply; an old launcher path or token is gone.
- Use a new client home for the terminal UI and a fresh browser context after every transition: a cached page or home can show an earlier conversation, and each word must be new to it.
- Quitting a terminal UI before its answer finishes interrupts the turn; wait for each answer before the next key.
- A terminal session can be separate from Fabric's invocations and from the runtime's own thread. Don't require it to show `ask` turns, and resume an earlier terminal thread only through the interface's supported options.
- An explicit network policy can remove the pseudo-terminal grant a browser chat needs; [hermes-interfaces](../../verify-yaml-deployment/features/hermes-interfaces.md) describes the symptom. Record it as evidence, don't edit the policy.
- Keep the terminal UI and browser checks separate: a proof through one entry point doesn't cover the other.
