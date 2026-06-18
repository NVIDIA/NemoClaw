# Phase Details — hsb-setup

## Execution rules

### Auto-reboot and reconnection (shared procedure)

Multiple phases (Phase 1 for Docker group changes, Phase 2 for power mode changes) may require a device reboot. When a reboot is needed, always follow this procedure:

1. **Before issuing the reboot command**, save all completed state for the current phase to the remote session file, and note which sub-steps remain. The post-reboot heredoc block must pick up where the pre-reboot block left off.

2. **Issue the command that triggers the reboot.** The SSH connection will drop — this is expected. Do not treat the SSH disconnect as a failure.

   ```bash
   sudo reboot
   ```

3. **Wait and retry SSH connectivity** using a polling loop on the local machine.

> The following SSH polling command works identically on both **Windows** (via Git Bash or WSL) and **Linux**.
> If you are using PowerShell natively, run this in a Bash-compatible shell provided by Git for Windows or in WSL.

   ```bash
   echo "Device is rebooting — waiting for SSH to come back..."
   for i in $(seq 1 20); do
     sleep 15
     if ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok" 2>/dev/null; then
       echo "SSH reconnected after ~$((i * 15)) seconds"
       break
     fi
     echo "Attempt $i/20: not ready yet..."
   done
   ```

   Allow up to 5 minutes (20 attempts x 15 seconds). If SSH does not come back within that window, stop and report:

   ```
   Device did not come back online within 5 minutes after reboot.
   Please verify the device is powered on and accessible, then re-invoke the skill.
   ```

4. **After reconnecting**, verify the reboot took effect (e.g., `docker info --format '{{.ServerVersion}}'` for Docker group changes, `sudo nvpmodel -q` for power mode). Then continue with the remaining sub-steps in a new heredoc block that restores state from the session file.

5. **Report the reboot in the phase summary.** In concise mode:

   ```
   - Device rebooted — SSH reconnected after ~45 seconds
   ```

   In verbose mode, show the full polling output.

#### When to trigger auto-reboot

Only trigger auto-reboot when:

- **Phase 1**: Docker group membership was changed (users added to `docker` group). Group changes require a reboot to take effect for all login sessions.
- **Phase 2 / AGX Orin**: `nvpmodel -q` shows a mode other than MAXN (mode 0). If already MAXN, skip.
- **Any future platform** whose setup documentation in the repo explicitly requires a reboot for a configuration change (e.g., `isolcpus` kernel parameter).

Do **not** reboot for changes that take effect without a reboot (e.g., sysctl, nmcli, systemd service start).

### Phase 1 - confirm platform, clone repo, and study user guide

- **First**, run the SSH connectivity validation described in "SSH connectivity validation (mandatory before session init)" section. Then run the **session init** to create the remote state directory. Do not proceed to any remote commands until the session is initialized. All subsequent remote commands must use the **heredoc execution pattern** described in "Persistent SSH session model".
- **Immediately after session init**, run the host platform auto-detection (see "Host platform auto-detection" section). Execute the detection script inside the first Phase 1 heredoc block to read `/sys/class/dmi/id/product_name` and reconcile it with `HSB_PLATFORM`. Apply the reconciliation rules and alert the user if the platform was changed or auto-detected. This must happen before any platform-dependent decisions are made.
- Read `README.md`, `docker/`, and any host-setup docs in the repo if present.
- Detect whether this is a fresh checkout or existing clone.
- Check basic tools before building:
  - `git`
  - `git-lfs`
  - `docker`
  - `bash`
  - `xhost` when a GUI container is expected
- If `git-lfs` is missing, install or instruct the user using the platform package manager.
- If Docker exists but access fails with permission errors, add **all** non-system human users to the `docker` group (not just the current user). This ensures any user who logs into the devkit can run Docker without `sudo`:

  ```bash
  # Add every human user (UID >= 1000, excluding 'nobody') to the docker group
  for u in $(awk -F: '$3 >= 1000 && $1 != "nobody" {print $1}' /etc/passwd); do
    sudo usermod -aG docker "$u"
  done
  ```

  After updating group membership, a **reboot is required** for the change to take effect for all users and all login sessions. Follow the **auto-reboot and reconnection** shared procedure (see "Auto-reboot and reconnection" section above) to reboot the device and wait for SSH to come back:

  ```bash
  sudo reboot
  ```

  After reconnecting, verify Docker access works without `sudo`:

  ```bash
  docker info --format '{{.ServerVersion}}'
  ```

  If Docker still fails after reboot, fall back to running Docker commands with `sudo` for the remainder of the workflow and report the issue.

#### Clone or refresh repo

Use the latest top of tree from the configured GitHub repository.

##### Determining the repo URL

Resolve the repo URL in this priority order:

1. `--repo <URL>` flag passed on the command line (highest priority)
2. `HSB_REPO` environment variable
3. Default: `https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git`

Derive the local directory name from the repo URL (e.g. `my-hsb-fork` from `https://github.com/myorg/my-hsb-fork.git`). Use `basename` on the URL and strip the `.git` suffix.

Print the resolved repo URL before cloning so the user can confirm.

##### Preferred behavior

- If repo does not exist locally:
  - `git clone $REPO_URL`
- If repo already exists:
  - verify remote URL matches the resolved `$REPO_URL`. If it differs, warn the user and ask whether to re-clone or keep the existing repo.
  - fetch `origin`
  - switch to `main`
  - fast-forward pull only

##### Safe sequence

```bash
REPO_URL="${HSB_REPO:-https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git}"
REPO_DIR=$(basename "$REPO_URL" .git)

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL"
else
  cd "$REPO_DIR"
  CURRENT_URL=$(git remote get-url origin 2>/dev/null)
  if [ "$CURRENT_URL" != "$REPO_URL" ]; then
    echo "WARNING: existing repo remote ($CURRENT_URL) differs from requested ($REPO_URL)"
    # Skill should stop and ask the user before proceeding
  fi
  git fetch origin
  git checkout main
  git pull --ff-only origin main
fi
```

If `git lfs` is available, run `git lfs install` for **all** human users on the devkit (not just the current user), then run `git lfs pull` inside the repo. `git lfs install` writes filter configuration to each user's `~/.gitconfig`, so it must be run per-user:

```bash
# Install git-lfs hooks for every human user
for u in $(awk -F: '$3 >= 1000 && $1 != "nobody" {print $1}' /etc/passwd); do
  sudo -u "$u" git lfs install 2>/dev/null || true
done
git lfs pull
```

#### Study the user guide

- Read the user guide at `docs/user_guide/setup.md` and `docs/user_guide/build.md` in the cloned repo.
- Learn the host environment setup, demo container build process, application examples, and FPGA flashing instructions for the selected platform.
- Identify platform-specific requirements (interface names, sysctl settings, PTP setup, SIPL/FuSa dependencies, NGC login, etc.).
- **If all profile parameters are known** (`HSB_PLATFORM`, `SSH_TARGET`, etc.), use the user guide diagrams and setup descriptions to draw an ASCII or text-based diagram of the expected hardware topology (devkit, NIC/interface, cable, HSB board, sensor connections). Present it to the user and ask them to confirm this matches their physical setup before proceeding. If the user says the diagram does not match, ask what differs and adjust accordingly. If profile parameters are incomplete (platform not yet determined), skip the diagram and rely on the standard confirmation questions instead.
- Use the knowledge gained here to drive Phase 2 and later phases.

