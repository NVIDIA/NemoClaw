# Holoscan Sensor Bridge failure playbook

Use this file to explain failures in a user-friendly, action-oriented way.

## 1. Git clone or refresh fails

### Symptoms

- DNS resolution errors
- GitHub TLS/network timeout
- local repo has modified files blocking checkout

### Response pattern

- Show the failing command
- Say whether it is a network problem, auth problem, or local repo-state problem
- Prefer safe remedies:
  - retry once for transient network failures
  - `git stash` only if the user agrees
  - otherwise clone into a new directory

## 2. Git LFS content missing

### Symptoms

- missing binary/data assets during build
- placeholder pointer files instead of real content

### Remedy

```bash
git lfs install
git lfs pull
```

Then retry only the failed build step.

## 3. Docker access denied

### Symptoms

- `permission denied` on Docker socket
- cannot connect to Docker daemon

### Remedy

```bash
sudo usermod -aG docker $USER
```

Then explain that a reboot or fresh login session is required before group membership takes effect.

## 4. Demo container build fails during image pull

### Likely causes

- not logged in to `nvcr.io`
- intermittent network failure
- proxy/DNS issue

### Remedy

- ask the user to authenticate with Docker if required
- retry once after login
- if still failing, capture the exact image and layer pull error

## 5. Container starts but GUI/visualizer fails

### Symptoms

- segmentation fault from visualizer
- display access denied
- blank white window

### Remedy

- ensure the command is launched from a GUI session
- check `DISPLAY`
- run:

```bash
xhost +local:docker
```

- if needed, retry with `xhost +`

## 6. Ping to 192.168.0.2 fails

### Likely causes

- board not powered
- incorrect cable/port
- wrong host interface configured
- missing static IP or route
- NetworkManager connection not active

### Checks

```bash
ip addr
ip route
nmcli con show
ping -c 4 192.168.0.2
```

Explain the result in plain English.

## 7. Ping works but board is still not usable

### Likely causes

- firmware incompatibility
- enumeration not happening
- data plane not flowing

### Next checks

Inside the demo container:

```bash
hololink enumerate
```

Explain that ping success only confirms basic IP connectivity, not full HSB readiness.

## 8. xhost fails over SSH with "unable to open display"

### Symptoms

- `xhost: unable to open display ":0"` when running via SSH

### Likely cause

The SSH session does not have `DISPLAY` set, or the X server is not on `:0`. On many systems (especially AGX Thor with GNOME), the display may be `:1` or another number.

### Remedy

1. Check existing X sockets: `ls /tmp/.X11-unix/`
2. Check active sessions: `w` (look for a tty login with a desktop session)
3. Set `DISPLAY` to the correct value (e.g., `:1` if `X1` exists)
4. Set `XAUTHORITY=/home/$USER/.Xauthority`
5. Retry `xhost +local:docker`

```bash
export DISPLAY=:1
export XAUTHORITY=/home/$USER/.Xauthority
xhost +local:docker
```

## 9. demo.sh fails with "the input device is not a TTY"

### Symptoms

- Running `sh docker/demo.sh` over SSH produces: `the input device is not a TTY`
- Using `ssh -t` also fails when stdin is not a real terminal (e.g., from Claude Code on Windows)

### Likely cause

`demo.sh` hardcodes `docker run -it`. The `-t` flag requires a TTY, which is not available in non-interactive SSH sessions.

### Remedy

Invoke `docker run` directly without the `-it` flag, replicating all other arguments from `demo.sh` (volumes, environment variables, network, GPU access, working directory). See the Phase 4 section of the skill for the full command template.

When running from a local GUI session on the host (not over SSH), `sh docker/demo.sh` works as-is.

## 10. Native hololink-enumerate fails with "Address already in use"

### Symptoms

- `hololink-enumerate` (native binary) crashes with: `bind failed with errno=98: "Address already in use"`
- Typically on AGX Thor when running the native enumerate after or alongside a Docker container

### Likely cause

The native `hololink-enumerate` and the containerized `hololink enumerate` (Python) both bind the same UDP broadcast port for device discovery. Since the demo container uses `--net host`, they share the host network namespace and conflict.

### Remedy

1. Force-stop all running hololink containers:

```bash
docker ps --format '{{.Names}}' | xargs -r -I{} sh -c 'docker stop -t 2 {} 2>/dev/null; docker rm -f {} 2>/dev/null'
```

2. Verify no process is still holding the port:

```bash
sudo ss -ulnp | grep holo
```

3. If a process remains, kill it by PID:

```bash
sudo kill <pid>
```

4. Retry the native enumerate:

```bash
cd <repo-root>/build
timeout 5 ./tools/enumerate/hololink-enumerate
```

### Prevention

Always force-stop the demo container before running native CLI tools, and vice versa. Use `docker stop -t 2` followed by `docker rm -f` rather than just `docker rm -f`, to give the process a brief grace period before SIGKILL.

## 10a. Orphaned container keeps running after `timeout` kills `docker run`

### Symptoms

- `timeout N docker run --name X ...` exits after N seconds, but `docker ps` still shows container `X` running
- Subsequent containers or native binaries fail with port conflicts
- SSH command completes but the remote container is still consuming resources

### Root cause

`timeout` sends SIGTERM/SIGKILL to the **local `docker run` client process**, not to the container running in the Docker daemon. The container continues running detached.

### Remedy

**Never use `timeout` as the sole mechanism to stop a container.** Instead:

