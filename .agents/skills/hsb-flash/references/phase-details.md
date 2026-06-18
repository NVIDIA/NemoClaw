# Phase Details — hsb-flash

### Phase 0 — Token-budget preflight

This phase is mandatory and must run before any SSH connection, repo checkout, container build, flash preparation, or hardware-changing command. Keep the preflight output concise — show only the key parameters (estimate, available budget, result). Do not dump all resolved environment variables.

1. **Estimate the full-run token budget** for the entire flash workflow, not just the next phase. The values below are conservative heuristics, not measured historical usage. Treat them as initial safety budgets and refine them from actual `/hsb-flash` run logs once measured token usage is available:
   - Reserve at least **180,000 tokens** for a single-step flash.
   - Reserve at least **260,000 tokens** for a two-step Lattice flash or when the transition is not yet known.
   - Add **50,000 tokens** when `--verbose`, undocumented FPGA handling, release-notes lookup, or extra troubleshooting is expected.
   - Use the larger estimate if the current board type, current FPGA version, or target FPGA version is not yet known.

2. **Check remaining usage** using the best available Claude Code/account usage source for the current subscription plan. Prefer machine-readable or product-provided usage data when available. If no reliable usage source is available, ask the user to provide their current remaining usage/quota from the Claude Code account or plan UI.

   When asking the user because usage cannot be self-verified, present the options in this exact order so the safe stop choices appear first:
   1. **I can't verify — stop**: The user cannot determine remaining usage. Stop before Phase 1.
   2. **I have < {estimate} available — stop**: The user checked their plan/account UI and confirms less than the estimated budget remains. Stop before Phase 1.
   3. **I have ≥ {estimate} available — proceed**: The user checked their plan/account UI and confirms at least the estimated budget remains. Proceed to Phase 1.
   4. **Type something**: Treat as a question or free-form instruction, answer it, then re-prompt with the same ordered options.

   Do not put the proceed option first. The user must intentionally move past the stop choices before selecting proceed.

3. **Display the result to the user** before continuing:

   ```text
   Token-budget preflight
   - Estimated tokens required for complete /hsb-flash run: <estimate>
   - Estimate basis: conservative heuristic; refine from actual run logs when available
   - Safety margin included: <margin>
   - Remaining plan usage available: <available or "unverified">
   - Result: PASS / FAIL
   ```

4. **Stop on insufficient or unverifiable budget**:
   - If remaining usage is lower than the estimate, stop before Phase 1 and explain that the skill is refusing to start because it may run out of tokens during a hardware-critical flash workflow.
   - If remaining usage cannot be verified, stop before Phase 1 and ask the user to start a fresh session, upgrade/refresh usage, or provide verifiable remaining usage.
   - `--force` and `--y` must not bypass this preflight.

### Phase 1 — Verify board connectivity, detect board type, and read current FPGA version

#### Prerequisites

This phase assumes the devkit already has:
- A working SSH connection from the user's machine
- The HSB demo container built and available (from `/hsb-setup` or manual setup)
- The HSB board (Lattice or VB1940) physically connected and powered

If any of these are missing, instruct the user to run `/hsb-setup` first or complete manual setup before proceeding.

#### Steps

1. **Validate SSH connectivity** to the devkit:

   ```bash
   ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
   ```

   If SSH fails, follow the same SSH key auto-remediation flow described in the `hsb-setup` skill. Do not proceed until SSH is working.

2. **Initialize the flash session** on the remote host:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   mkdir -p /tmp/.claude_hsb_flash_session
   echo "export _CLAUDE_CWD=\"__REMOTE_ROOT__\"" > /tmp/.claude_hsb_flash_session/state.sh
   echo "flash session initialized"
   REMOTE
   ```

3. **Ping the HSB board** at `192.168.0.2`:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "ping -c 4 -W 2 192.168.0.2"
   ```

   If ping fails, inform the user and ask if the board might be at a different IP address. Do not proceed until the board is reachable.

4. **Scan for an existing HSB repo** on the devkit (from a prior `/hsb-setup` or manual setup):

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   echo "=== Scanning for existing HSB repos ==="
   EXISTING_REPO_DIR=""
   EXISTING_REPO_VERSION=""
   EXISTING_DEMO_IMAGE="false"

   # Check common locations for an HSB repo
   for candidate in \
       "$HOME/holoscan-sensor-bridge" \
       "__REMOTE_ROOT__/holoscan-sensor-bridge" \
       "$HOME/hsb" \
       "__REMOTE_ROOT__/hsb"; do
       if [ -f "$candidate/VERSION" ] && [ -d "$candidate/.git" ]; then
           EXISTING_REPO_DIR="$candidate"
           EXISTING_REPO_VERSION=$(cat "$candidate/VERSION")
           break
       fi
   done

   # Also check if there's a repo path stored in a prior hsb-setup session
   if [ -z "$EXISTING_REPO_DIR" ] && [ -f /tmp/.claude_hsb_setup_session/state.sh ]; then
       source /tmp/.claude_hsb_setup_session/state.sh 2>/dev/null || true
       if [ -n "${_REPO_DIR:-}" ] && [ -f "${_REPO_DIR}/VERSION" ]; then
           EXISTING_REPO_DIR="$_REPO_DIR"
           EXISTING_REPO_VERSION=$(cat "$_REPO_DIR/VERSION")
       fi
   fi

   if [ -n "$EXISTING_REPO_DIR" ]; then
       echo "Found existing HSB repo: $EXISTING_REPO_DIR (version $EXISTING_REPO_VERSION)"
       # Check if its demo container image exists
       if docker image inspect "hololink-demo:$EXISTING_REPO_VERSION" >/dev/null 2>&1; then
           EXISTING_DEMO_IMAGE="true"
           echo "Demo container image hololink-demo:$EXISTING_REPO_VERSION exists"
       else
           echo "Demo container image hololink-demo:$EXISTING_REPO_VERSION NOT found"
       fi
   else
       echo "No existing HSB repo found on devkit"
   fi

   echo "EXISTING_REPO_DIR=$EXISTING_REPO_DIR"
   echo "EXISTING_REPO_VERSION=$EXISTING_REPO_VERSION"
   echo "EXISTING_DEMO_IMAGE=$EXISTING_DEMO_IMAGE"
   REMOTE
   ```

   Parse the output and save `EXISTING_REPO_DIR`, `EXISTING_REPO_VERSION`, and `EXISTING_DEMO_IMAGE` to the session state. If no repo is found, these remain empty/false — Phase 3 will fall back to the v2.0.0 approach.

   If a repo is found, inform the user:
   ```
   Detected existing HSB repo: <path> (version <version>)
   Demo container: available / not available
   This may be used for flashing if the transition is supported (see Phase 3).
   ```

5. **Read the current FPGA version** using one of two methods:

   **Method A — `hololink enumerate` inside the demo container** (preferred):

   Run `hololink enumerate` inside the existing demo container and parse the FPGA version from the output. Use the detached container pattern with a 10-second watchdog. If an existing repo was found in step 4, use its container; otherwise look for any available demo container:

   ```bash
   CONTAINER_NAME="hsb_flash_enumerate_$$"
   cd ${EXISTING_REPO_DIR:-$REPO_DIR}
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

   Parse the FPGA version from the enumerate output (look for `fpga_version` or a version field like `24XX`).

   **Method B — Read register 0x80**:

   If Method A fails or the demo container is not available, attempt to read register 0x80 from the board using hololink tools inside the demo container to extract the FPGA version:

   ```bash
   CONTAINER_NAME="hsb_flash_regread_$$"
   docker run -d --name "$CONTAINER_NAME" --rm \
       --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
       -v $PWD:$PWD -v /dev:/dev -w $PWD \
       -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
       -e NVIDIA_VISIBLE_DEVICES=all \
       hololink-demo:$VERSION \
       python3 -c "
   import hololink
   # Read register 0x80 to get FPGA version
   # Adapt the exact API call based on what is available in the installed version
   "

   timeout 15 docker logs -f "$CONTAINER_NAME" 2>&1 || true
   docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

   **Method C — `hololink --force fpga_version`** (fallback for FPGA 2407):

   If both Method A and Method B fail, the board may be running FPGA 2407, which is incompatible with `hololink enumerate` in v2.0.0+ software. Try reading the FPGA version directly:

   ```bash
   CONTAINER_NAME="hsb_flash_fpgaver_$$"
   docker run -d --name "$CONTAINER_NAME" --rm \
       --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
       -v $PWD:$PWD -v /dev:/dev -w $PWD \
       -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
       -e NVIDIA_VISIBLE_DEVICES=all \
       hololink-demo:$VERSION \
       hololink --force fpga_version

   timeout 15 docker logs -f "$CONTAINER_NAME" 2>&1 || true
   docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

   **Method D — Retry with v2.0.0 repo and container** (Lattice boards only):

   If Methods A, B, and C all fail and the board type is Lattice (or not yet determined), the existing repo's container may be too new or incompatible with the board's firmware. Fall back to HSB release repo v2.0.0, which supports the oldest FPGA versions (2407, 2412):

   1. Checkout the v2.0.0 release repo on the devkit if it is not already present:
      ```bash
      V2_REPO_DIR="/home/nvidia/hsb-flash-workspace/holoscan-sensor-bridge-v2.0.0"
      if [ ! -d "$V2_REPO_DIR" ]; then
          git clone --branch v2.0.0 --depth 1 \
              https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git \
              "$V2_REPO_DIR"
      fi
      ```

   2. Build the v2.0.0 demo container if the image does not exist:
      ```bash
      V2_VERSION=$(cat "$V2_REPO_DIR/VERSION")
      if ! docker image inspect "hololink-demo:$V2_VERSION" >/dev/null 2>&1; then
          cd "$V2_REPO_DIR"
          sh docker/build.sh --igpu   # or --dgpu based on platform
      fi
      ```

   3. Retry `hololink enumerate` with the v2.0.0 container:
      ```bash
      CONTAINER_NAME="hsb_flash_v2enum_$$"
      cd "$V2_REPO_DIR"
      docker run -d --name "$CONTAINER_NAME" --rm \
          --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
          -v $PWD:$PWD -v /dev:/dev -w $PWD \
          -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
          -e NVIDIA_VISIBLE_DEVICES=all \
          hololink-demo:$V2_VERSION \
          hololink enumerate

      ( sleep 10; docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null ) &
      WATCHDOG_PID=$!
      docker logs -f "$CONTAINER_NAME" 2>&1 || true
      kill $WATCHDOG_PID 2>/dev/null
      wait $WATCHDOG_PID 2>/dev/null
      docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
      ```

   4. If enumerate still fails, retry with `hololink --force fpga_version` in the v2.0.0 container:
      ```bash
      CONTAINER_NAME="hsb_flash_v2fpgaver_$$"
      docker run -d --name "$CONTAINER_NAME" --rm \
          --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
          -v $PWD:$PWD -v /dev:/dev -w $PWD \
          -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
          -e NVIDIA_VISIBLE_DEVICES=all \
          hololink-demo:$V2_VERSION \
          hololink --force fpga_version

      timeout 15 docker logs -f "$CONTAINER_NAME" 2>&1 || true
      docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
      docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
      ```

   5. If v2.0.0 successfully detects the FPGA version, save the v2.0.0 repo as available for later use (add to `INTERIM_REPOS` for cleanup in Phase 6). If the v2.0.0 container had to be built, note this so Phase 3 does not rebuild it.

   Inform the user when falling back to v2.0.0:
   ```
   Board enumeration failed with the existing container.
   Falling back to HSB release repo v2.0.0 for board detection...
   ```

   If Method D also fails (v2.0.0 enumerate and fpga_version both return no result), **assume the current FPGA version is 2407** (the oldest supported version). Alert the user that the FPGA version could not be read from the board even with the v2.0.0 container, and that 2407 is being assumed as the starting point for the flash procedure. Continue with this assumed version.

