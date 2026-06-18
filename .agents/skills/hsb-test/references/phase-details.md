# Phase Details — hsb-test

## Phase 0 — Verify board connectivity, demo container readiness, and user setup

**Fast-path skip**: If the session state file exists and contains `_SESSION_VERIFIED=true`, skip this entire phase. See "Subsequent runs in the same session" above.

### Prerequisites

This phase assumes the devkit already has:
- A working SSH connection from the user's machine
- The HSB demo container built and available (from `/hsb-setup` or manual setup)
- The HSB board physically connected and powered

If any of these are missing, **offer to invoke `/hsb-setup`**:

```
The devkit does not appear to have a working HSB setup.
Would you like me to run /hsb-setup to prepare the devkit for QA testing?

If you have a specific SW tag, branch, or local directory to use, provide it now:
  - Tag/branch example: v2.5.0, main, feature/my-branch
  - Local directory example: /home/work/holoscan-sensor-bridge

Type 'setup' to run /hsb-setup, or 'skip' to continue without setup:
```

If the user chooses to run setup, hand off to `/hsb-setup` with the provided tag/branch/directory, then resume Phase 0 after setup completes.

### Steps

1. **Validate SSH connectivity** to the devkit:

   ```bash
   ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
   ```

   If SSH fails, follow the same SSH key auto-remediation flow described in the `hsb-setup` skill.

2. **Initialize the test session** on the remote host:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   mkdir -p /tmp/.claude_hsb_test_session
   echo "export _CLAUDE_CWD=\"__REMOTE_ROOT__\"" > /tmp/.claude_hsb_test_session/state.sh
   echo "test session initialized"
   REMOTE
   ```

3. **Ping the HSB board** at `192.168.0.2`:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "ping -c 4 -W 2 192.168.0.2"
   ```

   If ping fails, inform the user and ask if the board might be at a different IP address.

4. **Verify the demo container image exists**:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_test_session/state.sh 2>/dev/null || true
   cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

   for dir in holoscan-sensor-bridge*; do
       if [ -f "$dir/VERSION" ]; then
           VERSION=$(cat "$dir/VERSION")
           if docker image inspect "hololink-demo:$VERSION" >/dev/null 2>&1; then
               echo "REPO_DIR=$dir"
               echo "VERSION=$VERSION"
               echo "CONTAINER_FOUND=yes"
               break
           fi
       fi
   done
   REMOTE
   ```

   If no demo container is found, offer to run `/hsb-setup` as described in Prerequisites.

5. **Run `hololink enumerate`** inside the demo container to read board identity:

   ```bash
   CONTAINER_NAME="hsb_test_enumerate_$$"
   cd $REPO_DIR
   VERSION=$(cat VERSION)
   docker run -d --name "$CONTAINER_NAME" --rm \
       --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
       -v $PWD:$PWD -v /dev:/dev -w $PWD \
       -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
       -e NVIDIA_VISIBLE_DEVICES=all \
       hololink-demo:$VERSION \
       hololink enumerate

   ( sleep 10; docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null ) &
   WATCHDOG_PID=$!
   docker logs -f "$CONTAINER_NAME" 2>&1 || true
   kill $WATCHDOG_PID 2>/dev/null
   wait $WATCHDOG_PID 2>/dev/null
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

   Parse the output to extract:
   - FPGA version
   - MAC address
   - Serial number
   - Board type — **detect via `fpga_uuid`**:

   | `fpga_uuid` | Board Type |
   |---|---|
   | `889b7ce3-65a5-4247-8b05-4ff1904c3359` | HSB Lattice (CPNX100-ETH-SENSOR-BRIDGE) |
   | `f1627640-b4dc-48af-a360-c55b09b3d230` | Leopard Imaging VB1940 (Eagle Camera) |

   If the UUID matches a known value, set `BOARD_TYPE` to `lattice` or `vb1940`. If the UUID is not reported (older firmware) or is unknown, leave `BOARD_TYPE` empty — step 8 will ask the user.

6. **Verify the release repo** — confirm the repo path and version found in step 4:

   ```bash
   echo "Release repo: $REPO_DIR (HSB version $VERSION)"
   ```

   Save `REPO_DIR` and `VERSION` to the session state.