### Phase 2 - host prerequisite checks and platform network setup

Apply the host setup that matches the selected platform.

#### Common checks

- Ensure Docker daemon is running.
- Ensure the user can talk to Docker.
- Check that the board-side address `192.168.0.2` is reachable only **after** host networking is configured and the board is powered.

#### Idempotent nmcli connection management

All platform network setup steps **must** use this helper function to create or update nmcli connections. The helper ensures that:

1. If a valid connection with the correct name already exists and is properly configured, it is reused as-is.
2. If duplicate connections with the same name exist, all duplicates are deleted and only one valid connection is kept (or a fresh one is created).
3. A new connection is only created when none exists.

Define this shell function at the top of the Phase 2 heredoc block, before any network configuration commands:

```bash
# Idempotent nmcli connection helper
# Usage: ensure_hololink_connection <con-name> <ifname> <ip4> [route] [ring-rx] [mtu]
# - route, ring-rx, mtu can be empty strings to skip those settings
ensure_hololink_connection() {
  local CON_NAME="$1" IFNAME="$2" IP4="$3" ROUTE="$4" RING_RX="$5" MTU="$6"

  # Find all connection UUIDs with this name
  local UUIDS
  UUIDS=$(nmcli -g UUID,NAME con show 2>/dev/null | awk -F: -v name="$CON_NAME" '$2 == name {print $1}')
  local COUNT=$(echo "$UUIDS" | grep -c . 2>/dev/null || echo 0)

  if [ "$COUNT" -gt 1 ]; then
    echo "Found $COUNT duplicate connections named '$CON_NAME' — cleaning up"
    # Delete all duplicates
    for uuid in $UUIDS; do
      sudo nmcli con delete uuid "$uuid" 2>/dev/null || true
    done
    UUIDS=""
    COUNT=0
  fi

  if [ "$COUNT" -eq 1 ]; then
    # Validate the existing connection has the correct interface and IP
    local EXISTING_IFNAME EXISTING_IP4
    EXISTING_IFNAME=$(nmcli -g connection.interface-name con show "$UUIDS" 2>/dev/null)
    EXISTING_IP4=$(nmcli -g ipv4.addresses con show "$UUIDS" 2>/dev/null)
    if [ "$EXISTING_IFNAME" = "$IFNAME" ] && echo "$EXISTING_IP4" | grep -q "${IP4%%/*}"; then
      echo "Connection '$CON_NAME' already exists and is valid (uuid=$UUIDS, ifname=$EXISTING_IFNAME, ip=$EXISTING_IP4)"
      # Ensure optional settings are applied
      [ -n "$ROUTE" ] && sudo nmcli connection modify "$UUIDS" +ipv4.routes "$ROUTE" 2>/dev/null || true
      [ -n "$RING_RX" ] && sudo nmcli connection modify "$UUIDS" ethtool.ring-rx "$RING_RX" 2>/dev/null || true
      [ -n "$MTU" ] && sudo nmcli connection modify "$UUIDS" 802-3-ethernet.mtu "$MTU" 2>/dev/null || true
      sudo nmcli connection up "$CON_NAME" 2>&1 || echo "WARNING: failed to activate $CON_NAME"
      return 0
    else
      echo "Connection '$CON_NAME' exists but has wrong ifname ($EXISTING_IFNAME) or IP ($EXISTING_IP4) — recreating"
      sudo nmcli con delete uuid "$UUIDS" 2>/dev/null || true
      COUNT=0
    fi
  fi

  # Create fresh connection
  echo "Creating new connection '$CON_NAME' on $IFNAME with $IP4"
  sudo nmcli con add con-name "$CON_NAME" ifname "$IFNAME" type ethernet ip4 "$IP4"
  [ -n "$ROUTE" ] && sudo nmcli connection modify "$CON_NAME" +ipv4.routes "$ROUTE"
  [ -n "$RING_RX" ] && sudo nmcli connection modify "$CON_NAME" ethtool.ring-rx "$RING_RX"
  [ -n "$MTU" ] && sudo nmcli connection modify "$CON_NAME" 802-3-ethernet.mtu "$MTU"
  sudo nmcli connection up "$CON_NAME" 2>&1 || echo "WARNING: failed to activate $CON_NAME"
}
```

All platform sections below must call `ensure_hololink_connection` instead of running raw `nmcli con add` / `nmcli connection modify` commands directly.

#### IGX Orin (CX7)

- Discover `IN0` from `/sys/class/infiniband/*`
- Derive `EN0` from `/sys/class/infiniband/$IN0/device/net/*`
- Configure `EN0` to `192.168.0.101/24`
- Add a route to `192.168.0.2/32`
- Set `ethtool.ring-rx` to `4096`
- Set `802-3-ethernet.mtu` to `4096`
- Bring the connection up

Before creating any nmcli connection, use the **idempotent nmcli connection helper** (see "Idempotent nmcli connection management" below) to check for an existing valid connection, clean up duplicates, and only create a new connection if none exists.

Typical commands:

```bash
LC_COLLATE=C IN=(/sys/class/infiniband/*)
IN0=$(basename "${IN[0]}")
EN0=$(basename /sys/class/infiniband/$IN0/device/net/*)
ensure_hololink_connection "hololink-$EN0" "$EN0" "192.168.0.101/24" "192.168.0.2/32" "4096" "4096"
```

#### AGX Orin

- Default host port is typically `eno1`
- Increase receive buffer
- Configure static IP `192.168.0.101/24`
- Set power mode to MAXN for optimal performance (requires reboot)
- Set up `jetson_clocks` systemd service for maximum core clocks

Before creating any nmcli connection, use the **idempotent nmcli connection helper** (see "Idempotent nmcli connection management" below).

Typical commands:

```bash
echo 'net.core.rmem_max = 31326208' | sudo tee /etc/sysctl.d/52-hololink-rmem_max.conf
sudo sysctl -p /etc/sysctl.d/52-hololink-rmem_max.conf
EN0=eno1
ensure_hololink_connection "hololink-$EN0" "$EN0" "192.168.0.101/24" "" "" ""
```

##### MAXN power mode (AGX Orin)

Check the current power mode with `sudo nvpmodel -q`. If it is not already MAXN (mode 0), set it:

```bash
echo "YES" | sudo nvpmodel -m 0
```

`nvpmodel -m 0` on AGX Orin requires a reboot and prompts for interactive confirmation. Piping `"YES"` answers the prompt and triggers an immediate reboot. After issuing this command, the SSH connection will drop. Follow the **auto-reboot and reconnection** procedure described below.