6. **Validate the detected FPGA version** against known versions.
   - For Lattice boards: 2407, 2412, 2507, 2510 (documented), plus any version newer than 2412 (undocumented — handled via release notes lookup)
   - For VB1940 cameras: 2507, 2510 (documented), plus any version newer than 2510 (undocumented — handled via release notes lookup)

   If the version matches a known version, proceed normally. If the version is newer than the latest documented version for the board type but not in the known list, accept it and inform the user that it will be handled as an undocumented FPGA version (see "Handling undocumented FPGA versions"). If the version does not match any known version and is not newer than the latest documented version, warn the user and display the raw version value. If `--force` is not set, ask the user to confirm the closest matching version or provide it manually. If `--force` is set, warn the user but accept the detected version and continue (the user will still choose the target version in Phase 2). Do not proceed without a confirmed or accepted current version.

7. **Detect and confirm the board type**: Determine from the enumerate output whether the board is an **HSB Lattice** board or a **Leopard Imaging VB1940** camera.

   The `hololink enumerate` output and the `fpga_uuid` field in the manifest help distinguish boards:
   - **Lattice boards** use `fpga_uuid` `889b7ce3-65a5-4247-8b05-4ff1904c3359`
   - **VB1940 cameras** use `fpga_uuid` `f1627640-b4dc-48af-a360-c55b09b3d230`

   Also look for keywords in the enumerate output: "leopard", "VB1940", "eagle" suggest a VB1940; "lattice", "CPNX100-ETH-SENSOR-BRIDGE" suggest a Lattice board.

   If the board type cannot be determined automatically, **ask the user to confirm** which board type is connected:

   ```
   Could not automatically determine the board type. Please confirm:
   [1] HSB Lattice (CPNX100-ETH-SENSOR-BRIDGE standalone board)
   [2] Leopard Imaging VB1940 (all-in-one Eagle Camera with integrated FPGA)
   ```

   Save the detected board type as `BOARD_TYPE` (`lattice` or `vb1940`) in the session state. This determines which flash commands, manifest files, and FPGA version lists are available.

   **CRITICAL**: If the user confirms a board type, trust their confirmation. But warn them that using the wrong board type's flash command **can brick the device**.

8. **Display the results**:

   ```
   Board information:
   - IP Address: 192.168.0.2
   - MAC Address: XX:XX:XX:XX:XX:XX
   - Current FPGA version: XXXX (or "2407 (assumed — could not read from board)" if read failed)
   - Serial Number: XXXXXXXX (if available)
   - Board Type: HSB Lattice (confirmed) / Leopard Imaging VB1940 (confirmed)

   Existing HSB repo: <path> (version X.X.X) / not found
   Demo container:    available / not available
   ```

#### Phase 1 summary format

```
**Phase 1 — Verify board connectivity, board type, and FPGA version**
- SSH connectivity to $SSH_TARGET: OK
- Board ping (192.168.0.2): 4/4 packets, 0% loss
- Current FPGA version: XXXX
- Board type: HSB Lattice / Leopard Imaging VB1940 (confirmed)
- Existing HSB repo: <path> (vX.X.X) / none detected
- Status: PASS

Proceed to Phase 2 (select target FPGA version)? [Y/n]
```

### Phase 2 — Select target FPGA version

1. **Present the available FPGA versions** based on the detected board type:

   **For Lattice boards:**
   ```
   Available FPGA versions for HSB Lattice:

   [1] 2407
   [2] 2412
   [3] 2507
   [4] 2510 (latest documented)

   Current FPGA version: XXXX

   Enter target FPGA version number, type 'latest' for 2510,
   or enter a newer FPGA version (e.g. 2601) to check for a matching release:
   ```

   **For VB1940 cameras:**
   ```
   Available FPGA versions for Leopard Imaging VB1940:

   [1] 2507
   [2] 2510 (latest documented)

   Current FPGA version: XXXX

   Enter target FPGA version number, type 'latest' for 2510,
   or enter a newer FPGA version to check for a matching release:
   ```

2. **Validate the user's choice**:

   - **Lattice (documented versions)**: `2407`, `2412`, `2507`, `2510` are always accepted.
   - **Lattice (undocumented versions)**: Any version newer than 2412 that is not in the documented list is accepted and flagged for the undocumented FPGA version handling procedure (see "Handling undocumented FPGA versions"). Versions older than 2407 or between documented versions (e.g., 2409) are rejected.
   - **VB1940 (documented versions)**: `2507`, `2510` are always accepted.
   - **VB1940 (undocumented versions)**: Any version newer than 2510 that is not in the documented list is accepted and flagged for the undocumented FPGA version handling procedure (see "Handling undocumented FPGA versions"). Versions older than 2507 or equal to 2407/2412 are rejected (VB1940 does not support these).
   - `latest` maps to `2510` for both board types (or to the newest documented version if the skill has been updated with a newer release)
   - If the user enters an invalid version, show an error and the list of valid versions for the detected board type, then re-prompt
   - **CRITICAL**: If a VB1940 user requests 2407 or 2412, refuse and explain these versions are not supported on VB1940 cameras (they only support 2507 and 2510)
   - If the target version equals the current version **and `--force` is not set**, inform the user that no flashing is needed and ask if they want to re-flash anyway (some users may want to re-flash the same version for recovery purposes). If `--force` is set, proceed with the re-flash without asking.

3. **Determine the flashing procedure** using the decision tree defined in "Flashing procedure logic" above:
   - **Lattice**: May be single-step or two-step (via gateway 2412). Determine direction (upgrade/downgrade) since it affects which repos are used in two-step cases.
   - **VB1940**: Always single-step

4. **Display the planned procedure summary**:

   **For Lattice single-step upgrade:**
   ```
   Flashing Plan:
   - Board type: HSB Lattice
   - Direction: Upgrade / Re-flash
   - Type: Single-step
   - Transition: CURRENT → TARGET
   - Flash repo: vX.X.X (matches target FPGA)
   - Power cycle required after flashing
   ```

   **For Lattice single-step downgrade:**
   ```
   Flashing Plan:
   - Board type: HSB Lattice
   - Direction: Downgrade
   - Type: Single-step
   - Transition: CURRENT → TARGET
   - Flash repo: vX.X.X (matches current FPGA)
   - Power cycle required after flashing
   ```

   **For Lattice two-step downgrade:**
   ```
   Flashing Plan:
   - Board type: HSB Lattice
   - Direction: Downgrade
   - Type: Two-step (via gateway version 2412)
   - Step 1: CURRENT → 2412 (using repo matching current FPGA)
   - Step 2: 2412 → TARGET (using v2.0.0)
   - Power cycle required after each step
   ```

   **For Lattice two-step upgrade:**
   ```
   Flashing Plan:
   - Board type: HSB Lattice
   - Direction: Upgrade
   - Type: Two-step (via gateway version 2412)
   - Step 1: CURRENT → 2412 (using v2.0.0, matches target 2412)
   - Step 2: 2412 → TARGET (using repo matching target FPGA)
   - Power cycle required after each step
   ```

   **For VB1940:**
   ```
   Flashing Plan:
   - Board type: Leopard Imaging VB1940
   - Type: Single-step (direct flash from existing repo)
   - Transition: CURRENT → TARGET
   - Manifest: manifest_leopard_cpnx100.yaml (from vX.X.X)
   - Flash command: program_leopard_cpnx100 (inside demo container)
   - Power cycle required after flashing
   ```

