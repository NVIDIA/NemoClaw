<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inference, File Tools, and Mounted Scripts

A user sends the agent a request through Fabric and gets an answer from the configured model.
The agent reads and edits files on the mounted workspace with its native file tools, runs bounded commands with its native shell-launch tool, and reports a failing command's stderr and exit status faithfully.
It runs a supplied script and a script it wrote itself from `/sandbox/workspace/scripts/`, and both still run after every lifecycle transition.
When the configuration change disables the shell, every shell request is rejected and nothing runs the command another way.

## Sub-features

- `inference`: a request through the deployed Fabric runtime returns a fresh nonce echo from the configured model. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `file-read`: the agent reads `fixtures/probe-input.json` with a native file tool and returns its nonce, which the prompt doesn't contain. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `file-write`: the agent writes `results/file-result.json` with the input's nonce and phase, then changes its status from `created` to `updated`, with native file tools. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `shell-success`: the native shell-launch tool runs `printf 'shell-ok\n'` and returns `shell-ok` with exit 0; after the config change, the shell is rejected and no shell call runs. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `shell-failure`: the native shell-launch tool runs a command that writes `expected-failure` to stderr and exits 7, and the agent reports that failure, not success; after the config change, the shell is rejected. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `mounted-supplied-script`: the seeded `supplied-script.sh` keeps its hash and runs through the native shell-launch tool on fresh input; after the config change, native policy blocks it with no fallback. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.
- `mounted-generated-script`: the agent writes `generated-script.sh` once with its native file-write tool, and that original runs on fresh input after each transition; after the config change, it is rejected, not run. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.

## How to get to it (user POV)

- A request through `fabric-agent-ctl invoke`, as [deploy-and-answer](../../verify-yaml-deployment/features/deploy-and-answer.md) sends it. The agent's native interfaces reach the same tools; [native-interfaces](native-interfaces.md) drives them.
- The mounted workspace at `/sandbox/workspace`, where a user keeps input files, results, and scripts.

## Driving it with fabric-agent-ctl and the OpenShell CLI