##### jetson_clocks service (AGX Orin)

Create and enable a systemd service that runs `jetson_clocks` at startup:

```bash
JETSON_CLOCKS_SERVICE=/etc/systemd/system/jetson_clocks.service
cat <<EOF | sudo tee $JETSON_CLOCKS_SERVICE >/dev/null
[Unit]
Description=Jetson Clocks Startup
After=nvpmodel.service

[Service]
Type=oneshot
ExecStart=/usr/bin/jetson_clocks

[Install]
WantedBy=multi-user.target
EOF
sudo chmod u+x $JETSON_CLOCKS_SERVICE
sudo systemctl enable jetson_clocks.service
sudo systemctl start jetson_clocks.service
```

This service activates after the MAXN reboot.

#### DGX Spark

- Same discovery pattern as IGX using `/sys/class/infiniband/*`
- Configure first CX7 host netdev to `192.168.0.101/24`
- Add route to `192.168.0.2/32`
- Set RX ring to `4096`

#### AGX Thor

- Treat container build as `--igpu`
- Prefer following repo docs if present for the exact MGBE interface naming
- If running Linux socket based examples, increase receive buffers similar to AGX Orin
- Do not assume `eno1`; detect the active 10GbE/MGBE interface from the repo/docs or system state

When network setup cannot be safely inferred, stop and tell the user exactly what interface name you need.

#### Auto-reboot and reconnection

Some Phase 2 steps (e.g., setting MAXN power mode on AGX Orin) trigger an automatic reboot. Follow the **auto-reboot and reconnection** shared procedure (see "Auto-reboot and reconnection" section under "Execution rules") for the reboot, SSH polling, and verification steps.

##### Phase 2 ordering when reboot is needed

When a reboot is required, structure Phase 2 in two blocks:

**Pre-reboot block** (single SSH heredoc):
1. Docker daemon check
2. `rmem_max` sysctl configuration
3. Network interface configuration (nmcli)
4. Any other config that persists across reboots
5. Set MAXN power mode → triggers reboot

**Post-reboot block** (new SSH heredoc after reconnection):
1. Verify MAXN is active
2. `jetson_clocks` service setup and start
3. PTP setup (`phc2sys`, `ptp4l`)
4. DLA compiler install
5. NGC login check — and propagate credentials to all users (see "NGC login for all users" below)
6. xhost / display detection (all users — see the xhost section under Phase 4)
7. Board ping

If no reboot is needed (already MAXN), run all sub-steps in a single heredoc block.

#### NGC login for all users

`docker login nvcr.io` stores credentials in `~/.docker/config.json`, which is per-user. After the current user has successfully logged in to NGC, propagate the Docker credentials to **all** human users on the devkit so that any user can pull NGC container images:

```bash
# After the current user has a working NGC login, copy credentials to all human users
SRC_DOCKER_CONFIG="$HOME/.docker/config.json"
if [ -f "$SRC_DOCKER_CONFIG" ]; then
  for u in $(awk -F: '$3 >= 1000 && $1 != "nobody" {print $1}' /etc/passwd); do
    DEST_DIR="/home/$u/.docker"
    if [ "$u" != "$USER" ]; then
      sudo mkdir -p "$DEST_DIR"
      sudo cp "$SRC_DOCKER_CONFIG" "$DEST_DIR/config.json"
      sudo chown -R "$u:$(id -gn "$u")" "$DEST_DIR"
    fi
  done
  echo "NGC credentials propagated to all users"
fi
```

If NGC login has not been configured yet, ask the user to run `docker login nvcr.io` with their NGC API key, then propagate as above.

### Phase 3 - native build of CLI tools (AGX Thor only)

AGX Thor supports running `hololink-enumerate` and other C++ tools **natively on the host**, outside the demo container. This phase builds those tools so they can be used directly from the CLI.

#### Prerequisites

Before building, verify these are installed on the Thor:

- **CUDA toolkit** — expected at `/usr/local/cuda-13.0` (ships with JP 7.1)
- **Holoscan SDK** — `sudo apt install -t r38.4 holoscan=3.9.0-2` (check with `dpkg -l holoscan`)
- **cmake** — version 3.22+
- **Build libraries** — `libfmt-dev`, `libssl-dev`, `libcurlpp-dev`, `libyaml-cpp-dev`, `libibverbs-dev`, `python3-dev`

If any are missing, install them following the AGX Thor tab in `docs/user_guide/setup.md` in the repo. The full dependency install command is:

```bash
sudo apt-get update
PINNED_NVCOMP=5.0.0.6-1
sudo apt install -y git-lfs cmake libfmt-dev libssl-dev libcurlpp-dev libyaml-cpp-dev libibverbs-dev python3-dev \
      libnvcomp5-cuda-13=${PINNED_NVCOMP} \
      libnvcomp5-dev-cuda-13=${PINNED_NVCOMP} \
      libnvcomp5-static-cuda-13=${PINNED_NVCOMP} \
      nvcomp-cuda-13=${PINNED_NVCOMP}
sudo apt-mark hold libnvcomp5-cuda-13 libnvcomp5-dev-cuda-13 libnvcomp5-static-cuda-13 nvcomp-cuda-13
```

#### Build steps

```bash
export PATH=/usr/local/cuda-13.0/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-13.0/lib64:$LD_LIBRARY_PATH
cd <repo-root>
mkdir -p build && cd build
cmake -DHOLOLINK_BUILD_PYTHON=OFF ..
make -j$(nproc) hololink-enumerate
```

This produces the native binary at `<repo-root>/build/tools/enumerate/hololink-enumerate`.

To build all native C++ tools and examples (including SIPL/FuSa CoE examples), use:

```bash
cmake -DHOLOLINK_BUILD_SIPL=1 -DHOLOLINK_BUILD_FUSA=1 ..
make -j$(nproc)
```

#### Verification

After building, run a quick sanity check:

```bash
ls -la <repo-root>/build/tools/enumerate/hololink-enumerate
```

The binary should exist and be executable.

### Phase 4 - build, run demo container, and verify connectivity

From the repo root:

```bash
sh docker/build.sh --igpu
```

or

```bash
sh docker/build.sh --dgpu
```

Before running the build:

- confirm repo root
- print the chosen mode and why
- if the build script is not executable, use `sh` explicitly

#### Common build failure handling

- **Docker permission denied**
  - Add all non-system human users to the `docker` group (see Phase 1 for the command) and reboot if not already done in Phase 1.
  - If the user permits sudo, apply safe remedy where possible.
- **NGC/auth or image pull errors**
  - explain that NVIDIA container pulls may require `docker login nvcr.io`
  - ask the user to authenticate if needed
  - after successful login, propagate credentials to all human users (see "NGC login for all users" in Phase 2)
- **network timeout / DNS failures**
  - retry once
  - then surface the failing pull/build stage
- **disk space issues**
  - report `df -h`
  - suggest targeted cleanup
- **missing git-lfs content**
  - run `git lfs pull`
  - retry the build

### Container lifecycle management