7. **Detect or confirm the platform** — use `HSB_PLATFORM` environment variable if set; otherwise ask the user:

   ```
   Which NVIDIA devkit platform are you using?
   [1] IGX Orin iGPU
   [2] IGX Orin dGPU
   [3] AGX Orin
   [4] AGX Thor
   [5] DGX Spark

   Select platform [1-5]:
   ```

   Save the result as `HSB_PLATFORM` in the session state.

8. **Detect or confirm the board type** — use the UUID-based detection from step 5 if available. If `BOARD_TYPE` is already set (from UUID), confirm with the user. Otherwise ask:

   ```
   Which HSB board type is connected?
   [1] HSB Lattice (CPNX100-ETH-SENSOR-BRIDGE standalone board)
   [2] Leopard Imaging VB1940 (all-in-one Eagle Camera with integrated FPGA)

   Select board type [1-2]:
   ```

9. **Detect or confirm the connected sensor / camera** — ask the user which sensor(s) are connected to the HSB board. Common configurations:

   ```
   Which sensor(s) / camera(s) are connected?
   [1] Dual IMX274 cameras
   [2] Single IMX274 camera
   [3] VB1940 camera (integral to VB1940 board)
   [4] IMX477 camera
   [5] Other (please specify)

   Select sensor configuration:
   ```

   If the board type is VB1940, default the sensor to "VB1940 camera" and confirm.

   Save the result as `SENSORS` in the session state.

10. **Display results and mark session as verified**:

   ```
   Board and Environment:
   - SSH target: $SSH_TARGET
   - Board IP: 192.168.0.2
   - Release repo: <path> (HSB version X.X.X)
   - Platform: AGX Thor / IGX Orin / ...
   - Board type: HSB Lattice / Leopard Imaging VB1940 (detected via UUID) / unknown
   - FPGA version: XXXX
   - MAC address: XX:XX:XX:XX:XX:XX
   - Sensors: Dual IMX274 / VB1940 camera / ...
   - Demo container: hololink-demo:X.X.X (ready)
   ```

   Append verification flag to session state:

   ```bash
   echo 'export _SESSION_VERIFIED=true' >> /tmp/.claude_hsb_test_session/state.sh
   ```

### Phase 0 summary format

```
**Phase 0 — Verify board connectivity, container readiness, and user setup**
- SSH connectivity to $SSH_TARGET: OK
- Board ping (192.168.0.2): 4/4 packets, 0% loss
- Release repo: /home/work/holoscan-sensor-bridge (HSB vX.X.X)
- Platform: AGX Thor
- Board type: HSB Lattice (detected via UUID)
- FPGA version: XXXX
- Sensors: Dual IMX274
- Demo container: hololink-demo:X.X.X ready
- Status: PASS

Proceed to Phase 1 (obtain test plan and build test list)? [Y/n]
```

## Phase 1 — Obtain test plan, confirm setup, build executable test list

This phase obtains the test plan from the user, confirms the hardware setup collected in Phase 0, and determines which tests can run automatically.

### Step 1 — Obtain the test plan

Ask the user for the test plan source:

```
Please provide the QA test plan. You can provide:
  - A local file path on your machine (e.g., C:\tests\hsb-qa-plan.md)
  - A local file path on the devkit (e.g., /home/work/test-plan.md)
  - A URL to a web page with the test plan (e.g., https://confluence.example.com/hsb-qa)

Type the path or URL:
```