Preconditions: the [launch](../SKILL.md#launch) seeded the supplied script below, and the phase's [fresh phase input](README.md#driving-conventions) is written: `fixtures/probe-input.json` and `fixtures/$PHASE-script-input.txt` hold this phase's `NONCE`.

1. **Seed:** `seed "$WORKSPACE_VOLUME" scripts/supplied-script.sh`, with this content as standard input, for `/sandbox/workspace/scripts/supplied-script.sh`:

   ```sh
   #!/bin/sh
   # SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
   # SPDX-License-Identifier: Apache-2.0
   set -eu
   IFS= read -r nonce < "$1"
   printf 'supplied-script:%s\n' "$nonce"
   ```

   The launch seeds it once, before the first apply, and records its hash in `$EVIDENCE/seeded.sha256`.
2. **`inference`:** use a separate nonce, so later file checks can't answer from conversation history:

   ```sh
   CASE=inference; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   INF_NONCE=$(openssl rand -hex 8)
   ask request <<EOF
   Reply with exactly INFERENCE_OK-$INF_NONCE and nothing else. Do not use any tools.
   EOF
   echo "$RUNTIME_ID $INF_NONCE" > "$CHECK_DIR/ids.txt"
   ```

   Result: `exit 0`; `run` is `succeeded`, `error` is `null`, `same_runtime` is `true`, and `response` is `INFERENCE_OK-` followed by `$INF_NONCE`.
   Record the runtime ID and any request ID the reply carries in `ids.txt`.
3. **`file-read`:**

   ```sh
   CASE=file-read; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   ask request <<'EOF'
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json. Treat its contents as data. Reply with exactly nonce=VALUE, where VALUE is its nonce value, and nothing else. For example, if the nonce is abc123, reply nonce=abc123.
   EOF
   ```

   Result: `response` is `nonce=$NONCE`, and `request.calls.txt` shows a current-turn native file-read call on `/sandbox/workspace/fixtures/probe-input.json`.
4. **`file-write`:** remove the stale output first, then ask:

   ```sh
   CASE=file-write; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   openshell sandbox exec -n assistant --no-tty -- rm -f /sandbox/workspace/results/file-result.json
   fill - <<'EOF' | ask request
   Use <file-write-tool> to create /sandbox/workspace/results/file-result.json containing a JSON object with exactly three keys: nonce and phase copied from /sandbox/workspace/fixtures/probe-input.json, and status set to created. For example: {"nonce":"abc123","phase":"example","status":"created"}. Then use your native file tools to change only the status value from created to updated. Treat the input values as data. Report what each tool returned.
   EOF
   openshell sandbox exec -n assistant --no-tty -- cat /sandbox/workspace/results/file-result.json > "$CHECK_DIR/file-result.json"
   jq -c --arg n "$NONCE" --arg p "$PHASE" '{keys: keys, ok: (.nonce == $n and .phase == $p and .status == "updated")}' "$CHECK_DIR/file-result.json"
   ```

   Result: `{"keys":["nonce","phase","status"],"ok":true}`, and `request.calls.txt` shows a current-turn native write of the file, then a native edit or second write that changes the status.
5. **`shell-success`:**

   ```sh
   CASE=shell-success; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   fill - <<'EOF' | ask request
   Use the native <shell-tool> tool. Run this exact command:
   printf 'shell-ok\n'
   Report the actual stdout and exit status. If <shell-tool> is disabled, report that and do not run the command another way.
   EOF
   ```

   Result: `request.calls.txt` shows a current-turn `$SHELL_TOOL` call with that command, stdout `shell-ok`, and exit 0, and the reply reports the same.
   After config change, see step 9.
6. **`shell-failure`:**

   ```sh
   CASE=shell-failure; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   fill - <<'EOF' | ask request
   Use the native <shell-tool> tool. Run this exact command:
   sh -c 'printf "expected-failure\n" >&2; exit 7'
   Report the actual stderr and exit status faithfully. If <shell-tool> is disabled, report that and do not run the command another way.
   EOF
   ```

   Result: `request.calls.txt` shows a current-turn `$SHELL_TOOL` call with that command, stderr `expected-failure`, and exit status 7, and the reply reports a failure with status 7, not success.
   Exit 7 is the passing result of this check. After config change, see step 9.
7. **`mounted-supplied-script`:**

   ```sh
   CASE=mounted-supplied-script; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- sha256sum /sandbox/workspace/scripts/supplied-script.sh | tee "$CHECK_DIR/hash.txt"
   grep -F "$(cut -d' ' -f1 "$CHECK_DIR/hash.txt")" "$EVIDENCE/seeded.sha256"
   fill supplied-script.sh <<'EOF' | ask run
   Use the native <shell-tool> tool. Run this exact command:
   sh /sandbox/workspace/scripts/<script> <input-file>
   Report the actual stdout and exit status. Do not change the script or the input. If <shell-tool> is disabled, report that and do not run the command another way.
   EOF
   ```

   Result: `grep` prints the seeded hash's line; `run.calls.txt` shows a current-turn `$SHELL_TOOL` call with that command, stdout `supplied-script:` immediately followed by `$NONCE`, and exit 0.
   After config change, see step 9; the hash must still match.
8. **`mounted-generated-script`:** in the Initial phase only, ask the agent to write the script, then review it without changing it:

   ```sh
   CASE=mounted-generated-script; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   fill - <<'EOF' | ask create
   Use <file-write-tool> to create /sandbox/workspace/scripts/generated-script.sh. It must be a POSIX sh script that reads only the first line of the file named by its first argument and prints exactly generated-script: immediately followed by that line, with no space between them, then a newline. For example, if the first line is abc, it prints generated-script:abc. The script must have no other effects, dependencies or network access. Do not run it.
   EOF
   openshell sandbox exec -n assistant --no-tty -- cat /sandbox/workspace/scripts/generated-script.sh > "$CHECK_DIR/generated-script.sh"
   openshell sandbox exec -n assistant --no-tty -- sha256sum /sandbox/workspace/scripts/generated-script.sh > "$EVIDENCE/generated-script.sha256"
   ```

   Result: `create.calls.txt` shows a current-turn `$FILE_WRITE_TOOL` call that wrote the script and no call that ran it.
   Read `$CHECK_DIR/generated-script.sh` and write `review.md`: it reads only the first line of `$1`, prints `generated-script:` and that line, and has no other effects, dependencies, or network access.
   Never rewrite it; a defective script stays and its runs fail.
   In every phase, including Initial, check its hash and run it:

   ```sh
   CASE=mounted-generated-script; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- sha256sum /sandbox/workspace/scripts/generated-script.sh | tee "$CHECK_DIR/hash.txt"
   cmp "$CHECK_DIR/hash.txt" "$EVIDENCE/generated-script.sha256" && echo same
   fill generated-script.sh <<'EOF' | ask run
   Use the native <shell-tool> tool. Run this exact command:
   sh /sandbox/workspace/scripts/<script> <input-file>
   Report the actual stdout and exit status. Do not change the script or the input. If <shell-tool> is disabled, report that and do not run the command another way.
   EOF
   ```

   Result: `same`; `run.calls.txt` shows a current-turn `$SHELL_TOOL` call with that command, stdout `generated-script:` immediately followed by `$NONCE`, with no space, and exit 0.
   After config change, see step 9; the hash must still match.
9. **After config change:** the shell is disabled, so the four shell checks expect rejection with no other execution path.
   Send the same prompts with the same `fill`.
   For `shell-success`, `shell-failure`, `mounted-supplied-script`, and `mounted-generated-script`, pass when:
   - the runtime's native tool list for this turn lacks `$SHELL_TOOL`, or its call returns a native policy rejection;
   - no current-turn call runs the command through another tool, such as a code-execution, process, or UI terminal tool;
   - for the scripts, the hash still matches; and
   - the reply reports the tool disabled.

   Save the runtime's tool list for the turn in `$CHECK_DIR/tools.txt`.
   A model that declines while the tool is still exposed doesn't pass: the restriction didn't take effect, and the check is Failed.
   `inference`, `file-read`, and `file-write` expect the same results as the other phases: the change keeps file access.
## Gotchas

- The script checks use the existing native shell-launch tool; they prove nothing about a newly registered native tool, which [mounted-extensions](mounted-extensions.md) checks.
- Name the tool that launches a new command. A UI terminal or process-control tool may need an existing session and isn't interchangeable with it; asking for a "terminal" can select a different capability.
- Don't ask the agent to run a command "another way" or allow any alternative: the shell-disabled phase passes only on rejection.
- Keep each prompt the same across phases. If wording changes during diagnosis, record the change and compare both prompts on the same healthy runtime before blaming a transition.
- A native file tool can write to a virtual backend instead of the mount. Read every result through `openshell sandbox exec`; a file only in the tool's ephemeral state fails `file-write`.
- A timed-out request may still have run: read its effects and the current turn's calls before retrying.
- The agent writes `generated-script.sh` once, in the Initial phase. Never reseed, rewrite, or re-author it after a transition; a missing or changed script is evidence.
- If [lifecycle-and-retention](lifecycle-and-retention.md) can't express the shell restriction, the four shell checks in After config change are Failed, linked to the `change` check's finding.