**All `docker run` invocations** in this workflow must follow these rules to prevent orphaned containers that block ports and consume resources:

#### Always use `--name` and `--rm`

Every `docker run` must include `--name <unique_name>` and `--rm` so the container is identifiable and auto-removed on exit.

#### Never rely on `timeout` alone to stop a container

`timeout` sends SIGTERM/SIGKILL to the `docker run` **client process**, but the container itself keeps running in the Docker daemon. This means `timeout N docker run ...` does **not** stop the container.

**Correct pattern** — use a background subshell with an explicit `docker stop`:

```bash
# Start container in detached mode
docker run -d --name my_container --rm [flags] hololink-demo:$VERSION <command>

# Collect logs for up to N seconds, then force-stop
timeout $N docker logs -f my_container 2>&1 || true
docker stop -t 2 my_container 2>/dev/null || true
```

Or for short-lived commands where you want output inline:

```bash
CONTAINER_NAME="hsb_enumerate_$$"
docker run -d --name "$CONTAINER_NAME" --rm [flags] hololink-demo:$VERSION <command>

# Wait up to N seconds for output
( sleep $N; docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null ) &
WATCHDOG_PID=$!
docker logs -f "$CONTAINER_NAME" 2>&1 || true
kill $WATCHDOG_PID 2>/dev/null
wait $WATCHDOG_PID 2>/dev/null
```

#### Force-stop on timeout or failure

Whenever a phase finishes (success or failure), ensure **no orphaned containers** remain:

```bash
docker stop -t 2 <container_name> 2>/dev/null || true
docker rm -f <container_name> 2>/dev/null || true
```

#### Before running a container that binds a shared port

Check for and stop any conflicting containers first:

```bash
docker rm -f <previous_container_name> 2>/dev/null || true
sudo ss -ulnp | grep <port_or_pattern> || true
```

This is especially important for `hololink enumerate` and `hololink-enumerate`, which both bind the same UDP broadcast port and cannot coexist.

#### Run the demo container

**Scope**: This sub-step verifies that the demo container **starts correctly** and that the Holoscan SDK and hololink package are available inside it. Do **not** run `hololink enumerate`, `hololink-enumerate`, or any command that communicates with the HSB board in this phase. All board-facing commands belong in the ping-and-enumerate sub-step below.

Acceptable verification commands during container startup inside the container:

- `echo "Container started successfully"`
- `python3 -c "import hololink; print(hololink.__version__)"` (may fail gracefully — that is OK)
- `ls /usr/local/bin/hololink*` (list available binaries)

Do **not** run: `hololink enumerate`, `hololink-enumerate`, `ping 192.168.0.2`, or any sensor/camera example.

##### xhost over SSH

When running over SSH, `DISPLAY=:0` often does not exist. Detect the correct display:

1. Check which X sockets exist: `ls /tmp/.X11-unix/`
2. Check active GUI sessions: `w` (look for a `tty` login with a desktop session)
3. Set `DISPLAY` to match (e.g., if `X1` exists, use `DISPLAY=:1`)

Then grant Docker X11 access for **all** human users on the devkit (not just the current user). This ensures any user who logs into the devkit can run GUI containers without re-running `xhost`:

```bash
# Detect the active display
DISPLAY_NUM=$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | tr -d 'X')
export DISPLAY=":${DISPLAY_NUM:-0}"

# Grant xhost access for every human user
for u in $(awk -F: '$3 >= 1000 && $1 != "nobody" {print $1}' /etc/passwd); do
  XAUTH_FILE="/home/$u/.Xauthority"
  if [ -f "$XAUTH_FILE" ]; then
    XAUTHORITY="$XAUTH_FILE" xhost +local:docker 2>/dev/null || true
  fi
done

# Also run for the current user as a fallback
export XAUTHORITY="/home/$USER/.Xauthority"
xhost +local:docker 2>/dev/null || xhost + 2>/dev/null || true
```

If `xhost +local:docker` still fails for all users, fall back to `xhost +`.

##### demo.sh requires a TTY — use docker run directly over SSH

`demo.sh` hardcodes `docker run -it`, which fails over non-interactive SSH with:

```
the input device is not a TTY
```

**Resolution**: When running over SSH, invoke `docker run` directly without the `-it` flag, replicating all other arguments from `demo.sh`. Always use a unique `--name` so the container can be force-stopped if it hangs or exceeds a timeout:

```bash
cd /path/to/holoscan-sensor-bridge
VERSION=$(cat VERSION)
CONTAINER_NAME="hsb_demo_$$"
docker run \
    --rm \
    --net host \
    --gpus all \
    --runtime=nvidia \
    --shm-size=1gb \
    --privileged \
    --name "$CONTAINER_NAME" \
    -v $PWD:$PWD \
    -v $ROOT:$ROOT \
    -v $HOME:$HOME \
    -v /sys/bus/pci/devices:/sys/bus/pci/devices \
    -v /sys/kernel/mm/hugepages:/sys/kernel/mm/hugepages \
    -v /dev:/dev \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    -v /tmp/argus_socket:/tmp/argus_socket \
    -v /sys/devices:/sys/devices \
    -v /var/nvidia/nvcam/settings:/var/nvidia/nvcam/settings \
    -w $PWD \
    -e NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility,display \
    -e NVIDIA_VISIBLE_DEVICES=all \
    -e DISPLAY=$DISPLAY \
    -e enableRawReprocess=2 \
    hololink-demo:$VERSION \
    <command>
```

**Cleanup after every container run**: If a container may hang or run indefinitely, always ensure it is stopped afterward:

