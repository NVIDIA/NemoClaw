# Phase Details — hsb-app

## Phase 0 — Verify board connectivity and demo container readiness

**Fast-path skip**: If the session state file exists and contains `_SESSION_VERIFIED=true`, skip this entire phase. See "Subsequent runs in the same session" above.

### Prerequisites

This phase assumes the devkit already has:
- A working SSH connection from the user's machine
- The HSB demo container built and available (from `/hsb-setup` or manual setup)
- The HSB board physically connected and powered

If any of these are missing, instruct the user to run `/hsb-setup` first.

### Steps

1. **Validate SSH connectivity** to the devkit:

   ```bash
   ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
   ```

   If SSH fails, follow the same SSH key auto-remediation flow described in the `hsb-setup` skill.

2. **Initialize the app session** on the remote host:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   mkdir -p /tmp/.claude_hsb_app_session
   echo "export _CLAUDE_CWD=\"__REMOTE_ROOT__\"" > /tmp/.claude_hsb_app_session/state.sh
   echo "app session initialized"
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
   source /tmp/.claude_hsb_app_session/state.sh 2>/dev/null || true
   cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

   # Try to find the HSB repo and its container.
   # Honour HSB_REPO_DIR if set (e.g. "hololink"); otherwise scan common names.
   _SCAN_DIRS="${HSB_REPO_DIR:-holoscan-sensor-bridge* hololink*}"
   for dir in $_SCAN_DIRS; do
       [ -d "$dir" ] || continue
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

   If no demo container is found, inform the user and suggest running `/hsb-setup` first.

5. **Run `hololink enumerate`** inside the demo container to read board identity:

   ```bash
   CONTAINER_NAME="hsb_app_enumerate_$$"
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

   If the UUID matches a known value, set `BOARD_TYPE` to `lattice` or `vb1940`. If the UUID is not reported (older firmware) or is unknown, leave `BOARD_TYPE` empty — Phase 1 will ask the user.

6. **Display results**:

   ```
   Board and Environment:
   - SSH target: $SSH_TARGET
   - Board IP: 192.168.0.2
   - Board type: HSB Lattice / Leopard Imaging VB1940 (detected via UUID) / unknown
   - FPGA version: XXXX
   - MAC address: XX:XX:XX:XX:XX:XX
   - Demo container: hololink-demo:X.X.X (ready)
   ```

7. **Mark session as verified** — append the verification flag to the session state file so subsequent runs in this session can skip Phase 0:

   ```bash
   echo 'export _SESSION_VERIFIED=true' >> /tmp/.claude_hsb_app_session/state.sh
   ```

### Phase 0 summary format

```
**Phase 0 — Verify board connectivity and container readiness**
- SSH connectivity to $SSH_TARGET: OK
- Board ping (192.168.0.2): 4/4 packets, 0% loss
- FPGA version: XXXX
- Board type: HSB Lattice / Leopard Imaging VB1940 (detected via UUID) / unknown
- Demo container: hololink-demo:X.X.X ready
- Status: PASS

Proceed to Phase 1 (discover setup and select application)? [Y/n]
```

## Phase 1 — Discover user setup and select application

This phase interacts with the user to understand their hardware setup, then scans the repository to build a list of compatible applications.

### Step 1 — Gather user setup details

**Fast-path skip**: If the session state already contains setup details (`REPO_DIR`, `VERSION`, `HSB_PLATFORM`, `BOARD_TYPE`, `SENSORS`), skip this step entirely. The saved setup will be used for app filtering. Show a one-line reminder of the cached setup and proceed directly to Step 2.

On a full run, ask the user for the following information. If any can be inferred from Phase 0 results or environment variables, pre-fill and confirm rather than asking from scratch:

1. **HSB software repo location on the devkit**: The path to the cloned holoscan-sensor-bridge repository. Default to `$REMOTE_ROOT/${HSB_REPO_DIR:-holoscan-sensor-bridge}` or the repo found in Phase 0. Confirm with the user.

2. **HSB software version**: Read from the `VERSION` file in the repo root. Display it and confirm.

3. **Platform / devkit**: Use `HSB_PLATFORM` if set, or ask the user:
   - IGX Orin iGPU
   - IGX Orin dGPU
   - AGX Orin
   - AGX Thor
   - DGX Spark

4. **Board type**: Use the UUID-based detection from Phase 0 if available (`BOARD_TYPE` is `lattice` or `vb1940`). Confirm with the user. If Phase 0 did not detect a board type (UUID was absent or unknown), ask the user:
   - HSB Lattice (CPNX100-ETH-SENSOR-BRIDGE standalone board)
   - Leopard Imaging VB1940 (all-in-one Eagle Camera with integrated FPGA)

5. **Connected sensors / cameras**: Ask the user which sensor(s) are connected to the HSB board. Common configurations include:
   - Dual IMX274 cameras
   - Single IMX274 camera
   - VB1940 camera (integral to VB1940 board type)
   - IMX477 camera
   - Other (ask user to specify)

   If the user is unsure, suggest they check the physical board or refer to the user guide.

Display the collected setup summary:

```
Your Setup:
- Repo path: /home/work/holoscan-sensor-bridge
- HSB version: X.X.X
- Platform: AGX Thor
- Board type: HSB Lattice
- FPGA version: XXXX
- Sensors: Dual IMX274