1. Run the container in detached mode (`docker run -d --name ...`)
2. Use `docker logs -f` to stream output
3. Use a background watchdog to stop the container after the desired duration:

```bash
CONTAINER_NAME="hsb_task_$$"
docker run -d --name "$CONTAINER_NAME" --rm [flags] image:tag command

# Watchdog kills the container after N seconds
( sleep N; docker stop -t 2 "$CONTAINER_NAME" 2>/dev/null ) &
WATCHDOG_PID=$!

# Stream logs until the container stops
docker logs -f "$CONTAINER_NAME" 2>&1 || true

# Clean up watchdog process
kill $WATCHDOG_PID 2>/dev/null
wait $WATCHDOG_PID 2>/dev/null

# Belt and suspenders — ensure container is gone
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
```

### Prevention

All container runs in the skill must follow the "Container lifecycle management" section in SKILL.md. Every `docker run` must have a matching cleanup path.

## 11. Native build fails on AGX Thor — missing dependencies

### Symptoms

- `cmake` errors about missing packages (`fmt`, `yaml-cpp`, `OpenSSL`, `curlpp`, `ibverbs`)
- `nvcc not found` during build

### Likely cause

CUDA is installed but not on `PATH`, or build libraries were not installed.

### Remedy

1. Add CUDA to PATH:

```bash
export PATH=/usr/local/cuda-13.0/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-13.0/lib64:$LD_LIBRARY_PATH
```

2. Install missing libraries (from the AGX Thor setup docs):

```bash
sudo apt-get update
sudo apt install -y cmake libfmt-dev libssl-dev libcurlpp-dev libyaml-cpp-dev libibverbs-dev python3-dev
```

3. Re-run cmake and make.

## 12. hololink enumerate does not accept --count flag

### Symptoms

- `hololink enumerate --count 3` fails with: `error: unrecognized arguments: --count 3`

### Likely cause

The `hololink enumerate` CLI does not support a `--count` or iteration-limit flag. It runs indefinitely, printing one enumeration response per second.

### Remedy

Run `hololink enumerate` without `--count`. Collect at least 3 consistent responses from the output, then stop the container (e.g., `docker stop demo` or Ctrl-C). Parse the output for `mac_id`, `hsb_ip_version`, `fpga_crc`, `ip_address`, `serial_number`, and `interface` fields.

## 13. SSH connection lost after nvpmodel reboot

### Symptoms

- `echo "YES" | sudo nvpmodel -m 0` triggers an immediate reboot
- SSH session terminates with `Connection to <host> closed by remote host`
- Subsequent SSH attempts fail with `Connection refused` or `Connection timed out` for 1–3 minutes

### Likely cause

Setting MAXN power mode on AGX Orin requires a reboot. The `nvpmodel` command reboots the device immediately after receiving `YES` confirmation, dropping the SSH connection.

### Remedy

This is expected behavior, not an error. Wait for the device to reboot and poll SSH connectivity:

```bash
for i in $(seq 1 20); do
  sleep 15
  if ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok" 2>/dev/null; then
    echo "Reconnected after ~$((i * 15)) seconds"
    break
  fi
done
```

After reconnecting, verify the power mode change took effect:

```bash
sudo nvpmodel -q
```

Should show `NV Power Mode: MAXN` and mode `0`.

### Prevention

Always structure Phase 3 so that the MAXN/reboot step comes after all other persistent configurations (sysctl, nmcli) have been applied, minimizing the amount of work that needs to be done post-reboot.

## 14. SSH key-based authentication fails from Windows host

### Symptoms

- `ssh -o BatchMode=yes $SSH_TARGET "echo ok"` fails with `Permission denied (publickey)` or `Permission denied (publickey,password)`
- Skill cannot proceed to any remote phases

### Likely causes (check in order)

1. **No SSH key pair exists on the Windows host** — `~/.ssh/` has no `id_ed25519` or `id_rsa` files
2. **SSH agent is not running** — `ssh-add -l` returns `Could not open a connection to your authentication agent`
3. **Key exists but is not loaded** — `ssh-add -l` returns `The agent has no identities`
4. **Public key not deployed on remote host** — key is loaded locally but the remote `~/.ssh/authorized_keys` does not contain it

### Remedy

Follow these steps sequentially, stopping as soon as SSH succeeds:

**1. Check for existing keys:**

```bash
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ls ~/.ssh/id_rsa.pub 2>/dev/null
```

If no key exists, generate one:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "$USERNAME@$(hostname)"
```

**2. Start SSH agent and load the key:**

```bash
eval $(ssh-agent -s)
ssh-add ~/.ssh/id_ed25519 2>/dev/null || ssh-add ~/.ssh/id_rsa 2>/dev/null
```

**3. Retry SSH.** If it still fails, deploy the public key:

```bash
# This will prompt the user for the remote password once
cat ~/.ssh/id_ed25519.pub | ssh -o StrictHostKeyChecking=accept-new $REMOTE_SSH_OPTS $SSH_TARGET "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**4. Final verification:**

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "echo ok"
```

### If deployment still fails

- Verify the password was correct
- Check remote `~/.ssh` ownership: `ls -la ~ ~/.ssh` (should be owned by the target user, not root)
- Check remote SSH config: `grep PubkeyAuthentication /etc/ssh/sshd_config` (must be `yes` or absent/commented)
- Check remote authorized_keys is not world-writable: `stat -c %a ~/.ssh/authorized_keys` (should be `600`)