```bash
docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

When running from a local GUI session (not SSH), `sh docker/demo.sh` works as-is.

If the selected platform is iGPU and the container prints:

- `Failed to detect NVIDIA driver version`

report that this is expected and continue.

If visualizer access fails or apps segfault, verify:

- `DISPLAY` is set to the correct value (not necessarily `:0`)
- `XAUTHORITY` points to the user's `.Xauthority` file
- `xhost +local:docker` or equivalent ran on the host

#### Ping and summarize

Verify host connectivity to the board:

```bash
ping -c 4 192.168.0.2
```

If ping succeeds:

- clearly say the HSB board is reachable on the control plane
- note that successful ping alone does **not** prove enumeration or data plane health
- run `hololink enumerate` inside the container using the detached + watchdog pattern described in "Container lifecycle management". The enumerate command runs indefinitely with no `--count` flag, so you **must** force-stop the container after collecting enough output. Use the following pattern:

  ```bash
  CONTAINER_NAME="hsb_enumerate_$$"
  docker run -d --name "$CONTAINER_NAME" --rm \
      [all standard flags] \
      hololink-demo:$VERSION \
      hololink enumerate

  # Watchdog: force-stop after 10 seconds
  ( sleep 10; docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null ) &
  WATCHDOG_PID=$!

  # Collect output until the container stops
  docker logs -f "$CONTAINER_NAME" 2>&1 || true

  # Clean up watchdog
  kill $WATCHDOG_PID 2>/dev/null
  wait $WATCHDOG_PID 2>/dev/null

  # Ensure container is gone (belt and suspenders)
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  ```

  Collect whatever responses appear in that window, then print MAC address, FPGA version, and board type. Do not wait longer than 10 seconds.

##### Board type detection via UUID

Parse the `fpga_uuid` field from the enumerate output to determine the board type:

| `fpga_uuid` | Board Type |
|---|---|
| `889b7ce3-65a5-4247-8b05-4ff1904c3359` | HSB Lattice (CPNX100-ETH-SENSOR-BRIDGE) |
| `f1627640-b4dc-48af-a360-c55b09b3d230` | Leopard Imaging VB1940 (Eagle Camera) |

If the `fpga_uuid` field is present and matches one of the known UUIDs, report the board type. If the UUID is not reported (older firmware) or does not match either known value, note the board type as unknown and continue — the user may provide it later. Save the detected board type as `BOARD_TYPE` (`lattice` or `vb1940` or empty) in the session state.

##### Native enumerate on AGX Thor

On AGX Thor, **also** run `hololink-enumerate` natively (outside the container) using the binary built in Phase 3:

```bash
cd <repo-root>/build
timeout 5 ./tools/enumerate/hololink-enumerate
```

**Important**: the native binary and the containerized `hololink enumerate` both bind the same UDP broadcast port. They cannot run simultaneously. Before running the native binary:

1. Force-stop any running demo/hololink containers: `docker stop -t 2 <name> 2>/dev/null; docker rm -f <name> 2>/dev/null`
2. Check for lingering listeners: `sudo ss -ulnp | grep holo`
3. If the port is still in use, identify and stop the holding process

If the native enumerate fails with `bind failed with errno=98: "Address already in use"`, this is the cause — stop the conflicting container or process, then retry.

Compare the native output with the container output. Both should report the same MAC address, FPGA version, and serial number. The native binary may additionally report `fpga_uuid` and `board` fields. If the container enumerate did not report `fpga_uuid`, check whether the native output includes it and use it for board type detection (see "Board type detection via UUID" above).

##### FPGA version verification

After collecting the enumerate output, verify that the FPGA version is compatible with the HSB host software version on the devkit.

**Step 1 — Extract the FPGA version.** Parse the FPGA version from the `hololink enumerate` output (look for `fpga_version` or a four-digit version like `24XX` or `25XX`). If enumerate did not report an FPGA version, fall back to reading register 0x80 inside the demo container:

```bash
CONTAINER_NAME="hsb_regread_$$"
docker run -d --name "$CONTAINER_NAME" --rm \
    [all standard flags] \
    hololink-demo:$VERSION \
    python3 -c "
import hololink
# Read register 0x80 to extract FPGA version
# Adapt the exact API call based on the installed hololink version
"

timeout 15 docker logs -f "$CONTAINER_NAME" 2>&1 || true
docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

If both methods fail, report the failure and note that FPGA version could not be verified. Inform the user that the `/hsb-flash` skill will assume the FPGA version is 2407 (oldest supported) if they choose to flash later.

**Step 2 — Read the HSB software version.** Get the software version from the repo's `VERSION` file:

```bash
HSB_VERSION=$(cat VERSION 2>/dev/null | tr -d '[:space:]')
echo "HSB software version: $HSB_VERSION"
```

**Step 3 — Check compatibility.** Use the following known compatibility mapping. The FPGA version must match the HSB software version's expected FPGA. If the repo or user guide documents a different mapping, prefer that.

| HSB Software Version | Expected FPGA Version |
|---|---|
| v2.0.0 | 2407 or 2412 |
| v2.2.0, v2.3.1 | 2507 |
| v2.5.0 | 2510 |
| v2.6.0+ | Check `docs/user_guide/` in the repo for the required FPGA version |

**Step 4 — Report and suggest.** If the detected FPGA version does not match the expected version for the installed HSB software:

```
WARNING: FPGA version mismatch detected.
  Detected FPGA version: <DETECTED_FPGA>
  HSB software version:  <HSB_VERSION>
  Expected FPGA version: <EXPECTED_FPGA>

The HSB board firmware does not match the host software.
You can use the /hsb-flash skill to flash the board to FPGA version <EXPECTED_FPGA>:
  /hsb-flash

This is not a blocking error — setup is complete — but applications may not
work correctly until the FPGA firmware is updated.
```

If the versions match, confirm:

```
FPGA version verified: <DETECTED_FPGA> matches HSB software <HSB_VERSION>.
```

If the FPGA version could not be determined, note it as an unverified item in the Phase 5 issues report and inform the user that `/hsb-flash` will assume FPGA version 2407 as the starting point if they choose to flash.

If ping fails:

- explain whether the failure looks like routing, link, power, or interface-selection related
- check:
  - board power state
  - cable seating
  - host interface static IP
  - route to `192.168.0.2`
  - `ip addr`
  - `ip route`
  - `nmcli con show`
- **prompt the user** asking if the board might be at a different IP address. If the user provides an alternative IP, retry ping and enumerate with that address instead.
- if ping works but later enumeration does not, explain possible firmware mismatch rather than connectivity loss. The FPGA version verification step above will detect and report any mismatch — suggest `/hsb-flash` if needed

### Phase 5 - issues report

Produce a summary report of every issue encountered during the workflow and how it was resolved. For each issue, include:

- What happened (the symptom or error)
- Root cause (why it happened)
- Resolution (what fix was applied, or why no fix was needed)
- Whether the issue is blocking or non-blocking

Also include a final summary table showing all phases and their pass/fail status.

**Allow the user to export the report.** After displaying the report, ask:

```
Would you like to save this report to a file? [Y/n]
```

If the user agrees, write the report to an `.md` file in the repo root directory (or `REMOTE_ROOT` if no repo) with a timestamped filename, e.g., `hsb-setup-report-2026-03-20.md`. If running remotely, create the file on the remote host. Confirm the file path after saving.

### Phase 6 - close applications and hand off to user

After the issues report is complete (or whenever the workflow ends), clean up and return control of the devkit to the user:

1. **Stop any running containers** started by the skill:

   ```bash
   # Stop any HSB containers that may still be running
   docker ps --filter "name=hsb_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
   docker ps --filter "name=hololink" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
   ```

2. **Exit any active container shells** — ensure no container sessions are left open.

3. **Navigate to the repo home directory** so the user's terminal is ready for work:

   ```bash
   cd $REMOTE_ROOT/$REPO_DIR
   ```

4. **Print a handoff message**:

   ```
   Setup complete. You are now at the repo root directory: $REMOTE_ROOT/$REPO_DIR
   All containers have been stopped. The devkit is ready for your use.
   ```

5. **Run session teardown** (see below).

### Session teardown (after final phase)