Type 'yes' to confirm or 'no' to correct:
```

### Step 2 — Scan the repository for compatible applications

After the user confirms their setup:

1. **Read the user guide** at `docs/user_guide/` in the repo — particularly sections about running examples, application descriptions, and platform compatibility.

2. **Scan the `examples/` directory** (and any Python scripts at the repo root that are runnable demos) on the remote host:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_app_session/state.sh 2>/dev/null || true
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

3. **Read each example's README or docstring** to determine:
   - What sensor/camera it requires
   - What platform it supports
   - What board type it needs
   - What FPGA version is required (if any)
   - What command-line arguments and options it accepts
   - Brief description of what the app does

4. **Filter the list** based on the user's setup:
   - Exclude apps that require a different sensor than what the user has
   - Exclude apps that require a different platform
   - Exclude apps that require a board type the user doesn't have
   - Apply the **Known app-specific constraints** table below before showing results
   - Mark apps that may work but have unverified compatibility

5. **Known app-specific constraints** — these constraints are authoritative and override anything in the example's README. Apply them in addition to the generic filter rules above.

   | App pattern | Allowed platforms | Allowed board types | Notes |
   |---|---|---|---|
   | `examples/*hwisp*` (e.g. `linux_hwisp_player.py`) | **IGX Orin iGPU**, **AGX Orin** only | any | Uses the Tegra hardware ISP — not available on IGX Orin dGPU, AGX Thor, or DGX Spark. Exclude on those platforms. |
   | `examples/signal_generator*` (and other HSB 100G apps) | any | **HSB 100G only** | This is an HSB 100G application. **Never** display it as an option for HSB Lattice or VB1940 boards. |

   **HSB 100G app filter**: When the user's `BOARD_TYPE` is `lattice` or `vb1940`, exclude every app tagged as an HSB 100G application from the list — do not even show them under "possibly compatible". If future apps are added that are HSB 100G-specific, add them to the table above.

### Step 3 — Present the application list and let user choose

Display the filtered list:

```
Compatible Applications for Your Setup:
═══════════════════════════════════════

  [1] examples/imx274_player.py
      Camera viewer for IMX274 sensors
      Sensors: IMX274 | Platform: All | Container: Yes

  [2] examples/stereo_imx274.py
      Stereo vision with dual IMX274 cameras
      Sensors: Dual IMX274 | Platform: All | Container: Yes

  [3] examples/linux_ptp_player.py
      PTP-synchronized camera capture
      Sensors: IMX274 | Platform: All | Container: Yes

  ── Possibly compatible (unverified) ──

  [4] examples/latency_test.py
      Board latency measurement tool
      Sensors: Any | Platform: All | Container: Yes

Enter the number of the application to run, or type 'info N' for details:
```

When the user selects an app:

1. **Show the app's full details** — description, command-line options, default values, and any special requirements:

   ```
   Selected: examples/imx274_player.py
   ────────────────────────────────────
   Description: Displays live video from an IMX274 camera connected to the HSB board.

   Options:
     --headless          Run without display (useful over SSH)
     --width N           Frame width (default: 1920)
     --height N          Frame height (default: 1080)
     --fps N             Target framerate (default: 30)

   Special requirements:
     - Requires DISPLAY or --headless when user requests headless mode
     - Requires IMX274 camera on sensor port 0

   Type 'defaults' to run with default settings, or 'customize' to set options:
   ```

   **When `--y` is active**: Skip this prompt entirely and use default settings automatically.

2. **If the user chooses to customize**, present each option and let them set values.

3. **Ask for `--timeout`**: How long to run the app:

   ```
   How long should the app run?
     - Enter a number of seconds (e.g., 30, 60, 120)
     - Type 'none' for no timeout (runs until you ask to stop)
   ```

   **When `--y` is active**: Skip this prompt and use the `--timeout` value from the command line, or default to 30 seconds if no `--timeout` was provided.

   If no timeout is set (interactive mode), inform the user:
   ```
   The app will run until you tell me to stop it.
   To stop the app, type: "stop the app" or "stop" or "quit"
   ```

### Phase 1 summary format

```
**Phase 1 — Setup discovery and application selection**
- User setup confirmed: [platform], [board], [sensors]
- HSB version: X.X.X
- Compatible apps found: N
- Selected app: examples/xxxxx.py
- App options: [defaults / custom values]
- Timeout: [N seconds / no timeout]
- Status: PASS

Proceed to Phase 2 (run the application)? [Y/n]
```

## Phase 2 — Run application with monitoring and debugging

This phase launches the selected application, monitors its output, handles failures, and supports iterative debugging with the user.

### Step 1 — Pre-run checks

1. **Ping the board** to confirm it's still responsive.

2. **Stop any conflicting containers** that might hold shared ports:

   ```bash
   docker ps --filter "name=hsb_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
   ```

3. **Set up display** for GUI apps:

   ```bash
   DISPLAY_NUM=$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | tr -d 'X')
   export DISPLAY=":${DISPLAY_NUM:-0}"
   xhost +local:docker 2>/dev/null || true
   ```

   **IMPORTANT — `--headless` rule**: Never add `--headless` to an application command automatically. Only use `--headless` if the user explicitly requests it. If a DISPLAY-related error occurs, inform the user of the issue and ask whether they want to re-run with `--headless` — do not add it on their behalf.

### Step 2 — Launch the application

Run the app inside the demo container using the detached + log pattern:

```bash
CONTAINER_NAME="hsb_app_run_$$"
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
```

**If `--timeout` is set** (N seconds):

```bash
# Watchdog: force-stop after N seconds
( sleep $TIMEOUT; docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null ) &
WATCHDOG_PID=$!
docker logs -f "$CONTAINER_NAME" 2>&1
EXIT_CODE=$?
kill $WATCHDOG_PID 2>/dev/null
wait $WATCHDOG_PID 2>/dev/null
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

**If no timeout** (run indefinitely until user asks to stop):

```bash
# Stream logs continuously
docker logs -f "$CONTAINER_NAME" 2>&1 &
LOG_PID=$!

# Inform user how to stop
echo "App is running. Tell me to 'stop' when you want to end it."
```

When the user asks to stop:

```bash
docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
kill $LOG_PID 2>/dev/null || true
```

### Step 3 — Monitor and analyze output

While the app is running (or after it completes):

1. **Stream output** to the user (concise mode: show key lines; verbose mode: full output).

2. **Detect success indicators**: Frames rendered, data received, "pipeline started", etc.

3. **Detect failure indicators**: Tracebacks, `ERROR`, `CRITICAL`, segfaults, timeouts, `Address already in use`, `No such device`, etc.

### Step 4 — Failure analysis and iterative debugging

If the app fails or produces errors:

1. **Analyze the log output** and identify the root cause. Common failure categories:

   | Failure Pattern | Likely Cause | Suggested Fix |
   |----------------|-------------|---------------|
   | `ImportError` / `ModuleNotFoundError` | Missing Python dependency | Install inside container or rebuild |
   | `No such device` / `Device not found` | Sensor not detected or app/sensor mismatch — VB1940 cameras require VB1940-compatible apps; running an IMX274-only app against a VB1940 always causes this error | Run `hololink enumerate` to verify board and sensor detection; if sensor type doesn't match the app, switch to the correct app for the detected sensor. Do NOT suggest editing driver or kernel code. |
   | `Address already in use` | Port conflict from previous run | Stop conflicting container |
   | `DISPLAY` errors / segfault in GL | No display over SSH | Ask user if they want to re-run with `--headless` (never add automatically) |
   | `Timeout waiting for data` | Board communication failure | Check network config, ping board |
   | `FPGA version mismatch` | App requires different FPGA | Run `/hsb-flash` to update |
   | `Permission denied` | Docker or device access | Check docker group, device permissions |
   | Python `SyntaxError` / `TypeError` | Code bug or version mismatch | Suggest code edit |
   | `CUDA error` / `GPU not found` | GPU configuration issue | Check `nvidia-smi`, container runtime |

2. **Present the diagnosis** to the user:

   ```
   Application failed — analysis:
   ───────────────────────────────
   Error: ModuleNotFoundError: No module named 'cv2'
   Cause: OpenCV is not installed in the demo container
   Suggested fix: Run 'pip install opencv-python-headless' inside the container

   Would you like me to:
   [1] Apply the fix and re-run the app
   [2] Show the full error log
   [3] Skip and proceed to the report
   ```

3. **If the user chooses to fix and re-run**:

   - Apply the fix (install package, edit code, change environment, etc.)
   - For **code edits**: Show the proposed change as a diff and ask for confirmation before applying:
     ```
     Proposed code edit in examples/imx274_player.py:
     Line 42:
     -   sensor = hololink.sensors.imx274(port=0)
     +   sensor = hololink.sensors.imx274(port=0, timeout=10)

     Apply this change? Type 'yes' to apply or 'no' to skip:
     ```
   - Re-run the app with the same options
   - Track the fix in the issues log for the Phase 3 report

4. **Connectivity-related failures trigger re-verification**: If the failure analysis identifies a connectivity issue (SSH timeout, board ping failure, container launch failure, `No such device` when the device was previously working), clear the session verification flag and inform the user:

   ```
   This failure suggests a connectivity issue. The session verification
   will be reset. Re-running Phase 0 to check board and devkit status...
   ```

   Then re-run Phase 0 from scratch. After Phase 0 passes, resume at app selection (Phase 1 Step 2).

5. **Allow multiple debug iterations**: The user can keep debugging and re-running until the app works or they decide to move on. Each iteration is tracked.

6. **If the user wants to run a different app**, loop back to app selection in Phase 1 Step 2 (fast path — skip Phase 0 and setup discovery).

### Step 5 — Cleanup after app run

After the app completes (success or failure) and the user is done:

```bash
docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

### Phase 2 summary format

```
**Phase 2 — Application execution**
- App: examples/xxxxx.py
- Run duration: X seconds / until stopped
- Result: SUCCESS / FAILURE
- Debug iterations: N
- Fixes applied: [list or "none"]
- Status: PASS / FAIL

Proceed to Phase 3 (session report)? [Y/n]
```

## Phase 3 — Session report

1. **Generate a comprehensive report** covering the entire session:

   ```
   ========================================
   HSB Application Runner — Session Report
   ========================================
   Date: YYYY-MM-DD HH:MM:SS
   Operator: $USER

   Environment
   -----------
   SSH Target     : $SSH_TARGET
   Platform       : AGX Thor
   Board Type     : HSB Lattice
   FPGA Version   : XXXX
   HSB Version    : X.X.X
   Sensors        : Dual IMX274
   Demo Container : hololink-demo:X.X.X

   Application Run
   ----------------
   App            : examples/xxxxx.py
   Options        : [options used]
   Timeout        : [N seconds / no timeout]
   Duration       : X seconds
   Result         : SUCCESS / FAILURE

   Debug Iterations
   -----------------
   [If no iterations:]
   App ran successfully on first attempt.

   [If iterations:]
   Iteration 1:
     Error    : <error description>
     Cause    : <root cause>
     Fix      : <what was done>
     Outcome  : Fixed / Not fixed

   Iteration 2:
     ...

   Code Edits Applied
   -------------------
   [If no edits:]
   No code edits were made.

   [If edits:]
   1. File: examples/xxxxx.py, Line 42
      Change: Added timeout parameter to sensor init
      Reason: Default timeout too short for the board's response time

   Issues Encountered
   -------------------
   [If no issues:]
   No issues encountered during the session.

   [If issues:]
   1. <Issue title>
      Symptom    : <what happened>
      Cause      : <root cause>
      Resolution : <how it was fixed>
      Blocking   : Yes / No

   Phase Summary
   --------------
   | Phase | Name                          | Status |
   |-------|-------------------------------|--------|
   | 0     | Board connectivity & container | PASS   |
   | 1     | Setup discovery & app select  | PASS   |
   | 2     | Application execution         | PASS   |
   | 3     | Session report                | PASS   |

   Overall Status: SUCCESS
   ========================================
   ```

2. **Offer to save the report**:

   ```
   Type 'yes' to save this report to a file, or 'no' to skip:
   ```

   If the user agrees:
   - Save to `$REMOTE_ROOT/hsb-app-report-YYYY-MM-DD-HHMMSS.md` on the remote host
   - If running locally, save to the current directory
   - Confirm the saved file path

3. **Ask if the user wants to run another app**:

   ```
   Type 'yes' to run another application, or 'no' to finish:
   ```

   If yes, loop back to **Phase 1 Step 2** (app scanning and selection) using the fast path — Phase 0 and Phase 1 Step 1 are skipped because the session is already verified. If no, proceed to session teardown.

4. **Session teardown**:

   ```bash
   # Stop any remaining app containers
   docker ps --filter "name=hsb_app_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true

   # Clean up session state
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_app_session"
   ```

### Phase 3 summary format

```
**Phase 3 — Session report**
- Report generated
- Report saved: [path or "not saved"]
- Status: PASS
```