#### Phase 2 summary format

```
**Phase 2 — Target version selection**
- Board type: HSB Lattice / Leopard Imaging VB1940
- Current FPGA version: XXXX
- Target FPGA version: YYYY
- Flashing procedure: [single-step / two-step via 2412]
- Status: PASS

Proceed to Phase 3 (prepare flash scripts and YAML files)? [Y/n]
```

### Phase 3 — Prepare flash scripts and YAML files

This phase determines the flash infrastructure and prepares all needed files. The approach depends on the board type:

- **Lattice boards**: Checkout the HSB release repo required for flashing (target FPGA's repo for upgrades, current FPGA's repo for downgrades — if not already present), copy and patch the target manifest YAML, and extract the flash command from the repo's user guide.
- **VB1940 cameras**: Use the existing repo directly (mandatory — no v2.0.0 fallback).

#### VB1940 Path (when `BOARD_TYPE=vb1940`)

When the board is a VB1940, the procedure is simpler — the existing repo is always used:

1. **Verify the existing repo is available** (`EXISTING_REPO_DIR` is non-empty and `EXISTING_DEMO_IMAGE` is `true`). If not found, stop and instruct the user to run `/hsb-setup` first.

2. **Set flash variables**:

   ```bash
   FLASH_REPO_DIR="$EXISTING_REPO_DIR"
   FLASH_REPO_VERSION="$EXISTING_REPO_VERSION"
   ```

3. **Copy the correct VB1940 manifest** from this skill's bundled files to the repo:

   ```bash
   # Back up the original manifest
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET \
       "cp $FLASH_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml \
           $FLASH_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml.backup 2>/dev/null || true"

   # Copy the target manifest
   scp $REMOTE_SSH_OPTS <local_skill_path>/scripts/<version>/manifest_leopard_cpnx100.yaml \
       $SSH_TARGET:$FLASH_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml
   ```

   Where `<version>` is `v2.3.0` for FPGA 2507 or `v2.5.0` for FPGA 2510.

4. **Set the flash command**:

   ```bash
   FLASH_COMMAND="program_leopard_cpnx100 scripts/manifest_leopard_cpnx100.yaml"
   ```

   The `program_leopard_cpnx100` tool is installed inside the demo container. No `sudo` is needed when running inside the container.

5. **Skip to "Common step — Present the detailed flashing plan"** below.

#### Lattice Path — Checkout required repo and prepare flash

For Lattice boards, the skill uses the HSB release repo determined by the flash direction: the **target FPGA version's repo** for upgrades, or the **current FPGA version's repo** for downgrades. Follow these steps:

1. **Look up the required repo version** from the "Lattice board FPGA versions" table (YAML Source Release column). For upgrades, look up the target FPGA version; for downgrades, look up the current FPGA version.

2. **Check if an existing repo matches**. If the user's existing HSB repo on the devkit (`EXISTING_REPO_DIR`) is the same version as the required repo, use it directly. Otherwise, clone the required version into a new directory:

   ```bash
   REQUIRED_REPO_VERSION="<version from mapping>"

   if [ "$EXISTING_REPO_VERSION" = "$REQUIRED_REPO_VERSION" ]; then
       FLASH_REPO_DIR="$EXISTING_REPO_DIR"
       FLASH_REPO_VERSION="$EXISTING_REPO_VERSION"
       echo "✔ Existing repo at $EXISTING_REPO_DIR (v$EXISTING_REPO_VERSION) matches required version."
   else
       cd $REMOTE_ROOT
       FLASH_WORKSPACE="hsb-flash-workspace"
       mkdir -p "$FLASH_WORKSPACE"
       CLONE_DIR="$REMOTE_ROOT/$FLASH_WORKSPACE/holoscan-sensor-bridge-v$REQUIRED_REPO_VERSION"

       if [ ! -d "$CLONE_DIR/.git" ]; then
           git clone --branch $REQUIRED_REPO_VERSION --depth 1 \
               https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git \
               "$CLONE_DIR"
       fi

       FLASH_REPO_DIR="$CLONE_DIR"
       FLASH_REPO_VERSION=$(cat $FLASH_REPO_DIR/VERSION)
       INTERIM_REPOS="$CLONE_DIR"
       echo "ℹ Checked out HSB v$REQUIRED_REPO_VERSION at $CLONE_DIR"
   fi
   ```

   If `git lfs` is available, run `git lfs pull` inside the checkout to ensure all binary assets are present.