After Phase 6 (or whenever execution ends, including on failure), clean up the remote session state:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_session"
```


## Output style

Be operational and concrete.

### Verbose mode (`--verbose`)

Show full command output and use this detailed structure:

```text
Phase 2 — Host network setup
Status: partial
Ran:
- detected interface enP5p3s0f0np0
- created/updated NetworkManager connection hololink-enP5p3s0f0np0
Failure:
- ping 192.168.0.2 timed out
Likely cause:
- board not powered or cable not seated on port 0
Repair attempted:
- re-activated NetworkManager connection
Next:
- ask user to confirm board power and SFP+/QSFP cabling, then retry ping

Proceed to Phase 3? [Y/n]
```

### Concise mode (default, no `--verbose`)

Suppress raw output and use this compact structure:

```text
**Phase 2 — Host network setup**
- Docker daemon running
- Network interface mgbe0_0 configured: 192.168.0.101/24
- Route to 192.168.0.2 confirmed
- rmem_max set to 31326208
- PTP services (phc2sys, ptp4l) active
- Board ping: 4/4 packets, 0% loss
- Status: PASS

Proceed to Phase 3? [Y/n]
```

With an issue:

```text
**Phase 2 — Host network setup**
- Docker daemon running
- Network interface mgbe0_0 configured: 192.168.0.101/24
- Board ping: FAILED (timeout)
- Attempted fix: re-activated nmcli connection
- Board ping after fix: 4/4 packets, 0% loss
- Status: PASS

> Issue: Initial ping to 192.168.0.2 timed out
> Cause: NetworkManager connection was down
> Resolution: Re-activated hololink-mgbe0_0 connection
> Blocking: No (resolved)

Proceed to Phase 3? [Y/n]
```

## Auto-approve mode (`--y`)

The skill supports a `--y` flag that skips all phase gates and runs the entire workflow from start to finish without waiting for user confirmation between phases. This is **not recommended** for normal use — interactive phase gates exist to give the user control over each step and the opportunity to review results, ask questions, or abort.

### Detecting the flag

Check whether `$ARGUMENTS` contains `--y` (case-insensitive). Strip all flags from arguments before further parsing.

### Confirmation warning

When `--y` is detected, **do not proceed immediately**. First, display a warning and ask the user to confirm:

```
⚠  WARNING: Auto-approve mode (--y) is enabled.

This is NOT RECOMMENDED. All phase gates will be skipped and the entire
workflow will run without pausing for your confirmation between phases.

You will not be able to review intermediate results, ask questions, or
abort between phases. All output will be saved to a timestamped log file.

Are you sure you want to continue with auto-approve mode? [yes/NO]
```

- If the user responds with **"yes"** (exact match, case-insensitive) → enable auto-approve mode and proceed.
- Any other response (including "y", "ok", blank, etc.) → cancel auto-approve mode, inform the user that the skill will run in normal interactive mode, and proceed without `--y`.

This double-confirmation is intentional — auto-approve mode bypasses a critical safety mechanism.

### Behavior when `--y` is active

1. **Phase gates are skipped**: After each phase summary, do not prompt `Proceed to Phase <N+1>? [Y/n]`. Instead, immediately proceed to the next phase.

2. **Log file**: At the start of the workflow (before Phase 0), create a timestamped log file to record all output:

   - **Log file name**: `hsb-setup-log-YYYY-MM-DD-HHMMSS.md`
   - **Log file location**: If running remotely, save to `$REMOTE_ROOT/` on the remote host. If running locally, save to the current working directory.
   - **Log content**: Accumulate the full phase summary (concise or verbose, depending on `--verbose`) for every phase, including any issues encountered and how they were resolved.
   - **Announce the log file** at the start:
     ```
     Auto-approve mode active. All output will be saved to:
       <log_file_path>
     ```

3. **Phase summaries are still shown**: Even though phase gates are skipped, still display each phase summary to the user so they can follow progress in real time.

4. **At the end of the workflow**, write the final accumulated log to the log file and inform the user:
   ```
   Workflow complete. Full log saved to:
     <log_file_path>
   ```

5. **Failures still stop the workflow**: If a phase fails and the recovery playbook cannot fix it, stop the workflow even in auto-approve mode. Write the log up to that point and report the failure. Do not skip failures.

### Combining with other flags

- `--y --verbose`: Auto-approve with full raw output. Log file contains verbose output.
- `--y --repo <URL>`: Auto-approve with a custom repo.
- `--y` alone: Auto-approve with concise output (default).


## Verbosity mode (`--verbose`)

The skill supports a `--verbose` flag that controls how much output is shown to the user during execution.

### Detecting the flag

Check whether `$ARGUMENTS` (the text after the slash command) contains any of: `--help` / `-h`, `--verbose`, `--y`, or `--repo <URL>` (case-insensitive). Strip all flags (and their values) from arguments before parsing the platform name.

- If `--help` or `-h` is present, print the built-in help text (see "Built-in help" section) and stop — do not run the workflow.
- If `--y` is present, enter auto-approve mode (see "Auto-approve mode" section).
- To extract the repo URL: match `--repo` followed by a whitespace-separated URL token. Example: `--repo https://github.com/myorg/my-fork.git`.

### Behavior when `--verbose` is **set**

This is the **full-log mode** (the legacy/default behavior prior to this feature):

- Show the complete raw output of every SSH command as it executes.
- Show full tables of all prerequisite checks (even passing ones).
- Show Docker build output, cmake output, and full enumerate logs.
- Show the detailed phase status block (phase name, what ran, result, next action) after each phase.

### Behavior when `--verbose` is **not set** (default / concise mode)

Show a **concise bullet-point summary** after each phase. The user should be able to follow progress at a glance without scrolling through raw logs.

Rules for concise mode:

1. **Do NOT show raw command output** to the user. Still execute the same SSH heredoc commands, but suppress their output from the conversation. Internally parse the output to extract status information.

2. **After each phase, show exactly this structure:**

   ```
   **Phase N — <phase title>**
   - <bullet 1: key outcome or action taken>
   - <bullet 2: key outcome or action taken>
   - ...
   - Status: PASS / PARTIAL / FAIL
   ```

   Keep bullets to 3–6 items max. Each bullet should be one short sentence.

3. **Issues get special treatment.** If any issue was encountered during the phase (a command failed, a package was missing, a config needed fixing), add an `Issues:` block:

   ```
   **Phase N — <phase title>**
   - <bullet>
   - <bullet>
   - Status: PASS

   > Issue: `nvidia-l4t-dla-compiler` package not found
   > Cause: Package is L4T/Orin-specific, not available on Thor JP 7.1
   > Resolution: Skipped — not needed for core HSB functionality
   > Blocking: No
   ```

   If there are multiple issues, list each one with the same 4-line format.

4. **Tables are OK** for structured data that benefits from alignment (e.g., the final board summary in Phase 4, the Phase 5 issues report). Keep them compact.

5. **Phase 1 prerequisite checks**: Instead of showing every check line, show a single summary like:
   ```
   - Prerequisites: git 2.43.0, git-lfs 3.4.1, docker 29.1.4, cmake 4.2.3, xhost — all OK
   - Missing: nvidia-l4t-dla-compiler (non-blocking)
   ```