**If a local file path** (on the user's machine): Read the file using the Read tool.

**If a remote file path** (on the devkit): Fetch the file via SSH:
```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "cat <path>"
```

**If a URL**: Fetch the content using the WebFetch tool or ask the user to paste the relevant content.

After reading the test plan, confirm with the user:
```
Test plan loaded: <filename or URL>
Found N test cases in the document.

Type 'yes' to confirm or provide a different source:
```

### Step 2 — Confirm user setup details

**Fast-path skip**: If the session state already contains setup details (`REPO_DIR`, `VERSION`, `HSB_PLATFORM`, `BOARD_TYPE`, `SENSORS`), skip this step entirely. Show a one-line reminder of the cached setup and proceed directly to Step 3.

On a full run, all setup details should already be collected from Phase 0 (release repo, version, platform, board type, and sensors). Display the collected values and ask the user to confirm or correct:

```
Your Setup (from Phase 0):
- Repo path: /home/work/holoscan-sensor-bridge
- HSB version: X.X.X
- Platform: AGX Thor
- Board type: HSB Lattice
- FPGA version: XXXX
- Sensors: Dual IMX274

Type 'yes' to confirm or 'no' to correct:
```

If the user wants to correct any value, re-prompt for that specific item only.

### Step 3 — Analyze the test plan and build executable test list

After the user confirms their setup:

1. **Parse the test plan document** to extract individual test cases. For each test case, identify:
   - Test case ID / name
   - Description / purpose
   - Required hardware (devkit type, board type, sensor type)
   - Required software (HSB version, FPGA version)
   - Test steps / commands to execute
   - Pass/fail criteria (expected output, timing thresholds, error-free execution, specific log patterns)
   - Whether the test is manual or automatable
   - Whether the test requires additional equipment beyond the devkit and HSB board + sensors

2. **Scan the `examples/` directory** on the remote host to map test cases to actual runnable applications:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_test_session/state.sh 2>/dev/null || true
   cd "$REPO_DIR"

   echo "=== Examples directory listing ==="
   find examples/ -name "*.py" -o -name "*.sh" -o -name "README*" | sort

   echo "=== Top-level runnable scripts ==="
   ls -1 *.py 2>/dev/null || true

   echo "=== Example READMEs ==="
   for readme in examples/*/README* examples/*/readme*; do
       if [ -f "$readme" ]; then
           echo "--- $readme ---"
           head -30 "$readme"
           echo ""
       fi
   done
   REMOTE
   ```

3. **Classify each test case** into one of these categories:

   | Category | Description | Action |
   |----------|-------------|--------|
   | **Automatable** | Can run entirely via the demo container, pass/fail criteria can be evaluated from log output | Include in executable test plan |
   | **Manual** | Requires human visual inspection, physical interaction, or subjective judgment | Skip — log as "SKIPPED (manual)" |
   | **Extra equipment** | Requires hardware beyond the devkit + HSB board + connected sensors | Skip — log as "SKIPPED (extra equipment needed)" |
   | **Incompatible** | Requires a different platform, sensor, or FPGA version than the user has | Skip — log as "SKIPPED (incompatible with setup)" |

4. **For each automatable test, determine**:
   - The exact command to run (e.g., `python3 examples/imx274_player.py --headless` — only if user explicitly requested headless)
   - How to evaluate pass/fail from the output (e.g., "no ERROR lines", "pipeline started within 5s", "frames > 0", specific output patterns)
   - Default timeout: 120 seconds (2 minutes) unless the user specified `--timeout` or the test plan specifies a different duration
   - Any test-specific options from the test plan

### Step 4 — Present the executable test plan

Display the test plan for user approval:

```
Executable Test Plan
════════════════════

Setup: AGX Thor | HSB Lattice | Dual IMX274 | FPGA XXXX | HSB vX.X.X

  Automatable Tests (will execute):
  ──────────────────────────────────
  [1] TC-001: IMX274 single camera streaming
      App: examples/imx274_player.py
      Pass criteria: Pipeline starts, frames > 0, no ERROR in log
      Timeout: 120s

  [2] TC-002: Stereo IMX274 streaming
      App: examples/stereo_imx274.py
      Pass criteria: Both cameras produce frames, no ERROR in log
      Timeout: 120s

  [3] TC-003: PTP synchronization test
      App: examples/linux_ptp_player.py
      Pass criteria: PTP lock acquired, frame timestamps monotonic
      Timeout: 120s

  Skipped Tests:
  ──────────────
  [S1] TC-010: Visual quality inspection — SKIPPED (manual)
  [S2] TC-011: External trigger test — SKIPPED (extra equipment needed)
  [S3] TC-015: VB1940 streaming — SKIPPED (incompatible with setup)

  Total: N automatable | M skipped

Type 'yes' to approve and begin testing, or suggest changes:
```

**When `--y` is active**: Skip this approval prompt and proceed with the test plan automatically.

### Phase 1 summary format

```
**Phase 1 — Test plan analysis and preparation**
- Test plan loaded: <source>
- Setup confirmed: <repo path> (HSB vX.X.X) | <platform> | <board type> | <sensors>
- Total test cases in plan: N
- Automatable tests: X
- Skipped (manual): Y
- Skipped (extra equipment): Z
- Skipped (incompatible): W
- Default timeout: 120s per test
- Status: PASS

Proceed to Phase 2 (execute test plan)? [Y/n]
```

## Phase 2 — Execute test plan

This phase runs each automatable test case in sequence, evaluates pass/fail, and handles failures interactively.

### Per-test execution flow

For each test case in the approved test plan:

1. **Announce the test**:

   ```
   ═══════════════════════════════════════════
   Running TC-001: IMX274 single camera streaming
   App: examples/imx274_player.py
   Pass criteria: Pipeline starts, frames > 0, no ERROR in log
   Timeout: 120s
   ═══════════════════════════════════════════
   ```

2. **Pre-test checks**:
   - Ping the board to confirm it's still responsive
   - Stop any conflicting containers:
     ```bash
     docker ps --filter "name=hsb_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
     ```
   - Set up display (do NOT add `--headless` unless the user explicitly requested it):
     ```bash
     DISPLAY_NUM=$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | tr -d 'X')
     export DISPLAY=":${DISPLAY_NUM:-0}"
     xhost +local:docker 2>/dev/null || true
     ```

3. **Run the test application** inside the demo container:

   ```bash
   CONTAINER_NAME="hsb_test_run_$$"
   cd $REPO_DIR
   VERSION=$(cat VERSION)

   docker run -d --name "$CONTAINER_NAME" --rm \
       --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
       -v $PWD:$PWD -v /dev:/dev -w $PWD \
       -v /tmp/.X11-unix:/tmp/.X11-unix \
       -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
       -e NVIDIA_VISIBLE_DEVICES=all \
       -e DISPLAY=$DISPLAY \
       hololink-demo:$VERSION \
       python3 <app_path> <app_options>

   ( sleep $TIMEOUT; docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null ) &
   WATCHDOG_PID=$!
   docker logs -f "$CONTAINER_NAME" 2>&1
   EXIT_CODE=$?
   kill $WATCHDOG_PID 2>/dev/null
   wait $WATCHDOG_PID 2>/dev/null
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

   **IMPORTANT — `--headless` rule**: Never add `--headless` to a test command automatically. Only use `--headless` if the user explicitly requests it. If a DISPLAY-related error occurs, inform the user and ask whether they want to re-run with `--headless`.