3. **For two-step flashing**, ensure the repos for both steps are available:

   - **Two-step downgrade** (current > 2412, target = 2407): Step 1 uses the flash repo (from step 2 above, matching the current FPGA). Step 2 needs v2.0.0. If the flash repo is already v2.0.0, no additional checkout is needed. Otherwise, clone v2.0.0:

     ```bash
     V200_DIR="$REMOTE_ROOT/$FLASH_WORKSPACE/holoscan-sensor-bridge-v2.0.0"
     if [ ! -d "$V200_DIR/.git" ]; then
         git clone --branch 2.0.0 --depth 1 \
             https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git \
             "$V200_DIR"
     fi
     STEP2_REPO_DIR="$V200_DIR"
     STEP2_REPO_VERSION=$(cat $V200_DIR/VERSION)
     INTERIM_REPOS="$INTERIM_REPOS $V200_DIR"
     ```

   - **Two-step upgrade** (current = 2407, target > 2412): Step 1 uses v2.0.0 (target 2412's repo — which is already the flash repo since FPGA 2407 maps to v2.0.0). Step 2 uses the repo corresponding to the final target FPGA version. Look up the target in the FPGA-to-repo mapping and checkout that repo:

     ```bash
     # Step 1 repo is already $FLASH_REPO_DIR (v2.0.0)
     # Step 2 needs the target FPGA's repo
     TARGET_REPO_VERSION="<version from FPGA-to-repo mapping for TARGET>"
     STEP2_DIR="$REMOTE_ROOT/$FLASH_WORKSPACE/holoscan-sensor-bridge-v$TARGET_REPO_VERSION"
     if [ ! -d "$STEP2_DIR/.git" ]; then
         git clone --branch $TARGET_REPO_VERSION --depth 1 \
             https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git \
             "$STEP2_DIR"
     fi
     STEP2_REPO_DIR="$STEP2_DIR"
     STEP2_REPO_VERSION=$(cat $STEP2_DIR/VERSION)
     INTERIM_REPOS="$INTERIM_REPOS $STEP2_DIR"
     ```

4. **Copy the correct manifest YAML** from this skill's bundled `scripts/` directory (see "Bundled manifest YAML files" tree above) to the flash repo's `scripts/manifest.yaml`:

   ```bash
   # Back up the original manifest
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET \
       "cp $FLASH_REPO_DIR/scripts/manifest.yaml \
           $FLASH_REPO_DIR/scripts/manifest.yaml.backup"

   # Copy the target manifest to the flash repo
   scp $REMOTE_SSH_OPTS <local_skill_path>/scripts/<version>/manifest*.yaml \
       $SSH_TARGET:$FLASH_REPO_DIR/scripts/manifest.yaml
   ```

   For a two-step procedure, the manifest is replaced between steps (step 1 uses one manifest from the flash repo, step 2 uses a different manifest in the v2.0.0 repo).

5. **Patch the manifest YAML** if it is missing `fpga_uuid` or has a mismatched UUID (see "YAML manifest patching" section).

6. **Verify the demo container** for the flash repo is ready:

   ```bash
   docker image inspect hololink-demo:$FLASH_REPO_VERSION >/dev/null 2>&1 && echo "Container ready" || echo "Container not found"
   ```

   If the container does not exist, build it:

   ```bash
   cd $FLASH_REPO_DIR
   sh docker/build.sh --igpu   # or --dgpu based on platform
   ```

   For two-step flashing, also verify/build the v2.0.0 container.

7. **Study the flash repo's documentation** — read `docs/user_guide/` in the flash repo and extract the **exact flash command** for this version. The command syntax varies between HSB releases; do NOT assume a fixed command. Look for the section on FPGA flashing/programming and note the full command line including all arguments.

   **Add `--force` and `--accept-eula`** to ensure non-interactive execution, but use the correct flag placement for the repo version:
   - **v2.0.0**: `hololink --force program scripts/manifest.yaml --accept-eula` (--force before subcommand, --accept-eula after)
   - **v2.3.1+**: Append `--force --accept-eula` after all arguments

   Also verify the correct flag positions by running `hololink --help` and `hololink program --help` inside the container. Save the assembled command as `FLASH_COMMAND` in the session state.

   For two-step flashing:
   - **Two-step downgrade**: Also read the v2.0.0 user guide and extract its flash command with v2.0.0 flag placement (save as `STEP2_FLASH_COMMAND`).
   - **Two-step upgrade**: Step 1 uses v2.0.0 (with v2.0.0 flag placement). Step 2 uses the repo corresponding to the target FPGA version — read that repo's user guide and extract the flash command with the appropriate flag placement for that version (save as `STEP2_FLASH_COMMAND`).

#### Common step — Present the detailed flashing plan

6. **Present the detailed flashing plan** to the user.

   For each flash step, display:
   - Source version → target version
   - The exact flash command that will be executed (as read from the repo's user guide)
   - YAML file path and which release it comes from
   - Whether a power cycle is required after this step

   Every plan opens and closes with the same approval banner (shown in the first example). Subsequent examples show only the unique body fields and steps; the opening header and closing approval prompt are the same format.

   **Example for a Lattice single-step upgrade (2507 → 2510, uses target FPGA's repo v2.5.0):**

   ```
   ================================================================
   FLASHING PLAN — Requires your approval before proceeding
   ================================================================

   Board type:   HSB Lattice
   Current FPGA: 2507
   Target FPGA:  2510
   Procedure:    Single-step upgrade
   Flash repo   : /home/nvidia/hsb-flash-workspace/holoscan-sensor-bridge-v2.5.0 (v2.5.0, matches target FPGA 2510)

   ── Step 1 of 1: Flash 2507 → 2510 ──────────────────────────────
   Manifest     : scripts/v2.5.0/manifest.yaml (FPGA 2510, from release v2.5.0)
   Command      : <exact command from v2.5.0 user guide> --force --accept-eula
   Container    : hololink-demo:2.5.0
   After step   : Power cycle board, verify FPGA = 2510

   ================================================================
   WARNING: Flashing modifies FPGA firmware permanently.
   Do you approve this flashing plan? [Y/n]
   ================================================================
   ```

   **Example for a Lattice two-step downgrade (2510 → 2407, repo v2.5.0 for step 1, v2.0.0 for step 2):**

   *(opening header and closing approval prompt same as above — body differs:)*
   ```
   Board type:   HSB Lattice
   Current FPGA: 2510
   Target FPGA:  2407
   Direction:    Downgrade
   Procedure:    Two-step (via gateway version 2412)
   Flash repo   : /home/nvidia/holoscan-sensor-bridge (v2.5.0, matches current FPGA 2510)
   Step 2 repo  : /home/nvidia/hsb-flash-workspace/holoscan-sensor-bridge-v2.0.0

   ── Step 1 of 2: Flash 2510 → 2412 ──────────────────────────────
   Manifest     : scripts/v2.0.0/manifest.yaml (FPGA 2412, from release v2.0.0)
   Command      : <exact command from v2.5.0 user guide> --force --accept-eula
   Container    : hololink-demo:2.5.0
   After step   : Power cycle board, verify FPGA = 2412

   ── Step 2 of 2: Flash 2412 → 2407 ──────────────────────────────
   Manifest     : scripts/v2.0.0/manifest-2407.yaml (FPGA 2407, from release v2.0.0)
   Command      : hololink --force program scripts/manifest.yaml --accept-eula
                   (v2.0.0 flag placement: --force before subcommand)
   Container    : hololink-demo:<v2.0.0-VERSION>
   After step   : Power cycle board, verify FPGA = 2407
                   (uses hololink --force fpga_version — enumerate not compatible with 2407)
   ```
   *(Approval prompt — same format as the single-step example above.)*

   **Example for a Lattice two-step upgrade (2407 → 2507, v2.0.0 for step 1, v2.3.1 for step 2):**

   *(opening header and closing approval prompt same as above — body differs:)*
   ```
   Board type:   HSB Lattice
   Current FPGA: 2407
   Target FPGA:  2507
   Direction:    Upgrade
   Procedure:    Two-step (via gateway version 2412)
   Step 1 repo  : /home/nvidia/hsb-flash-workspace/holoscan-sensor-bridge-v2.0.0 (v2.0.0, matches target 2412)
   Step 2 repo  : /home/nvidia/hsb-flash-workspace/holoscan-sensor-bridge-v2.3.1 (v2.3.1, matches target 2507)

   ── Step 1 of 2: Flash 2407 → 2412 ──────────────────────────────
   Manifest     : scripts/v2.0.0/manifest.yaml (FPGA 2412, from release v2.0.0)
   Command      : hololink --force program scripts/manifest.yaml --accept-eula
                   (v2.0.0 flag placement: --force before subcommand)
   Container    : hololink-demo:<v2.0.0-VERSION>
   After step   : Power cycle board, verify FPGA = 2412

   ── Step 2 of 2: Flash 2412 → 2507 ──────────────────────────────
   Manifest     : scripts/v2.3.1/manifest.yaml (FPGA 2507, from release v2.3.1)
   Command      : <exact command from v2.3.1 user guide> --force --accept-eula
   Container    : hololink-demo:<v2.3.1-VERSION>
   After step   : Power cycle board, verify FPGA = 2507

   Note: Step 1 uses v2.0.0 (target 2412's repo). Step 2 uses v2.3.1
   (target 2507's repo). Each step uses the flash command and flag
   placement from its own repo version.
   ```
   *(Approval prompt — same format as the single-step example above.)*

   **Example for a VB1940 flash (2507 → 2510):**

   *(opening header and closing approval prompt same as above — body differs:)*
   ```
   Board type:   Leopard Imaging VB1940
   Current FPGA: 2507
   Target FPGA:  2510
   Procedure:    Single-step (direct flash from existing repo)
   Flash repo   : /home/nvidia/holoscan-sensor-bridge (v2.5.0)

   ── Step 1 of 1: Flash 2507 → 2510 ──────────────────────────────
   Manifest     : scripts/v2.5.0/manifest_leopard_cpnx100.yaml
                  (FPGA 2510, from release v2.5.0)
   Command      : program_leopard_cpnx100 scripts/manifest_leopard_cpnx100.yaml
   Container    : hololink-demo:<version>
   After step   : Power cycle camera, verify FPGA = 2510

   Note: VB1940 uses program_leopard_cpnx100 (NOT program_lattice_cpnx100).
   The command runs inside the demo container from the repo root.
   No sudo is needed inside the container.
   ```
   *(Approval prompt — same format as the single-step example above.)*

   **Do not continue to Phase 4 without explicit user approval of the flashing plan.**

#### Phase 3 summary format

```
**Phase 3 — Flash preparation**
- Board type: <HSB Lattice / Leopard Imaging VB1940>
- Flash repo(s): <path(s)> with version(s) and which FPGA they match
- Interim repos checked out: <none / list>
- Manifest YAML copied and patched for <N> step(s)
- Flash command(s) extracted from user guide(s) (with --force --accept-eula)
- Demo container(s): ready
- Status: PASS

The flashing plan has been presented above.

Proceed to Phase 4 (execute flashing)? [Y/n]
```

Adapt the bullet points to the specific scenario (single-step vs two-step, upgrade vs downgrade, Lattice vs VB1940). For two-step, list both repos and note the gateway version.

### Phase 4 — Execute flashing procedure

**CRITICAL: This phase modifies FPGA firmware. Execute with extreme care.**

**CRITICAL: Verify the board type before executing any flash command. NEVER run `program_leopard_cpnx100` on a Lattice board or `program_lattice_cpnx100` on a VB1940 — this can permanently brick the device.**

#### Pre-flash verification

Before any flash operation, perform these checks:

1. **Ping the board** to confirm it is active and responsive:

   ```bash
   ping -c 4 -W 2 192.168.0.2
   ```

   If ping fails, STOP. Do not attempt to flash a board that is not responding.

2. **Read the current FPGA version** using the same method as Phase 1 (try `hololink enumerate` first; if it fails and the board is expected to be at 2407, fall back to `hololink --force fpga_version`). Verify it matches what was originally detected. If it does not match **and `--force` is not set**, STOP and alert the user — the board state may have changed since Phase 1. If `--force` is set, warn the user about the mismatch but continue with the flash using the newly detected version as the starting point (re-evaluate the flashing steps if the transition path changes).

3. **Confirm board type** matches what was detected in Phase 1. If the board type appears to have changed (e.g., different fpga_uuid), STOP and alert the user.

#### Single-step flashing procedure

If only one flash step is needed (always the case for VB1940, and for many Lattice transitions):

1. **Announce the flash operation**:

   **For Lattice:**
   ```
   Starting flash: CURRENT → TARGET
   Board type: HSB Lattice
   Using YAML from vX.X.X
   Flash command: <FLASH_COMMAND> (from <repo version> user guide)
   This may take several minutes. Do not disconnect the board or interrupt power.
   ```

   **For VB1940:**
   ```
   Starting flash: CURRENT → TARGET
   Board type: Leopard Imaging VB1940
   Manifest: manifest_leopard_cpnx100.yaml (from vX.X.X)
   Flash command: program_leopard_cpnx100 (inside demo container)
   This may take several minutes. Do not disconnect the camera or interrupt power.
   ```

2. **Run the flash command** inside the flash repo's demo container:

   Use the **exact command extracted from the repo's user guide in Phase 3** (`$FLASH_COMMAND`). The command varies between HSB releases — never assume a fixed command. Run it in a named detached container with a generous timeout (flashing can take 5-15 minutes):

   ```bash
   CONTAINER_NAME="hsb_flash_step1_$$"
   cd $FLASH_REPO_DIR
   docker run -d --name "$CONTAINER_NAME" --rm \
       --net host --gpus all --runtime=nvidia --shm-size=1gb --privileged \
       -v $PWD:$PWD -v /dev:/dev -w $PWD \
       -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
       -e NVIDIA_VISIBLE_DEVICES=all \
       hololink-demo:$FLASH_REPO_VERSION \
       $FLASH_COMMAND

   # Stream flash log — allow up to 15 minutes
   timeout 900 docker logs -f "$CONTAINER_NAME" 2>&1
   EXIT_CODE=$?
   docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
   docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
   ```

3. **Display the flash log** for the user to review. Parse the output for success/failure indicators.

4. **If flashing succeeded**, ask the user to **power cycle** the board/camera:

   **For Lattice:**
   ```
   Flash step completed successfully.

   ACTION REQUIRED: Please power cycle the HSB Lattice board now.
   1. Turn off power to the board
   2. Wait 5 seconds
   3. Turn power back on
   4. Wait until 2 green leds are on

   Tell me when the power cycle is complete.
   ```

   **For VB1940:**
   ```
   Flash step completed successfully.

   ACTION REQUIRED: Please power cycle the Leopard Imaging VB1940 camera now.
   1. Turn off power to the camera
   2. Wait 5 seconds
   3. Turn power back on
   4. Wait 15 seconds for the camera to boot

   Tell me when the power cycle is complete.
   ```

5. **After user confirms power cycle**, verify the new FPGA version:

   - Ping the board (retry up to 30 seconds if the board is still booting)
   - If the expected version is **2407**, use `hololink --force fpga_version` instead of `hololink enumerate` (2407 enumeration is incompatible with v2.0.0+ software)
   - Otherwise, run `hololink enumerate` and read the FPGA version
   - Confirm the detected version matches the expected target

6. If verification succeeds, the flash is complete.

#### Two-step flashing procedure (Lattice only)

Two-step flashing is needed when the transition crosses the 2412 gateway boundary. The repo used for each step differs between upgrades and downgrades:

- **Two-step downgrade** (current > 2412, target = 2407):
  - Step 1: Flash CURRENT → 2412 using the repo matching the current FPGA (`$FLASH_REPO_DIR`)
  - Step 2: Flash 2412 → 2407 using v2.0.0 (`$STEP2_REPO_DIR`)

- **Two-step upgrade** (current = 2407, target > 2412):
  - Step 1: Flash 2407 → 2412 using v2.0.0 (`$FLASH_REPO_DIR`, which IS v2.0.0 for FPGA 2407)
  - Step 2: Flash 2412 → TARGET using the repo matching the target FPGA (`$STEP2_REPO_DIR`)

**── Step 1: CURRENT → 2412 ──**

1. **Announce step 1**:

   For downgrade:
   ```
   Starting Step 1 of 2: CURRENT → 2412
   Using repo v<FLASH_REPO_VERSION> (matches current FPGA)
   Manifest: v2.0.0/manifest.yaml (FPGA 2412)
   ```

   For upgrade:
   ```
   Starting Step 1 of 2: 2407 → 2412
   Using repo v2.0.0 (matches target 2412)
   Manifest: v2.0.0/manifest.yaml (FPGA 2412)
   ```

2. **Ensure the 2412 manifest is in place** in the flash repo's `scripts/manifest.yaml`. Copy from this skill's bundled `scripts/v2.0.0/manifest.yaml` if needed.

3. **Patch the manifest** if it is missing `fpga_uuid` (see "YAML manifest patching").

4. **Run the flash command** (`$FLASH_COMMAND`) inside the flash repo's demo container, as described in the single-step procedure above. For two-step upgrade (where step 1 also uses v2.0.0), ensure the command uses v2.0.0 flag placement: `hololink --force program scripts/manifest.yaml --accept-eula`.

5. **Display the flash log** for the user.

6. **Ask the user to power cycle** the board.

7. **After power cycle, verify FPGA version is now 2412**:

   - Ping the board
   - Run `hololink enumerate` (2412 is compatible with enumerate)
   - Confirm FPGA version reads 2412

   If verification fails (version is not 2412), STOP and report:
   ```
   Step 1 verification FAILED.
   Expected FPGA version: 2412
   Detected FPGA version: XXXX

   Do not proceed with Step 2. Please check the board and flash logs.
   ```

8. **Ask user permission to continue** to Step 2:
   ```
   Step 1 complete: FPGA verified at version 2412.
   Ready to proceed with Step 2: 2412 → TARGET (using <step 2 repo version>).
   Continue? [Y/n]
   ```

**── Step 2: 2412 → TARGET ──**

9. **Copy the target manifest** from this skill's bundled files to the step 2 repo's `scripts/manifest.yaml`:
   - For downgrade (target 2407): use `scripts/v2.0.0/manifest-2407.yaml`
   - For upgrade (target 2507 or 2510): use the bundled manifest matching the target version

10. **Patch the manifest** if missing `fpga_uuid`.

11. **Announce step 2**:

    For downgrade:
    ```
    Starting Step 2 of 2: 2412 → 2407
    Using repo v2.0.0
    Manifest: v2.0.0/manifest-2407.yaml (FPGA 2407)
    ```

    For upgrade:
    ```
    Starting Step 2 of 2: 2412 → TARGET
    Using repo vX.X.X (matches target FPGA)
    Manifest: vX.X.X/manifest.yaml (FPGA TARGET)
    ```

12. **Run the flash command** (`$STEP2_FLASH_COMMAND`) inside the step 2 repo's demo container. For two-step downgrade, step 2 uses v2.0.0 with v2.0.0 flag placement: `hololink --force program scripts/manifest.yaml --accept-eula`. For two-step upgrade, step 2 uses the target FPGA's repo with the appropriate flag placement for that version.

13. **Display the flash log**.

14. **Ask the user to power cycle** the board.

15. **After power cycle, verify the final FPGA version**:

    - Ping the board
    - If the final target is **2407**: use `hololink --force fpga_version` to verify (enumerate is incompatible with 2407)
    - Otherwise: run `hololink enumerate` and confirm the FPGA version matches the final target

#### Error handling during flashing

- If a flash command fails or returns a non-zero exit code, capture the full error output
- Do **NOT** retry flashing automatically — flashing is a destructive operation. Report the error clearly and ask the user how to proceed
- If the board stops responding after a flash attempt, advise the user to check physical connections and power
- If the post-flash FPGA version does not match the expected version, report a mismatch and do not proceed with subsequent steps
- Common flash failure scenarios:
  - **Board not responding during flash**: Check power and cable connections
  - **Flash script error / missing files**: Verify YAML file paths and container state
  - **Timeout during flash**: Flashing may need more time; wait and retry verification only (not the flash itself)
  - **FPGA version mismatch after flash**: Flash may have partially succeeded; report and let user decide
  - **"unrecognized arguments" error with v2.0.0**: v2.0.0 CLI expects `--force` before the subcommand, not after. Use `hololink --force program scripts/manifest.yaml --accept-eula`
  - **`hololink enumerate` fails after flashing to 2407**: This is expected — FPGA 2407 enumeration is incompatible with v2.0.0+ software. Use `hololink --force fpga_version` to verify the FPGA version instead
  - **All enumeration methods fail during Phase 1 (Lattice)**: The skill automatically checks out HSB release repo v2.0.0 and retries with the v2.0.0 container. If that also fails, FPGA version 2407 is assumed

#### Phase 4 summary format

For single-step:
```
**Phase 4 — Flashing complete**
- Flash: XXXX → YYYY [SUCCESS]
- Power cycle: completed
- Final FPGA version: YYYY (verified)
- Status: PASS

Proceed to Phase 5 (summary report)? [Y/n]
```

For two-step:
```
**Phase 4 — Flashing complete**
- Step 1: XXXX → 2412 [SUCCESS]
- Step 1 power cycle: completed, FPGA verified at 2412
- Step 2: 2412 → YYYY [SUCCESS]
- Step 2 power cycle: completed, FPGA verified at YYYY
- Final FPGA version: YYYY (verified)
- Status: PASS

Proceed to Phase 5 (summary report)? [Y/n]
```

### Phase 5 — Summary report

1. **Generate a comprehensive report** covering the entire flash procedure:

   ```
   ========================================
   HSB FPGA Flash Report
   ========================================
   Date: YYYY-MM-DD HH:MM:SS
   Operator: $USER

   Board Information
   -----------------
   IP Address     : 192.168.0.2
   MAC Address    : XX:XX:XX:XX:XX:XX
   Serial Number  : XXXXXXXX
   Board Type     : HSB Lattice / Leopard Imaging VB1940

   FPGA Version Change
   --------------------
   Starting version : XXXX
   Target version   : YYYY
   Final version    : YYYY (verified)
   Result           : SUCCESS / FAILURE

   Flashing Procedure
   -------------------
   Type: [single-step / two-step via 2412]

   Step 1: XXXX → YYYY
   - Flash script: <path>
   - YAML file   : <path> (from vX.X.X)
   - Result      : SUCCESS / FAILURE
   - Duration    : ~X minutes

   [Step 2: 2412 → ZZZZ]
   - Flash script: <path>
   - YAML file   : <path> (from vX.X.X)
   - Result      : SUCCESS / FAILURE
   - Duration    : ~X minutes

   Flash Infrastructure
   ---------------------
   - Flash repo: <path> (v<version>)
   - [If two-step:] Step 2 repo: <path> (v<version>)
   - Interim repos checked out: <none / list>
   - Manifest YAML patched: yes / no

   Issues Encountered
   -------------------
   [If no issues:]
   No issues encountered during the flash procedure.

   [If issues existed:]
   1. <Issue title>
      Symptom    : <what happened>
      Cause      : <root cause>
      Resolution : <how it was fixed>
      Blocking   : Yes / No

   Phase Summary
   --------------
   | Phase | Name                        | Status |
   |-------|-----------------------------|--------|
   | 0     | Board connectivity & FPGA   | PASS   |
   | 1     | Target version selection    | PASS   |
   | 2     | Flash preparation           | PASS   |
   | 3     | Flashing execution          | PASS   |
   | 4     | Summary report              | PASS   |
   | 5     | Cleanup                     | PASS   |

   Overall Status: SUCCESS
   ========================================
   ```

2. **Offer to save the report**:

   ```
   Would you like to save this report to a file? [Y/n]
   ```

   If the user agrees:
   - Save to `$REMOTE_ROOT/hsb-flash-report-YYYY-MM-DD-HHMMSS.md` on the remote host
   - If running locally, save to the current directory
   - Confirm the saved file path

#### Phase 5 summary format

```
**Phase 5 — Summary report**
- Report generated
- Report saved: [path or "not saved"]
- Status: PASS

Proceed to Phase 6 (cleanup)? [Y/n]
```

### Phase 6 — Cleanup

This phase removes all flash-related artifacts from the remote devkit. The scope of cleanup depends on the board type and whether interim repos were checked out.

#### What gets cleaned up

**Lattice boards:**

| Artifact | Location | Description |
|----------|----------|-------------|
| Interim repo clones | Each directory in `INTERIM_REPOS` | Repos checked out by this skill that differ from the user's original |
| Interim demo container images | `hololink-demo:<version>` for each interim repo | Container images built for interim repos |
| Flash workspace | `$REMOTE_ROOT/hsb-flash-workspace/` | Parent directory for interim checkouts (removed if empty) |
| Backed-up manifest | `$FLASH_REPO_DIR/scripts/manifest.yaml.backup` | Restore the original manifest YAML |
| Session state | `/tmp/.claude_hsb_flash_session/` | Temporary state files used between phases |

**VB1940 cameras:**

| Artifact | Location | Description |
|----------|----------|-------------|
| Backed-up manifest | `$EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml.backup` | Restore the original VB1940 manifest YAML |
| Session state | `/tmp/.claude_hsb_flash_session/` | Temporary state files used between phases |

The user's original repo (`$EXISTING_REPO_DIR`) and its demo container image are **never removed** — they belong to the user's setup.

#### Cleanup steps

1. **Announce the cleanup plan** before performing any deletions:

   When interim repos were checked out (Lattice):
   ```
   Cleanup plan — the following artifacts will be removed:
   1. Interim repo(s): <list of interim repo directories>
   2. Interim demo container image(s): <list>
   3. Flash workspace directory: $REMOTE_ROOT/hsb-flash-workspace/ (if empty)
   4. Restore original manifest: $FLASH_REPO_DIR/scripts/manifest.yaml (from backup)
   5. Flash session state: /tmp/.claude_hsb_flash_session/

   Your existing HSB repo and demo container will NOT be removed.

   Proceed with cleanup? [Y/n]
   ```

   When no interim repos were needed (Lattice, existing repo matched):
   ```
   Cleanup plan — the following will be cleaned up:
   1. Restore original manifest: $FLASH_REPO_DIR/scripts/manifest.yaml (from backup)
   2. Flash session state: /tmp/.claude_hsb_flash_session/

   Your existing HSB repo and demo container will NOT be removed.

   Proceed with cleanup? [Y/n]
   ```

   When VB1940:
   ```
   Cleanup plan — the following will be cleaned up:
   1. Restore original manifest: $EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml (from backup)
   2. Flash session state: /tmp/.claude_hsb_flash_session/

   Your existing HSB repo and demo container will NOT be removed.

   Proceed with cleanup? [Y/n]
   ```

   Wait for user confirmation before deleting anything.

2. **Stop and remove any running flash containers**:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_flash_session/state.sh 2>/dev/null || true

   echo "=== Stopping any remaining flash containers ==="
   for cid in $(docker ps -q --filter "ancestor=hololink-demo:$FLASH_REPO_VERSION" 2>/dev/null); do
       docker stop -t 5 "$cid" 2>/dev/null || true
       docker rm -f "$cid" 2>/dev/null || true
   done
   REMOTE
   ```

3. **Restore the original manifest** from backup:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_flash_session/state.sh 2>/dev/null || true

   # Restore Lattice manifest backup
   if [ "$BOARD_TYPE" = "lattice" ] && [ -f "$FLASH_REPO_DIR/scripts/manifest.yaml.backup" ]; then
       echo "=== Restoring original Lattice manifest ==="
       mv "$FLASH_REPO_DIR/scripts/manifest.yaml.backup" "$FLASH_REPO_DIR/scripts/manifest.yaml"
       echo "Restored $FLASH_REPO_DIR/scripts/manifest.yaml"
   fi

   # Restore VB1940 manifest backup
   if [ "$BOARD_TYPE" = "vb1940" ] && [ -f "$EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml.backup" ]; then
       echo "=== Restoring original VB1940 manifest ==="
       mv "$EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml.backup" "$EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml"
       echo "Restored $EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml"
   fi
   REMOTE
   ```

4. **Remove interim repos and their container images**:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_flash_session/state.sh 2>/dev/null || true

   for REPO_DIR in $INTERIM_REPOS; do
       if [ -d "$REPO_DIR" ]; then
           REPO_VER=$(cat "$REPO_DIR/VERSION" 2>/dev/null || echo "unknown")
           echo "=== Removing interim repo: $REPO_DIR (v$REPO_VER) ==="

           # Remove demo container image for this repo
           if docker image inspect "hololink-demo:$REPO_VER" >/dev/null 2>&1; then
               docker rmi "hololink-demo:$REPO_VER"
               echo "Removed image hololink-demo:$REPO_VER"
           fi

           rm -rf "$REPO_DIR"
           echo "Removed $REPO_DIR"
       fi
   done

   # Remove flash workspace if empty
   WORKSPACE="__REMOTE_ROOT__/hsb-flash-workspace"
   if [ -d "$WORKSPACE" ] && [ -z "$(ls -A "$WORKSPACE")" ]; then
       rmdir "$WORKSPACE"
       echo "Removed empty workspace $WORKSPACE"
   fi
   REMOTE
   ```

5. **Remove the session state** (always):

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_flash_session"
   ```

6. **Verify cleanup** — confirm the artifacts are gone:

   ```bash
   ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
   source /tmp/.claude_hsb_flash_session/state.sh 2>/dev/null || true

   echo "=== Cleanup verification ==="
   if [ "$BOARD_TYPE" = "vb1940" ]; then
       [ -f "$EXISTING_REPO_DIR/scripts/manifest_leopard_cpnx100.yaml.backup" ] && echo "WARNING: VB1940 manifest backup still exists" || echo "VB1940 manifest restored: OK"
   else
       [ -f "$FLASH_REPO_DIR/scripts/manifest.yaml.backup" ] && echo "WARNING: manifest backup still exists" || echo "Manifest restored: OK"
       for REPO_DIR in $INTERIM_REPOS; do
           [ -d "$REPO_DIR" ] && echo "WARNING: interim repo still exists: $REPO_DIR" || echo "Interim repo removed: $REPO_DIR"
       done
   fi
   [ -d "/tmp/.claude_hsb_flash_session" ] && echo "WARNING: session state still exists" || echo "Session state: removed"
   REMOTE
   ```

#### Phase 6 summary format

Lattice (with interim repos):
```
**Phase 6 — Cleanup**
- Interim repo(s): removed (<list>)
- Interim container image(s): removed
- Flash workspace: removed (if empty)
- Manifest: restored from backup
- Session state: removed
- User's existing repo and container: preserved
- Status: PASS
```

Lattice (no interim repos):
```
**Phase 6 — Cleanup**
- Manifest: restored from backup
- Session state: removed
- User's existing repo and container: preserved
- Status: PASS
```

VB1940:
```
**Phase 6 — Cleanup**
- VB1940 manifest (manifest_leopard_cpnx100.yaml): restored from backup
- Existing repo and container: preserved (not removed)
- Session state: removed
- Status: PASS
```


---

## Flashing procedure logic

### Lattice version ordering

```
2407 < 2412 < 2507 < 2510
```

Version 2412 is the **gateway version**. Any two-step Lattice flashing always transits through 2412.

### VB1940 version ordering

```
2507 < 2510
```

VB1940 has only two versions. Flashing between them is always **single-step** — no gateway version, no two-step procedure.

### Lattice decision tree

Given `CURRENT` (current FPGA version) and `TARGET` (desired FPGA version):

#### Case 1: CURRENT == TARGET
No flashing needed. Inform the user and stop — **unless `--force` is set**, in which case treat this as a single-step re-flash using the YAML for the TARGET version.

#### Case 2: Single-step — both versions are 2412 or newer, or upgrading to exactly 2412
**Single step**: Flash CURRENT → TARGET. The repo selection depends on direction:
- **Upgrade**: Use the repo that corresponds to the **target** FPGA version.
- **Downgrade**: Use the repo that corresponds to the **current** FPGA version.

Copy the TARGET manifest YAML from this skill's bundled `scripts/` directory.

This covers:
- All transitions where both CURRENT and TARGET are ≥ 2412 (e.g., 2412↔2507, 2412↔2510, 2507↔2510)
- Upgrading from any version to exactly 2412 (e.g., 2407 → 2412)

#### Case 3: Two-step downgrade — TARGET is older than 2412 and CURRENT is newer than 2412
**Two steps** through gateway version 2412, each step using a different repo:
1. Flash CURRENT → 2412 using the repo that corresponds to the current FPGA version
2. Flash 2412 → TARGET (2407) using HSB release repo v2.0.0

Power cycle required between steps.

**Special case**: If CURRENT is exactly 2412, step 1 is skipped and only step 2 is needed (effectively single-step: 2412 → 2407 using v2.0.0).

#### Case 4: Two-step upgrade — CURRENT is older than 2412 and TARGET is newer than 2412
**Two steps** through gateway version 2412, each step using the repo that corresponds to the step's target FPGA version:
1. Flash CURRENT → 2412 using HSB release repo v2.0.0 (corresponds to target FPGA 2412)
2. Flash 2412 → TARGET using the repo that corresponds to the TARGET FPGA version

Power cycle required between steps.

This applies when CURRENT is 2407 and TARGET is 2507 or 2510. Step 1 uses v2.0.0 (target 2412's repo). Step 2 uses the repo matching the final target (v2.3.1 for 2507, v2.5.0 for 2510).

### Complete transition matrix

| Current | Target | Direction | Steps | Step 1 | Step 1 Repo | Step 2 | Step 2 Repo |
|---------|--------|-----------|-------|--------|-------------|--------|-------------|
| 2407    | 2412   | Upgrade   | 1     | 2407 → 2412 | v2.0.0 | — | — |
| 2407    | 2507   | Upgrade   | 2     | 2407 → 2412 | v2.0.0 | 2412 → 2507 | v2.3.1 |
| 2407    | 2510   | Upgrade   | 2     | 2407 → 2412 | v2.0.0 | 2412 → 2510 | v2.5.0 |
| 2412    | 2407   | Downgrade | 1*    | 2412 → 2407 | v2.0.0 | — | — |
| 2412    | 2507   | Upgrade   | 1     | 2412 → 2507 | v2.0.0 | — | — |
| 2412    | 2510   | Upgrade   | 1     | 2412 → 2510 | v2.0.0 | — | — |
| 2507    | 2407   | Downgrade | 2     | 2507 → 2412 | v2.3.1 | 2412 → 2407 | v2.0.0 |
| 2507    | 2412   | Downgrade | 1     | 2507 → 2412 | v2.3.1 | — | — |
| 2507    | 2510   | Upgrade   | 1     | 2507 → 2510 | v2.5.0 | — | — |
| 2510    | 2407   | Downgrade | 2     | 2510 → 2412 | v2.5.0 | 2412 → 2407 | v2.0.0 |
| 2510    | 2412   | Downgrade | 1     | 2510 → 2412 | v2.5.0 | — | — |
| 2510    | 2507   | Downgrade | 1     | 2510 → 2507 | v2.5.0 | — | — |

\* 2412 → 2407 is the "special case" of Case 3 where step 1 is skipped — effectively single-step using v2.0.0.

### VB1940 decision tree

Given `CURRENT` (current FPGA version) and `TARGET` (desired FPGA version):

#### VB1940 Case 1: CURRENT == TARGET
No flashing needed. Inform the user and stop — **unless `--force` is set**, in which case treat this as a single-step re-flash using `manifest_leopard_cpnx100.yaml` for the TARGET version.

#### VB1940 Case 2: Any transition between 2507 and 2510
**Single step**: Flash CURRENT → TARGET using the manifest from the release matching TARGET.

This covers:
- 2507 → 2510
- 2510 → 2507

#### VB1940 complete transition matrix

| Current | Target | Steps | Step 1              | Step 1 Manifest Source |
|---------|--------|-------|---------------------|------------------------|
| 2507    | 2510   | 1     | 2507 → 2510         | v2.5.0                 |
| 2510    | 2507   | 1     | 2510 → 2507         | v2.3.0                 |

### Handling undocumented FPGA versions

This procedure applies to **both Lattice boards and VB1940 cameras** when the current or target FPGA version is **not listed** in this skill's supported versions or mapping tables. This can happen when:

- A new HSB release has been published after this skill was last updated.
- The board is running a development or pre-release FPGA build that has not been formally released.

**Prerequisite for Lattice boards**: Both the current and target versions must be ≥ 2412 for single-step handling. If the transition crosses the 2412 gateway boundary, the standard two-step procedure applies — undocumented versions cannot participate in two-step flashing.

**Prerequisite for VB1940 cameras**: Both the current and target versions must be ≥ 2507 (VB1940 does not support 2407 or 2412 regardless of whether the version is documented or not).

#### Step 1 — Check the public release notes

Fetch the HSB release notes from:

```
https://github.com/nvidia-holoscan/holoscan-sensor-bridge/blob/main/RELEASE_NOTES.md
```

Search for a release that introduces the undocumented FPGA version. Release notes typically list the FPGA version included in each release (e.g., "FPGA version 26XX").

#### Step 2a — Matching release found

If a published HSB release corresponds to the undocumented FPGA version:

1. **Checkout the release repo** on the devkit (into the flash workspace for Lattice boards, or as the flash repo for VB1940 cameras).
2. **Use it for flashing** following the standard rules for the detected board type:
   - **Lattice**: Single-step upgrade or downgrade rules apply — the direction determines whether the target's or current's repo is used.
   - **VB1940**: Single-step flash using the checked-out release repo.
3. **Update this skill** with the new information so future invocations do not need to repeat the lookup:
   - Add the FPGA version and its HSB release to the "FPGA version to repo mapping" table (Lattice) and/or the "VB1940 FPGA versions" table.
   - Add the FPGA version to the appropriate "Supported FPGA versions" table.
   - Add the relevant transition rows to the appropriate transition matrix.
   - Update the "latest" label if the new version is newer than the current latest.
   - If the new release includes manifest YAML files, note that they should be bundled into this skill's `scripts/` directory for future use.

#### Step 2b — No matching release found (development FPGA)

If no published release corresponds to the FPGA version:

1. **Use the existing HSB repo** already on the devkit (from `/hsb-setup`) to flash, following the same rules for the detected board type.
2. **Inform the user** that this FPGA version does not correspond to any known release and that the existing repo's flash tools will be used on a best-effort basis.
3. **If the flash fails**, report the error clearly and prompt the user for further instructions. Do not retry automatically. Common issues include incompatible flash tools or missing manifest files for the development FPGA version.

#### Notes

- This procedure applies to both **Lattice boards** and **VB1940 cameras**.
- The skill self-updates only when a matching release is confirmed. Development FPGA versions do not trigger skill updates.
- When the skill self-updates, it modifies the `SKILL.md` file directly. The changes take effect on the next invocation.

## Execution rules

### SSH heredoc pattern

Use the same persistent SSH session model as `hsb-setup`. Each phase runs as a single SSH heredoc block:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
set -e

# restore state from previous phase
source /tmp/.claude_hsb_flash_session/state.sh 2>/dev/null || true
cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

# phase commands
echo "=== Phase N: description ==="
command1
command2

# save state for next phase
mkdir -p /tmp/.claude_hsb_flash_session
{
  echo "export _CLAUDE_CWD=\"$(pwd)\""
  echo "export PATH=\"$PATH\""
  echo "export BOARD_TYPE=\"$BOARD_TYPE\""
  echo "export CURRENT_FPGA_VERSION=\"$CURRENT_FPGA_VERSION\""
  echo "export TARGET_FPGA_VERSION=\"$TARGET_FPGA_VERSION\""
  echo "export EXISTING_REPO_DIR=\"$EXISTING_REPO_DIR\""
  echo "export EXISTING_REPO_VERSION=\"$EXISTING_REPO_VERSION\""
  echo "export FLASH_REPO_DIR=\"$FLASH_REPO_DIR\""
  echo "export FLASH_REPO_VERSION=\"$FLASH_REPO_VERSION\""
  echo "export FLASH_COMMAND=\"$FLASH_COMMAND\""
  echo "export STEP2_REPO_DIR=\"${STEP2_REPO_DIR:-}\""
  echo "export STEP2_FLASH_COMMAND=\"${STEP2_FLASH_COMMAND:-}\""
  echo "export INTERIM_REPOS=\"$INTERIM_REPOS\""
} > /tmp/.claude_hsb_flash_session/state.sh
REMOTE
```

Replace `__REMOTE_ROOT__` with the literal value of `$REMOTE_ROOT` when composing the heredoc. Since the heredoc uses single-quoted `'REMOTE'`, local shell variables are **not** expanded.

### Container usage for flashing

Flash commands run inside the demo container of the flash repo selected for that step (target FPGA's repo for upgrades, current FPGA's repo for downgrades). For two-step downgrade, step 2 uses the v2.0.0 demo container. For two-step upgrade, step 2 uses the demo container of the target FPGA's repo. Use the detached pattern with a named container.

For flash operations, do **not** use a short watchdog timeout. Flashing can take 5-15 minutes. Use a timeout of at least 900 seconds (15 minutes) and stream logs continuously so the user can monitor progress.

### Cleanup after flash containers

After every flash container run, ensure cleanup:

```bash
docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

### Session teardown

Session teardown is handled by Phase 6 (Cleanup). If the workflow is aborted before Phase 6, still run cleanup:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_flash_session"
```

## Safety constraints

1. **Supported boards only**: This skill supports **HSB Lattice boards** and **Leopard Imaging VB1940 cameras**. Before flashing, verify the board identity through enumerate output. Refuse to flash any device that is not one of these two types.

2. **CRITICAL — Never mix board-type commands**: Using `program_leopard_cpnx100` on a Lattice board or `program_lattice_cpnx100` on a VB1940 **can permanently brick the device**. The skill must:
   - Detect the board type in Phase 1
   - Confirm the board type with the user if ambiguous
   - Use ONLY the correct program command for the detected board type
   - Re-verify the board type before executing the flash command in Phase 4
   - Refuse to proceed if the board type is uncertain

3. **Version validation**: Only allow flashing to supported versions for the detected board type:
   - **Lattice**: 2407, 2412, 2507, 2510
   - **VB1940**: 2507, 2510
   Reject any other version immediately and show the list of valid versions for that board type.

4. **User confirmation at every critical step**: Never start a flash operation without explicit user permission. The flash plan must be shown and approved. Between steps in a two-step procedure (Lattice only), explicitly ask for permission to continue.

5. **No automatic retry of failed flashes**: If a flash operation fails, report the error and wait for user guidance. Do not automatically retry firmware writes.

6. **Power cycle verification**: After each flash step, wait for the user to confirm the power cycle is complete. Then verify the new FPGA version before proceeding.

7. **Preserve original YAML files**: Before replacing YAML files, create backup copies so the workspace can be restored.

8. **No partial flash state**: If a two-step Lattice flash fails at step 2, clearly report the current state (board is at version 2412) so the user knows exactly where things stand.

## Phase gate — user confirmation between phases

After completing each phase (Phases 0–5), **always prompt the user for confirmation** before starting the next phase.

**Exception**: When `--y` (auto-approve mode) is active, phase gates are skipped. See "Auto-approve mode (`--y`)" section.

```
Proceed to Phase <N+1> (<phase description>)? [Y/n]
```

### User response handling

- **"y"**, **"yes"**, **"Y"**, **blank/empty**, **"ok"**, **"go"**, **"continue"**, **"next"** → proceed to the next phase.
- **"n"**, **"no"**, **"stop"**, **"abort"** → stop execution. Print:
  ```
  Flash workflow paused after Phase N. Current FPGA version: XXXX.
  You can resume by re-invoking the skill.
  ```
  Then run session teardown.
- **Any other text** → treat as a question or instruction about the current phase. Answer it, then re-prompt.
- **"retry"** → re-execute the current phase, show summary again, then re-prompt.

### Exceptions

- **Phase 6** (cleanup) is the final phase — do not prompt after it. Show the cleanup summary and end the session.
- **If a flash step FAILS** and cannot be recovered, do not prompt to proceed. Stop and report clearly, including the board's current FPGA version state. Still offer to run cleanup (Phase 6) so the devkit is left in a clean state.


## Verbosity mode (`--verbose`)

The skill supports a `--verbose` flag:

### Verbose mode (when set)

- Show complete raw output of every SSH command
- Show full docker and flash logs inline
- Show detailed phase status blocks

### Concise mode (default, no `--verbose`)

- Show bullet-point summaries after each phase
- Suppress raw command output
- Still display flash logs (these are always shown since the user needs to monitor flashing progress)
- Show issues with the 4-line format (Symptom, Cause, Resolution, Blocking)

## Force mode (`--force`)

The skill supports a `--force` flag that relaxes certain safety checks. This is useful for recovery scenarios where the board may be in an unexpected state.

### Detecting the flag

Check whether `$ARGUMENTS` (the text after the slash command) contains `--force` (case-insensitive). Strip all flags from arguments before further parsing.

### Behavior when `--force` is set

| Check | Normal behavior | With `--force` |
|-------|----------------|----------------|
| Current == Target version (Phase 2) | Ask user to confirm re-flash | Proceed with re-flash without asking |
| Pre-flash FPGA version mismatch (Phase 4) | STOP and alert user | Warn user, re-evaluate transition path, continue |
| FPGA version not in known list (Phase 1) | Warn and ask user to confirm | Warn but accept the detected version and continue |
| FPGA version unreadable (Phase 1) | Assume 2407 and alert user | Same — assume 2407 and alert user |

### When `--force` does NOT change behavior

These safety constraints are always enforced regardless of `--force`:

- **User approval of flashing plan** (Phase 3): The flash plan is always shown and requires explicit `[Y/n]` confirmation before any firmware write — **unless `--y` is also active**, in which case the plan approval is auto-approved
- **Power cycle verification**: After each flash step, the user must confirm the power cycle and the FPGA version is always verified — **unless `--y` is also active** (see below)
- **Failed flash retry**: A failed flash command is never automatically retried
- **Board identity check**: The skill still only flashes HSB Lattice boards
- **Version validation**: Only versions 2407, 2412, 2507, 2510 are accepted as targets
- **Phase gates**: All phase gates still require user confirmation (except the same-version prompt in Phase 2) — **unless `--y` is active**

## Auto-approve mode (`--y`)

The skill supports a `--y` flag that skips all phase gates and runs the entire workflow from start to finish without waiting for user confirmation between phases. This is **not recommended** for normal use — interactive phase gates exist to give the user control over each step, especially for a destructive operation like FPGA flashing.

### Detecting the flag

Check whether `$ARGUMENTS` contains `--y` (case-insensitive). Strip all flags from arguments before further parsing.

### Confirmation warning

When `--y` is detected, **do not proceed immediately**. First, display a warning and ask the user to confirm:

```
⚠  WARNING: Auto-approve mode (--y) is enabled.

This is NOT RECOMMENDED for FPGA flashing. All phase gates will be skipped
and the entire workflow will run without pausing for your confirmation
between phases. This includes automatic approval of the flash plan and
automatic progression after power cycle prompts.

You will not be able to review intermediate results, ask questions, or
abort between phases. All output will be saved to a timestamped log file.

IMPORTANT: You will still need to physically power cycle the board when
prompted. The skill will wait for you to confirm the power cycle, but
all other approvals will be automatic.

Are you sure you want to continue with auto-approve mode? [yes/NO]
```

- If the user responds with **"yes"** (exact match, case-insensitive) → enable auto-approve mode and proceed.
- Any other response (including "y", "ok", blank, etc.) → cancel auto-approve mode, inform the user that the skill will run in normal interactive mode, and proceed without `--y`.

This double-confirmation is intentional — auto-approve mode bypasses a critical safety mechanism on a destructive operation.

### Behavior when `--y` is active

1. **Phase gates are skipped**: After each phase summary, do not prompt `Proceed to Phase <N+1>? [Y/n]`. Instead, immediately proceed to the next phase.

2. **Flash plan approval is auto-approved**: The flash plan is still displayed in Phase 3, but the `Do you approve this flashing plan? [Y/n]` prompt is auto-approved.

3. **Power cycle prompts still require user input**: Even in auto-approve mode, the skill **must still wait** for the user to confirm that they have physically power cycled the board. This cannot be automated. Display the power cycle instructions and wait for the user to respond before verifying the FPGA version.

4. **Two-step inter-step approval is auto-approved**: The `Continue? [Y/n]` prompt between step 1 and step 2 of a two-step flash is auto-approved.

5. **Log file**: At the start of the workflow (before Phase 0), create a timestamped log file:

   - **Log file name**: `hsb-flash-log-YYYY-MM-DD-HHMMSS.md`
   - **Log file location**: If running remotely, save to `$REMOTE_ROOT/` on the remote host. If running locally, save to the current working directory.
   - **Log content**: Accumulate the full phase summary (concise or verbose, depending on `--verbose`) for every phase, including the flash plan, flash logs, issues encountered, and the final report.
   - **Announce the log file** at the start:
     ```
     Auto-approve mode active. All output will be saved to:
       <log_file_path>
     ```

6. **Phase summaries are still shown**: Even though phase gates are skipped, still display each phase summary to the user so they can follow progress in real time.

7. **At the end of the workflow**, write the final accumulated log to the log file and inform the user:
   ```
   Workflow complete. Full log saved to:
     <log_file_path>
   ```

8. **Failures still stop the workflow**: If a phase fails and cannot be recovered, stop the workflow even in auto-approve mode. Write the log up to that point and report the failure. Do not skip failures.

### Combining with other flags

- `--y --verbose`: Auto-approve with full raw output. Log file contains verbose output.
- `--y --force`: Auto-approve with relaxed safety checks. Both flags are independent — `--y` skips phase gates, `--force` relaxes version-match checks.
- `--y --force --verbose`: All three combined.
- `--y` alone: Auto-approve with concise output (default).