6. **Phase 4 (container build)**: Instead of showing Docker build output, show:
   ```
   - Building `hololink-demo:2.5.0` with `--igpu` mode
   - Build completed (all layers cached / N layers rebuilt)
   - Image size: 8.9 GB
   ```

7. **Phase 4 (enumerate)**: Show the board summary table but not the raw repeated enumerate lines. Include the FPGA version verification result (match or mismatch with HSB software version).

### Example: concise mode full run

```
**Phase 1 — Confirm platform, clone repo, and study user guide**
- SSH connectivity verified to ubuntu@10.111.67.36
- Platform auto-detected: AGX Thor (product_name: NVIDIA Jetson AGX Thor)
- Session initialized
- Prerequisites: git 2.43.0, git-lfs 3.4.1, docker 29.1.4, cmake 4.2.3, xhost — all OK
- CUDA 13.0 found, Holoscan SDK 3.9.0-2 installed
- Repo cloned at /home/work/holoscan-sensor-bridge (main, up to date)
- User guide studied — platform-specific setup identified
- Hardware topology diagram presented — user confirmed setup matches
- Status: PASS

Proceed to Phase 2? [Y/n]
```

## Phase gate — user confirmation between phases

After completing each phase (Phases 0–5), **always prompt the user for confirmation** before starting the next phase. This gives the user a chance to review results, ask questions, or abort.

**Exception**: When `--y` (auto-approve mode) is active, phase gates are skipped and all phases run automatically. See "Auto-approve mode (`--y`)" section for details.

### Prompt format

After the phase summary (verbose or concise), end with:

```
Proceed to Phase <N+1>? [Y/n]
```

### User response handling

- **"y"**, **"yes"**, **"Y"**, **blank/empty**, **"1"**, **"ok"**, **"go"**, **"continue"**, **"next"** → proceed to the next phase.
- **"n"**, **"no"**, **"stop"**, **"abort"** → stop execution. Print:
  ```
  Workflow paused after Phase N. You can resume by re-invoking the skill.
  ```
  Then run session teardown.
- **Any other text** → treat as a question or instruction about the current phase. Answer it, then re-prompt with the same `Proceed to Phase <N+1>?` question.
- **If the user asks to re-run the current phase** (e.g., "retry", "run phase 3 again") → re-execute that phase, show the summary again, then re-prompt.

### Exceptions

- **Phase 6** (close applications and hand off) is the final phase — do not prompt after it. Just show the handoff message and run session teardown.
- **If a phase FAILs** and the recovery playbook cannot fix it, do not prompt to proceed. Instead stop and report the failure clearly.

### Combining with verbose mode

The phase gate applies in **both** verbose and concise modes. The only difference is how much detail appears before the prompt.


## Persistent SSH session model

When running from Linux/Windows in SSH-native mode, open a **single SSH session per phase** and run **all commands for that phase in one remote shell invocation** using a heredoc block. This avoids re-authenticating for every command, preserves shell state (working directory, environment variables) within each phase, and maintains state across phases via a remote session file.

**Do NOT run individual SSH commands for each remote operation.** Instead, compose all commands for a phase into a single heredoc block and execute them in one SSH call.

### Session lifecycle

1. **Session init** (before Phase 1): Validate SSH connectivity, then create a remote state directory.
2. **Phase execution**: Each phase runs as a **single SSH call** with a heredoc block. All commands execute sequentially in the same remote shell. At the end of each block, save the working directory and key environment variables to a remote state file.
3. **Session teardown** (after final phase): Clean up the remote state directory.

### SSH command prefix

Use key-based SSH authentication consistently for **all** remote calls:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
# ... commands ...
REMOTE
```

### Heredoc execution pattern (all phases)

Every phase MUST follow this pattern — a single SSH call with all phase commands inside:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
set -e

# ── restore state from previous phase ──
source /tmp/.claude_hsb_session/state.sh 2>/dev/null || true
cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

# ── phase commands ──
echo "=== Phase N: description ==="
command1
command2
command3

# ── save state for next phase ──
mkdir -p /tmp/.claude_hsb_session
{
  echo "export _CLAUDE_CWD=\"$(pwd)\""
  echo "export PATH=\"$PATH\""
  echo "export LD_LIBRARY_PATH=\"${LD_LIBRARY_PATH:-}\""
  # preserve any phase-specific vars (VERSION, DISPLAY, etc.)
  env | grep -E '^(VERSION|DISPLAY|XAUTHORITY|EN0|IN0)=' | sed 's/^/export /' 2>/dev/null
} > /tmp/.claude_hsb_session/state.sh
REMOTE
```

Replace `__REMOTE_ROOT__` with the literal value of `$REMOTE_ROOT` when composing the heredoc. Since the heredoc uses single-quoted `'REMOTE'`, local shell variables are **not** expanded — you must inline their values.

For commands that are allowed to fail without stopping the phase, append `|| true`:
```bash
docker info || true   # daemon may not be running yet
ping -c 1 -W 2 192.168.0.2 || true
```

### Privileged commands inside the heredoc

When `REMOTE_SUDO` is non-empty, prefix privileged commands with it inside the heredoc:

```bash
# Inside the heredoc block:
ensure_hololink_connection "hololink-$EN0" "$EN0" "192.168.0.101/24" "192.168.0.2/32" "4096" "4096"
sudo sysctl -p ...
```

### Session init (before Phase 1)

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
mkdir -p /tmp/.claude_hsb_session
echo "export _CLAUDE_CWD=\"__REMOTE_ROOT__\"" > /tmp/.claude_hsb_session/state.sh
echo "session initialized"
REMOTE
```

### File transfer

File transfers still use individual commands (they cannot be part of the heredoc):

```bash
scp $REMOTE_SSH_OPTS localfile $SSH_TARGET:/remote/path
```

### General rules

- Wrap remote paths in single quotes inside the heredoc.
- Use `REMOTE_ROOT` as the parent directory for cloning and builds.
- If the user is on Linux or Windows and environment variables are not set, tell them to load the wrapper config first, then continue.
- When a phase needs to read intermediate output (e.g., detect an interface name) and make decisions before continuing, split into two heredoc blocks within the same phase if necessary. Always save and restore state between blocks.

### SSH connectivity validation (mandatory before session init)

Before executing any remote work, validate that key-based SSH authentication works. If it fails, **automatically diagnose and fix the issue** rather than asking the user to do it manually. The full resolution flow is below.

#### Step 1 — Test connectivity

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
```

If this succeeds, print the following and proceed to session init:

```
SSH connectivity verified to $SSH_TARGET — opening persistent session
```

If it fails, continue to Step 2.

#### Step 2 — Diagnose the failure

Classify the error output:

| Error pattern | Diagnosis |
|---|---|
| `Permission denied (publickey)` or `Permission denied (publickey,password)` | Key not accepted — agent not running, key not loaded, or public key not deployed |
| `Connection refused` | SSH daemon not running on remote host, or wrong port |
| `Connection timed out` or `No route to host` | Network/firewall issue — host unreachable |