4. **Evaluate pass/fail** against the criteria from the test plan:
   - Check exit code (0 = expected for timeout-stopped apps)
   - Search log output for ERROR / CRITICAL / traceback patterns
   - Check for specific pass criteria (e.g., "pipeline started", "frames captured: N > 0")
   - Check for specific fail indicators from the test plan
   - If the app ran for the full timeout without errors, and pass criteria are met → PASS
   - If the app crashed, produced errors, or failed pass criteria → FAIL

5. **Report the result**:

   **If PASS:**
   ```
   TC-001: IMX274 single camera streaming — PASS ✓
   Duration: 120s (timeout)
   Key output: pipeline started, 3600 frames captured, 0 errors
   ```

   **If FAIL:**
   ```
   TC-001: IMX274 single camera streaming — FAIL ✗
   Duration: 3s (crashed)
   Error: ModuleNotFoundError: No module named 'cv2'
   Cause: OpenCV is not installed in the demo container
   Suggestion: Run 'pip install opencv-python-headless' inside the container

   Options:
   [1] Apply the fix and re-run this test
   [2] Skip this test and continue to the next
   [3] Stop testing and go to the report

   Type your choice (1, 2, or 3), or provide your own suggestion:
   ```

6. **Handle user response to failures**:
   - **Fix and re-run**: Apply the suggested fix (or the user's custom fix), re-run the same test, re-evaluate. Track iterations.
   - **Skip**: Mark the test as FAIL in the report and move to the next test.
   - **Stop**: Proceed directly to Phase 3 (report).
   - **User provides a suggestion**: Try to implement the user's suggestion, re-run the test.

   **When `--y` is active**: On failure, log the failure and automatically move to the next test (no interactive debugging).

7. **Cleanup after each test**:
   ```bash
   docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null || true
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

8. **Before starting the next test**, prompt the user (unless `--y` is active):

   ```
   Test TC-001 complete. Proceed to TC-002? Type 'yes' to continue, 'skip' to skip, or 'stop' to end testing:
   ```

### Connectivity-related failures trigger re-verification

If a test failure indicates a connectivity issue (SSH timeout, board ping failure, container launch failure, `No such device` when the device was previously working), clear the session verification flag and inform the user:

```
This failure suggests a connectivity issue. The session verification
will be reset. Re-running Phase 0 to check board and devkit status...
```

Then re-run Phase 0 from scratch. After Phase 0 passes, resume testing from the test that failed.

### Phase 2 summary format

```
**Phase 2 — Test execution**
- Tests executed: X of Y
- Passed: P
- Failed: F
- Skipped during execution: S
- Status: PASS / PARTIAL / FAIL

Proceed to Phase 3 (test results report)? [Y/n]
```

## Phase 3 — Test results report

1. **Generate a comprehensive test results report**:

   ```
   ═══════════════════════════════════════════════════
   HSB QA Test Results Report
   ═══════════════════════════════════════════════════
   Date: YYYY-MM-DD HH:MM:SS
   Operator: $USER
   Test Plan: <source file/URL>

   Environment
   ───────────
   SSH Target     : $SSH_TARGET
   Release Repo   : /home/work/holoscan-sensor-bridge
   HSB Version    : X.X.X
   Platform       : AGX Thor
   Board Type     : HSB Lattice
   FPGA Version   : XXXX
   Sensors        : Dual IMX274
   Demo Container : hololink-demo:X.X.X

   Test Results Summary
   ────────────────────
   | # | Test Case | App | Result | Duration | Notes |
   |---|-----------|-----|--------|----------|-------|
   | 1 | TC-001: IMX274 streaming | imx274_player.py | PASS | 120s | 3600 frames |
   | 2 | TC-002: Stereo streaming | stereo_imx274.py | FAIL | 3s | OpenCV missing |
   | 3 | TC-003: PTP sync test | linux_ptp_player.py | PASS | 120s | PTP locked |
   | - | TC-010: Visual quality | — | SKIPPED | — | Manual test |
   | - | TC-011: External trigger | — | SKIPPED | — | Extra equipment |

   Overall: P PASSED | F FAILED | S SKIPPED of N total

   Failed Test Details
   ───────────────────
   [If no failures:]
   All executed tests passed.

   [If failures:]
   TC-002: Stereo IMX274 streaming — FAIL
     Error    : ModuleNotFoundError: No module named 'cv2'
     Cause    : OpenCV not installed in demo container
     Fix tried: pip install opencv-python-headless
     Outcome  : Re-run passed after fix / Still failed
     Iterations: 2

   Issues Encountered
   ──────────────────
   [If no issues:]
   No issues encountered during testing.

   [If issues:]
   1. <Issue title>
      Symptom    : <what happened>
      Cause      : <root cause>
      Resolution : <how it was fixed>
      Blocking   : Yes / No

   Phase Summary
   ─────────────
   | Phase | Name                    | Status |
   |-------|-------------------------|--------|
   | 0     | Board, container & setup | PASS   |
   | 1     | Test plan & preparation  | PASS   |
   | 2     | Test execution          | PASS   |
   | 3     | Test results report     | PASS   |
   | 4     | Cleanup                 | PASS   |

   Overall Status: PASS / FAIL
   ═══════════════════════════════════════════════════
   ```

2. **Offer to save the report**:

   ```
   Type 'yes' to save this report to a file, or 'no' to skip:
   ```

   If the user agrees:
   - Save to `$REMOTE_ROOT/hsb-test-report-YYYY-MM-DD-HHMMSS.md` on the remote host
   - Also offer to save locally on the user's machine
   - Confirm the saved file path

3. **Ask if the user wants to run another test plan**:

   ```
   Type 'yes' to run another test plan, or 'no' to proceed to cleanup:
   ```

   If yes, loop back to **Phase 1** (test plan intake) using the fast path — Phase 0 and setup confirmation are skipped.

### Phase 3 summary format

```
**Phase 3 — Test results report**
- Report generated
- Results: P passed, F failed, S skipped of N total
- Report saved: [path or "not saved"]
- Status: PASS
```

## Phase 4 — Cleanup

Remove all test session artifacts from the devkit.

### Artifacts to remove

1. **Stop and remove any running test containers**:
   ```bash
   docker ps --filter "name=hsb_test_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
   docker ps -a --filter "name=hsb_test_" --format '{{.Names}}' | xargs -r docker rm -f 2>/dev/null || true
   ```

2. **Remove the test session state directory**:
   ```bash
   rm -rf /tmp/.claude_hsb_test_session
   ```

3. **Remove any temporary test files** created during test execution:
   ```bash
   rm -f /tmp/hsb_test_*.log /tmp/hsb_test_*.tmp 2>/dev/null || true
   ```

### Phase 4 summary format

```
**Phase 4 — Cleanup**
- Test containers stopped and removed
- Session state cleaned up
- Temporary files removed
- Status: PASS

QA testing session complete.
```