For **Connection refused** or **timed out**: report the error and stop. These require the user to fix network or SSH daemon issues on the remote host.

For **Permission denied**: proceed to Step 3 (automatic SSH key remediation).

#### Step 3 — Ensure a local SSH key exists

This process works the same on both **Windows (Git Bash / MSYS2)** and **Linux**.
If your system does not follow these conventions, adjust paths and commands accordingly.

Discover the first available SSH public key on the host. Search in priority order:

```bash
SSH_PUBKEY=""
for candidate in ~/.ssh/id_ed25519.pub ~/.ssh/id_ecdsa.pub ~/.ssh/id_rsa.pub; do
  if [ -f "$candidate" ]; then
    SSH_PUBKEY="$candidate"
    break
  fi
done
# Also check for non-standard key names
if [ -z "$SSH_PUBKEY" ]; then
  SSH_PUBKEY=$(ls ~/.ssh/*.pub 2>/dev/null | head -n 1)
fi
echo "Found public key: ${SSH_PUBKEY:-NONE}"
```

- If **a public key is found**, note its path (store as `$SSH_PUBKEY`) and proceed to Step 4. Derive the private key path by stripping the `.pub` suffix (e.g., `~/.ssh/id_ecdsa.pub` → `~/.ssh/id_ecdsa`). Use `$SSH_PUBKEY` and the derived private key path in all subsequent steps instead of hardcoding a key filename.
- If **no SSH key exists** (`$SSH_PUBKEY` is empty), tell the user:

  ```
  No SSH key pair found on this machine. I will generate one now.
  ```

  Then generate a new Ed25519 key pair non-interactively (empty passphrase for automation):

  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "$USER@$(hostname)"
  SSH_PUBKEY=~/.ssh/id_ed25519.pub
  ```

  After generation, confirm the key files exist:

  ```bash
  ls -la ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub
  ```

  Then proceed to Step 4.

#### Step 4 — Ensure the SSH agent is running and the key is loaded

These instructions apply to both **Windows (Git Bash / MSYS2)** and **Linux**, but details for launching an agent in some Linux distros or desktop environments may differ. The following works for most typical shells:

```bash
ssh-add -l 2>&1
```

- If the output contains `Could not open a connection to your authentication agent` or `Error connecting to agent`:

  Start the agent and load the key discovered in Step 3 (`$SSH_PUBKEY` minus the `.pub` suffix):

  ```bash
  eval $(ssh-agent -s)
  ssh-add "${SSH_PUBKEY%.pub}"
  ```

- If the agent is running but lists no identities (`The agent has no identities`):

  Load the key:

  ```bash
  ssh-add "${SSH_PUBKEY%.pub}"
  ```

- If the agent already has the key loaded, proceed to Step 5.

After loading, verify:

```bash
ssh-add -l
```

> **Note for Linux Desktop Users:**
> Some desktop environments automatically run an SSH agent and may even provide a keyring for passphrase unlock.
> If you have a GUI popup asking for a passphrase, accept it to unlock your key.
> For advanced scenarios (like custom key locations, no agent, or agent forwarding), consult your system's documentation for `ssh-agent` usage.

#### Step 5 — Retry SSH with the loaded key

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
```

If this succeeds, print:

```
SSH connectivity verified to $SSH_TARGET — opening persistent session
```

If it still fails with `Permission denied`, the public key is **not deployed** on the remote host. Proceed to Step 6.

#### Step 6 — Deploy the public key to the remote host

Tell the user:

```
SSH key-based authentication failed — your public key is not yet authorized on the remote host.
```

**Do not attempt to deploy the key automatically.** Instead, present the following manual commands as the **first and recommended option**, based on the user's OS.

Extract the userid and host from `$SSH_TARGET` (e.g., if `SSH_TARGET=nvidia@10.111.66.223`, userid is `nvidia` and host is `10.111.66.223`).

Use the public key discovered in Step 3 (`$SSH_PUBKEY`). Use the **actual filename** found on the machine — do not hardcode a specific key type.

**For Windows**
Tell the user to run this command in a **separate Windows PowerShell terminal**:

```powershell
Get-Content "$env:USERPROFILE\.ssh\<key_filename>.pub" | ssh <userid>@<host> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Replace `<key_filename>` with the actual key filename discovered in Step 3 (e.g., `id_ed25519`, `id_ecdsa`, `id_rsa`, or any custom name). Replace `<userid>@<host>` with the actual `$SSH_TARGET` value.

> **Note**: Do not use `type %USERPROFILE%\...` — that is CMD syntax and will fail in PowerShell. Always use `Get-Content "$env:USERPROFILE\..."` for PowerShell.

**For Linux (including Git Bash/MSYS2):**
Tell the user to run this command in a **separate Linux terminal**:

```bash
cat ~/.ssh/<key_filename>.pub | ssh <userid>@<host> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Replace `<key_filename>` with the actual key filename discovered in Step 3 (e.g., `id_ed25519`, `id_ecdsa`, `id_rsa`, or any custom name). Replace `<userid>@<host>` with the actual `$SSH_TARGET` value.

Tell the user:
```
This will prompt you for the password for <userid>@<host> once.
After it completes, come back here and tell me to retry.
```

**Wait for the user to confirm** they have run the appropriate command (or that it failed) before trying any other approach. Do not suggest alternative options until the user reports this one did not work.

Only if the user explicitly says the above command failed, then suggest these fallback options:

1. Use `ssh-copy-id` (available on Linux or Git Bash):
   ```bash
   ssh-copy-id -i $SSH_PUBKEY <userid>@<host>
   ```
   (where `$SSH_PUBKEY` is the key discovered in Step 3)
2. Manually copy the contents of the discovered public key file and append them to `~/.ssh/authorized_keys` on the remote host via any available access method (console, BMC, another SSH session).

#### Step 7 — Final verification

After deployment, re-test with `BatchMode=yes`:

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
```

- If this succeeds: print `SSH key deployed and verified — opening persistent session` and proceed to session init.
- If this still fails: stop and report:

  ```
  SSH key deployment did not resolve the issue. Please verify:
  1. The password entered was correct for $SSH_TARGET
  2. The remote user's home directory and ~/.ssh have correct ownership
  3. The remote SSH daemon allows pubkey authentication (check /etc/ssh/sshd_config for PubkeyAuthentication yes)
  ```

  Do not retry — report the error and stop.

#### Summary of the auto-remediation flow

```
Test SSH → OK? → proceed
              ↓ (Permission denied)
       Check local keys → none? → generate Ed25519 key
              ↓
       Start agent / load key
              ↓
       Retry SSH → OK? → proceed
              ↓ (still denied)
       Show user the Windows key deploy command (type ... | ssh ...)
              ↓
       Wait for user to confirm → retry SSH → OK? → proceed
              ↓ (user says command failed)
       Show fallback options (ssh-copy-id, manual copy)
              ↓
       Wait for user → retry SSH → OK? → proceed
                                           ↓
                                     Stop with diagnosis
```
