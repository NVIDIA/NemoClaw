<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Jetson Dispatch Through Colossus

This temporary path runs the `jetson-nvmap-gpu` end-to-end (E2E) job on one Jetson behind a Colossus host.
GitHub Actions controls the job through an authenticated HTTPS endpoint.
Colossus retains the Cloudflare Tunnel credential, Jetson SSH key, SSH host key, device lock, and cleanup capability.
Candidate code runs only on the Jetson.

Do not set `allow_jetson_dispatch=true` until every deployment check on this page passes.

## Trust Boundary

The deployment has these input and credential boundaries:

| System | Receives | Must not receive |
| --- | --- | --- |
| GitHub-hosted controller | Candidate commit SHA, workflow run identity, public dispatch URL, and short-lived GitHub OpenID Connect (OIDC) token | Jetson SSH key, tunnel credential, and cleanup privilege |
| Colossus dispatcher | Validated workflow identity, fixed target, and candidate commit SHA | Request-controlled command, SSH host, repository, path, or cleanup command |
| Jetson | Candidate checkout and the fixed live E2E command | GitHub OIDC token, tunnel credential, and Colossus SSH private key |

The dispatcher accepts only `NVIDIA/NemoClaw` and the trusted `main` E2E workflow.
It requires a GitHub-hosted controller, one repository ID, one workflow run identity, and the `jetson-nvmap-gpu` target.
It also requires a lowercase 40-character candidate commit SHA.
The temporary path rejects fork repositories.

The credentials have these lifecycles:

| Credential | Location and access | Lifetime and removal |
| --- | --- | --- |
| GitHub OIDC token | GitHub-hosted controller process memory and the authenticated request | The client reuses a token in process memory for at most four minutes and then requests another. It does not write the token to disk. |
| Cloudflare account certificate | The administrator account that runs `cloudflared tunnel login` | Remove `cert.pem` from Colossus after tunnel creation and DNS routing. Reauthenticate before later management changes. |
| Cloudflare Tunnel credential | `/etc/cloudflared/TUNNEL_UUID.json`, readable only by the tunnel service account | Keep it for this temporary deployment. Revoke the tunnel and remove the file when the deployment ends. |
| Jetson SSH private key | `/var/lib/nemoclaw-jetson-dispatch/id_ed25519`, readable only by the dispatcher service account | Keep it for this temporary deployment. Remove the matching Jetson public key and private key when the deployment ends. |

The dispatcher rejects an OIDC token whose issued-to-expiry window exceeds 15 minutes.
The GitHub repository variable contains only the public dispatch URL.
Do not put a credential in `JETSON_DISPATCH_URL`.

## Prepare the Dedicated Jetson

Use a dedicated Jetson without production data or credentials.
The E2E job gives candidate code Docker access, which can control the dedicated host.
Cleanup removes only the fixed job-owned resources defined below.
It does not attest that cleanup reversed every possible host change made by candidate code.

Run these checks as the `nvidia` account that the dispatcher uses:

```bash
set -euo pipefail
uname -m
tr -d '\0' </proc/device-tree/model
cat /etc/nv_tegra_release
node --version
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
'
git --version
npm --version
npm_version="$(npm --version)"
test "${npm_version%%.*}" -ge 10
command -v bash curl docker git node npm ollama timeout
for openshell_component in openshell openshell-gateway openshell-sandbox; do
  if command -v "$openshell_component" >/dev/null 2>&1; then
    echo 'OpenShell must be absent from the prepared Jetson' >&2
    exit 1
  fi
  for host_bin in \
    "/usr/local/bin/$openshell_component" \
    "/usr/bin/$openshell_component" \
    "$HOME/.local/bin/$openshell_component"; do
    test ! -e "$host_bin" && test ! -L "$host_bin"
  done
done
ollama list
docker info --format '{{json .Runtimes}}'
test -c /dev/nvmap
if sudo -n true 2>/dev/null; then echo 'unexpected passwordless sudo'; exit 1; fi
```

The architecture must be `aarch64`.
Node.js must be version 22.19.0 or later, and npm must have major version 10 or later.
OpenShell must be absent from the host `PATH` and the three checked host binary directories.
Do not preinstall OpenShell on the Jetson.
The `ollama list` command must succeed.
Docker must expose the NVIDIA runtime required by the existing Jetson live E2E test.
Preinstall Ollama so candidate code does not invoke its host installer.
The `nvidia` account must not have passwordless `sudo` access.

The worker creates `/var/tmp/nemoclaw-jetson-e2e/<jobId>` and sets these job-local paths:

- `HOME=<workspace>/home`
- `TMPDIR=<workspace>/tmp`
- `XDG_CACHE_HOME=<workspace>/home/.cache`
- `XDG_CONFIG_HOME=<workspace>/home/.config`
- `XDG_DATA_HOME=<workspace>/home/.local/share`
- `XDG_STATE_HOME=<workspace>/home/.local/state`
- `XDG_BIN_HOME=<workspace>/home/.local/bin`
- `XDG_RUNTIME_DIR=<workspace>/runtime`
- `npm_config_prefix=<workspace>/npm-prefix`
- `PATH=$XDG_BIN_HOME:<workspace>/npm-prefix/bin:$PATH`

The worker unsets `DBUS_SESSION_BUS_ADDRESS` so onboarding uses OpenShell's existing standalone fallback when the job-local systemd user service cannot load.
The worker must not set `NEMOCLAW_DEFER_OPENSHELL_INSTALL`.
It must not invoke `scripts/install-openshell.sh`.
The existing live E2E runs `bash install.sh --non-interactive`.
NemoClaw onboarding owns the compatible pinned OpenShell installation in the job workspace.
After onboarding, `nemoclaw`, `openshell`, `openshell-gateway`, and `openshell-sandbox` must resolve canonically inside the job workspace.
The worker rejects a symbolic link or resolved path that leaves that workspace.

Reserve these names and paths for this E2E target:

- The current dispatcher-created `/var/tmp/nemoclaw-jetson-e2e/<jobId>` workspace.
- The `/tmp/nemoclaw-services-e2e-jetson-nvmap` helper-service directory.
- The `e2e-jetson-nvmap` NemoClaw and OpenShell sandbox name.
- The `nemoclaw` OpenShell gateway name and forwards for the named sandbox.
- The recorded `ollama-auth-proxy`, OpenShell Docker gateway, and helper `cloudflared` processes.
- OpenShell-managed Docker containers labeled for `e2e-jetson-nvmap`.
- The volumes recorded from those labeled containers.
- The `openshell-cluster-nemoclaw` gateway container, volume, and recorded attached volumes.
- `nemoclaw-sandbox-local` images whose tag begins with `e2e-jetson-nvmap-`.

Do not run unrelated work under these reserved names.
The cleanup program must act only on this allowlist.

Before candidate execution, the worker records this protected tool and model baseline:

- The resolved Node.js path and version.
- The resolved npm path and version.
- The resolved Ollama path and the sorted pre-existing Ollama model names and IDs.
- The required absence of host-level `openshell`, `openshell-gateway`, and `openshell-sandbox` binaries.

The Ollama list accepts at most 64 sorted, unique model name and ID rows whose decoded content is at most 3 KiB.
The SSH probe output is limited to 4 KiB, while the persisted baseline record and its reader are limited to 8 KiB.
Before candidate execution, the worker serializes the baseline and rejects it if persistence would exceed that 8 KiB read bound.
The dispatcher stores the recorded values in a private `<jobId>.baseline.json` state file.
After cleanup, the worker repeats the probes and requires every pre-existing Ollama model name and ID to remain.
Additional models installed by the job, such as `qwen3.5:9b`, are allowed only while the post-cleanup list stays within the same row and size bounds.
An oversized post-cleanup list fails cleanup and retains the device lock without removing any model.
Before and after candidate execution, the worker also requires `/dev/nvmap` and the Docker NVIDIA runtime to be available.
The worker keeps the record through cleanup and device-lock release so startup recovery can repeat the same comparison.
The host retention policy may remove it only after no device lock exists.
Before a replay of the same job ID, the worker removes the earlier record and writes a new record before it invokes candidate code.
If the initial baseline probe fails, the worker never invokes candidate code; cleanup verifies current prerequisites and allowlisted-resource absence without a before-and-after comparison.

These other host resources also remain outside the cleanup allowlist:

- Node.js, npm, and the Docker engine.
- The Ollama binary, service, models, configuration, and unrelated `ollama serve` processes.
- The NVIDIA container runtime and Docker images that the test does not own exclusively.
- The `/dev/nvmap` character device and its permissions.
- JetPack, Jetson Linux, CUDA, NVIDIA packages, other `apt` packages, SDK Manager, and downloaded flashing files.
- User accounts, SSH keys, and user files outside the current job workspace and named NemoClaw resources.
- Docker resources without the exact label, repository tag, or name association defined above.
- Processes other than the recorded job-home helper processes defined above.
- Colossus credentials, service configuration, and job evidence.

The cleanup program must not change or remove any resource outside its allowlist.
It never removes Ollama models.
Review its command construction and target resolution before deployment.
Do not use broad process termination, Docker pruning, wildcard paths, or host-wide package removal.

## Prepare the Colossus Dispatcher Account and Deployment Command

Run these commands on Colossus.
The dispatcher requires `/usr/bin/node` 22.19.0 or later.

```bash
set -euo pipefail
/usr/bin/node --version
/usr/bin/node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
'
sudo useradd --system --create-home \
  --home-dir /var/lib/nemoclaw-jetson-dispatch \
  --shell /usr/sbin/nologin nemoclaw-jetson-dispatch
sudo install -d -o nemoclaw-jetson-dispatch -g nemoclaw-jetson-dispatch -m 0700 \
  /var/lib/nemoclaw-jetson-dispatch
```

Bootstrap the deployment command from a separately reviewed checkout of `https://github.com/NVIDIA/NemoClaw.git`.
Replace the placeholder with the full lowercase 40-character SHA of that reviewed checkout:

```bash
set -euo pipefail
REVIEWED_BOOTSTRAP_SHA=0000000000000000000000000000000000000000
test "$(git remote get-url origin)" = https://github.com/NVIDIA/NemoClaw.git
test "$(git rev-parse HEAD)" = "$REVIEWED_BOOTSTRAP_SHA"
test -z "$(git status --short)"
sudo install -o root -g root -m 0755 \
  tools/e2e/colossus-jetson-dispatch-deploy.sh \
  /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy
test "$(sudo stat --format='%F:%u:%g:%a' -- \
  /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy)" = \
  'regular file:0:0:755'
```

The deployment command requires root and accepts only `--commit <full lowercase 40-character SHA>`.
It rejects any additional argument.
The command does not update its installed copy.
Install a reviewed deployment-command revision separately when that command changes.

The Colossus service runs the dispatcher files from the selected reviewed release.
The GitHub-hosted controller runs the client from the trusted workflow commit.
The Colossus service never checks out candidate code.

Create a dedicated SSH key owned by the service account:

```bash
sudo -u nemoclaw-jetson-dispatch ssh-keygen -t ed25519 -N '' \
  -f /var/lib/nemoclaw-jetson-dispatch/id_ed25519
```

Add the public key to the Jetson `nvidia` account.
Restrict it to the Colossus source IP address and disable SSH session features that the worker does not use.
For the default USB link, the entry has this shape:

```text
from="192.168.55.100",restrict ssh-ed25519 AAAA...
```

Capture the Jetson host key and verify its fingerprint through the serial console or another trusted channel:

```bash
set -euo pipefail
umask 077
known_hosts_tmp="$(mktemp /tmp/nemoclaw-jetson-known-hosts.XXXXXX)"
trap 'rm -f -- "$known_hosts_tmp"' EXIT
ssh-keyscan -T 10 -H 192.168.55.1 >"$known_hosts_tmp"
ssh-keygen -lf "$known_hosts_tmp"
sudo install -o nemoclaw-jetson-dispatch -g nemoclaw-jetson-dispatch -m 0600 \
  "$known_hosts_tmp" /var/lib/nemoclaw-jetson-dispatch/known_hosts
rm -f -- "$known_hosts_tmp"
trap - EXIT
```

The pinned `known_hosts` file validates the SSH host identity separately from the persisted cleanup baseline.
Do not accept a changed host key without reconciling it through the serial console or another trusted channel.

## Define the Cleanup Program

The deployment command installs `/usr/local/libexec/nemoclaw-jetson-cleanup` as a root-owned stable symbolic link to `/opt/nemoclaw-jetson-dispatch/current/tools/e2e/jetson-dispatch-cleanup.sh`.
The selected target file is owned by `root:root` with mode `0755`.
One atomic `current` switch selects both the dispatcher code and cleanup program, so an interruption cannot select them from different releases.
The deployed worker configuration must name that exact cleanup path.
The worker accepts the symbolic link only when root owns it, its target is the exact managed `current` cleanup program, and that target passes the regular executable ownership and write-permission checks.
It rejects arbitrary cleanup symbolic links and an unsafe managed target.
The deployment command accepts no cleanup path, resource selector, or cleanup-scope override.
Review a release that changes the cleanup allowlist separately before deployment.

It must accept no arguments and must not be group- or world-writable.
It must derive the lowercase 64-character job ID from the private dispatcher `device.lock`.
It must reject a missing or malformed lock instead of selecting a broader target.
The bundled program fixes the state directory, SSH files, SSH destination, and cleanup names listed on this page.
Changing one of those values requires a corresponding reviewed source change.
The dispatcher invokes it after success, failure, cancellation, and timeout.
The dispatcher also invokes it during startup when `device.lock` remains from an interrupted service process.

Before destructive cleanup, the program discovers and validates the job-owned Docker volume and process identities.
It accepts a helper or forward PID only when its environment has the exact job `HOME` and its command has one of these markers:

- `ollama-auth-proxy.`
- `openshell-gateway`
- `openshell-forward`
- `openshell forward`
- `cloudflared`

Discovery, worker absence verification, and the teardown probe fail closed when the owner, environment, or command of a live same-user process cannot be read from `/proc`.
A process that disappears during inspection or is identified as owned by a different user is ignored.
It merges them into a mode-`0600` private `<jobId>.cleanup.json` record on Colossus.
The record survives retries so stale-lock recovery can clean and verify the same identities.
The cleanup program must not execute OpenShell or any other executable installed in the job workspace.

The destructive phase must perform these bounded actions:

1. Stop recorded helper and forward PIDs after verifying the process owner, exact job `HOME`, and command marker.
2. Remove the exact labeled sandbox containers and exact gateway container.
3. Remove the recorded volumes and reserved test image tags.
4. Remove the helper-service directory and `/var/tmp/nemoclaw-jetson-e2e/<validated-job-id>` workspace for the locked job.
5. Independently verify that the allowlisted resources are absent, host OpenShell remains absent, the protected tools match, and every pre-existing Ollama model name and ID remains.

The cleanup program must be idempotent.
It must treat an already absent allowlisted resource as success.
It must exit nonzero when target ownership is ambiguous, cleanup fails, or absence verification is inconclusive.
It must not remove `/var/lib/nemoclaw-jetson-dispatch/state/device.lock`.
The dispatcher removes that lock only after cleanup and absence verification succeed.

The private cleanup record uses this path:

```text
/var/lib/nemoclaw-jetson-dispatch/state/<jobId>.cleanup.json
```

The file has this exact schema:

```json
{
  "schemaVersion": 1,
  "volumes": ["example-volume"],
  "processIds": [1234]
}
```

Either identity array can be empty.
The helper merges new identities with the existing record and cleans every recorded identity.
Any helper failure or interruption keeps the device lock for startup recovery.
The dispatcher retains the cleanup record after it removes the device lock.

After the helper succeeds, the worker independently verifies these conditions over pinned-host-key SSH:

- The validated job workspace is absent and is not a symbolic link.
- No OpenShell-managed container has the `e2e-jetson-nvmap` sandbox label.
- The `openshell-cluster-nemoclaw` gateway container and volume are absent.
- No `nemoclaw-sandbox-local` image has a tag that begins with `e2e-jetson-nvmap-`.
- Every Docker volume and process ID in the merged cleanup record is absent.
- Every recorded Node.js, npm, and Ollama tool value matches, and every pre-existing Ollama model name and ID remains.
- No host-level `openshell`, `openshell-gateway`, or `openshell-sandbox` binary resolves or exists in a checked host binary path.
- `/dev/nvmap` exists, and Docker still reports the NVIDIA runtime.

The worker reports cleanup failure when any helper or independent verification step fails.

The dispatcher runs the cleanup program as `nemoclaw-jetson-dispatch`.
The managed service unit prevents privilege elevation.
Do not remove that protection or grant the dispatcher account passwordless `sudo` access.

## Configure the Dispatcher Service

Review these fixed files in the selected commit before deployment:

- `tools/e2e/colossus-jetson-dispatch.environment`
- `tools/e2e/nemoclaw-jetson-dispatch.service`

The environment fixes the repository ID, state path, timeouts, Jetson SSH destination, pinned SSH files, and cleanup executable.
The unit fixes the service account, selected-release working directory, Node.js command, restart policy, and filesystem restrictions.
It sets `TimeoutStopSec=360` so systemd allows the bounded cleanup interval during service stop.

For an initial deployment, the dispatcher service must have `LoadState=not-found`.
The device lock, destination environment file, and destination unit file must be absent.
The Cloudflare Tunnel service must be absent or both disabled and inactive.

Replace the placeholder with the full lowercase 40-character SHA of the reviewed release, then run one command:

```bash
sudo nemoclaw-colossus-jetson-dispatch-deploy --commit 0000000000000000000000000000000000000000
```

The command reports five stages:

1. Validate the request, service-owned home, dispatcher account, SSH key, pinned host key, and Node.js version.
2. Verify the absent service, device lock, destination files, and public ingress.
3. Fetch and verify the exact commit from `https://github.com/NVIDIA/NemoClaw.git`.
4. Select the dispatcher and cleanup code with one atomic `current` switch.
5. Install, enable, start, and verify the dispatcher service.

The command accepts an absent cleanup link or verifies the exact managed link before release selection.
It stores each verified release at `/opt/nemoclaw-jetson-dispatch/releases/<sha>`.
Each release directory must be owned by `root:root` with mode `0755`.
The command verifies the fixed origin, exact commit, unmodified worktree, cleanup program, environment, and unit before selection.
It installs `/etc/nemoclaw-jetson-dispatch/environment` as `root:root` mode `0600`.
It installs `/etc/systemd/system/nemoclaw-jetson-dispatch.service` as `root:root` mode `0644`.
It runs `systemctl daemon-reload` and `systemctl enable --now nemoclaw-jetson-dispatch.service`.
It requires the Cloudflare Tunnel service to be absent or disabled and inactive immediately before the dispatcher starts, immediately after it starts, and after loopback verification.
Before success, it also requires the dispatcher to listen only on `127.0.0.1:8787` and an anonymous job request to return HTTP `401`.

If initial startup or verification fails after enablement, the command attempts to disable and stop the service before rollback.
It restores the prior release and cleanup selection only after proving exact `ActiveState=inactive` and an absent device lock.
An earlier selection or configuration-installation failure restores the prior selection and removes only files or links created by the attempt.
Rollback removes any environment and unit that the attempt installed, reloads systemd, and requires `LoadState=not-found`.
If it cannot establish these conditions, it reports rollback failure.
If initial activation detects public ingress and rollback cannot disable and stop the dispatcher, its state is inconclusive.
Immediately disable or delete public ingress through the approved Cloudflare administrator path and prove that the public endpoint is unavailable before local recovery.
The command never enables or starts the Cloudflare Tunnel service.
It accepts no cleanup override and does not change the cleanup allowlist.

After the command returns, test cleanup-program access and the SSH path as the service account:

```bash
sudo -u nemoclaw-jetson-dispatch test -x \
  /usr/local/libexec/nemoclaw-jetson-cleanup
sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -o BatchMode=yes \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
  -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
  nvidia@192.168.55.1 'uname -m'
```

Do not invoke the cleanup program manually without the dispatcher-created device lock and baseline record.
The proof-job procedure below exercises cleanup and verifies its result.

For independent verification or recovery, repeat the command's loopback checks:

```bash
set -euo pipefail
test "$(sudo systemctl show --property=ActiveState --value \
  nemoclaw-jetson-dispatch.service)" = active
listeners="$(sudo ss -H -ltn 'sport = :8787')"
test -n "$listeners"
printf '%s\n' "$listeners" | awk '$4 != "127.0.0.1:8787" { exit 1 }'
HTTP_CODE="$(
  curl --disable --noproxy '*' --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --max-time 5 --request POST \
    --header 'Content-Type: application/json' \
    --data '{"schemaVersion":1,"target":"jetson-nvmap-gpu","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowRunId":"1","workflowRunAttempt":1}' \
    http://127.0.0.1:8787/v1/jobs
)"
test "$HTTP_CODE" = 401
```

A malformed request returns HTTP `400`, and an unknown route returns HTTP `404`.

## Deploy a Later Reviewed Commit

This procedure applies after the tunnel has been published once.
Use the installed deployment command for each later reviewed release:

```bash
(
  set -euo pipefail
  tunnel_verified=0
  stop_unverified_tunnel() {
    original_status=$?
    trap - EXIT
    if [ "$tunnel_verified" = 1 ]; then
      exit "$original_status"
    fi

    set +e
    sudo systemctl stop nemoclaw-jetson-tunnel.service
    stop_status=$?
    observed_state="$(sudo systemctl show --property=ActiveState --value \
      nemoclaw-jetson-tunnel.service)"
    inspection_status=$?
    set -e

    exit_status=$original_status
    if [ "$exit_status" -eq 0 ]; then
      exit_status=1
    fi
    if [ "$inspection_status" -ne 0 ]; then
      state_report=unknown
    elif [ -n "$observed_state" ]; then
      state_report=$observed_state
    else
      state_report=empty
    fi
    if [ "$stop_status" -ne 0 ] || [ "$inspection_status" -ne 0 ] || \
      [ "$observed_state" != inactive ]; then
      printf 'PUBLIC INGRESS CONTAINMENT FAILED: tunnel stop status=%s; ActiveState=%s; inspection status=%s\n' \
        "$stop_status" "$state_report" "$inspection_status" >&2
    fi
    exit "$exit_status"
  }
  trap stop_unverified_tunnel EXIT

  REVIEWED_COMMIT_SHA=0000000000000000000000000000000000000000
  sudo systemctl stop nemoclaw-jetson-tunnel.service
  test "$(sudo systemctl show --property=ActiveState --value \
    nemoclaw-jetson-tunnel.service)" = inactive
  sudo /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy \
    --commit "$REVIEWED_COMMIT_SHA"
  sudo systemctl start nemoclaw-jetson-tunnel.service
  test "$(sudo systemctl show --property=ActiveState --value \
    nemoclaw-jetson-tunnel.service)" = active
  PUBLIC_HTTP_CODE="$(
    curl --disable --noproxy '*' --silent --show-error --output /dev/null \
      --write-out '%{http_code}' --max-time 10 --request POST \
      --header 'Content-Type: application/json' \
      --data '{"schemaVersion":1,"target":"jetson-nvmap-gpu","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowRunId":"1","workflowRunAttempt":1}' \
      https://jetson-e2e.example.com/v1/jobs
  )"
  test "$PUBLIC_HTTP_CODE" = 401
  tunnel_verified=1
)
```

The tunnel stop and exact `ActiveState=inactive` check happen before the deployer can change the dispatcher release.
The subshell installs an `EXIT` trap before tunnel operations and leaves its `tunnel_verified` sentinel unset until every check succeeds.
On any earlier exit, the trap disables itself, records the tunnel stop status, and independently inspects `ActiveState`.
Only a successful stop, successful inspection, and exact `ActiveState=inactive` confirm local public-ingress containment.
The trap preserves the original nonzero status, or returns `1` for an otherwise successful unverified exit.
When it cannot confirm containment, it reports `PUBLIC INGRESS CONTAINMENT FAILED` with the stop status and observed or unknown state.
The deployer completes only after the dispatcher starts and its local loopback bind and anonymous HTTP `401` checks pass.
Only after that successful return does the block start the tunnel, require `ActiveState=active`, and repeat a config-free, direct anonymous HTTP `401` check through the public endpoint.
The tunnel remains running only when the block sets `tunnel_verified=1` after all three checks succeed.

It accepts only systemd `LoadState` values `loaded` and `not-found`.
Both cases require `device.lock` to be absent before release preparation.
A loaded service is eligible only when `current` selects one managed release and the stable cleanup link follows `current`.
For a loaded service, the command performs these actions:

1. Require the Cloudflare Tunnel service to be disabled and inactive, then stop the dispatcher.
2. Query dispatcher `ActiveState` and require the exact value `inactive`.
3. Refuse deployment when `/var/lib/nemoclaw-jetson-dispatch/state/device.lock` remains.
4. Validate the managed `current` release and stable cleanup link, then prepare and verify the requested release.
5. Require the tunnel to remain disabled and inactive, then atomically switch `current`, selecting the requested dispatcher code and cleanup program together.
6. Require the tunnel to remain disabled and inactive immediately before and after starting the dispatcher.
7. Verify that only `127.0.0.1:8787` listens and make a config-free, direct request with `curl --disable --noproxy '*'`; the anonymous job request must return HTTP `401`.
8. Require the tunnel to remain disabled and inactive after loopback verification.

If the stop or post-stop inspection cannot prove `inactive`, dispatcher state is inconclusive and the command does not prepare or select a release.
If `device.lock` remains after a proven stop, the command exits with the service stopped and does not prepare or select a release.
Do not remove the lock.
Complete the recovery procedure on this page before you rerun deployment.
If the loaded service's pre-stop public-ingress check fails, the previously verified dispatcher remains running and unchanged.

An interruption before the atomic `current` switch leaves the previous dispatcher and cleanup program selected; an interruption after it selects both from the requested release.
If activation, start, or loopback verification fails for a loaded service, rollback must first stop the service successfully, require `ActiveState=inactive`, and require `device.lock` to be absent.
Only then does it atomically restore the prior `current` selection, which restores both the dispatcher and cleanup program.
If rollback cannot prove those three conditions after the requested pair is selected, it leaves that new code and cleanup pair selected and reports rollback failure.
When an earlier selected release exists, it restarts that release and repeats the loopback verification.
That rollback restart passes the same tunnel checks before and after start and after loopback verification.
If public ingress activates after a dispatcher start, the command attempts to stop it and does not restart either release while ingress remains active.
If that stop, the `ActiveState` inspection, or the device-lock check fails, dispatcher state is inconclusive.
When no prior selection exists, rollback removes the new `current` and stable cleanup link.
If rollback cannot restore a verified service, the command exits with an explicit rollback failure.
When the trap confirms `ActiveState=inactive`, keep the tunnel stopped while you complete dispatcher recovery.
If it reports `PUBLIC INGRESS CONTAINMENT FAILED`, do not assume that the tunnel stopped.
Immediately disable or delete the public ingress through the approved Cloudflare administrator path and confirm that the public endpoint is unavailable.
Keep the dispatcher stopped until the tunnel is confirmed disabled and inactive and the public endpoint is unavailable.
Then rerun the complete later-deployment subshell instead of starting the dispatcher manually.
The deployer repeats the ingress gates and local bind and authentication verification before the subshell can publish the tunnel again.
Its exit trap keeps the tunnel stopped unless `ActiveState=active` and the config-free, direct public HTTP `401` proof both succeed.

A later deployment does not modify the dispatcher environment, systemd unit, SSH credentials, or Cloudflare credentials.
It does not update itself.
Normal deployment requires the selected release to preserve the documented cleanup allowlist.
A cleanup-scope change requires separate review and a corresponding runbook update before deployment.
After every later deployment, repeat the authenticated successful, controlled-failure, and cancellation proof jobs under [Configure GitHub and Run a Proof Job](#configure-github-and-run-a-proof-job).

## Publish the Dispatcher With Cloudflare Tunnel

Install `cloudflared` from the approved package source for Colossus.
The next commands create a public DNS route to the authenticated dispatcher.
Do not create the route until the loopback authentication check returns HTTP `401` for an anonymous request.
Use an administrator account to create one named tunnel and route one DNS hostname:

```bash
cloudflared tunnel login
cloudflared tunnel create nemoclaw-jetson-dispatch
cloudflared tunnel route dns nemoclaw-jetson-dispatch jetson-e2e.example.com
```

Record the tunnel UUID from the create command.
Substitute it for `TUNNEL_UUID` in each later command and file.
Create a dedicated `cloudflared` service account if the approved package did not create one:

```bash
sudo useradd --system --create-home --home-dir /var/lib/cloudflared \
  --shell /usr/sbin/nologin cloudflared
```

Install only the tunnel credential for that account:

```bash
sudo install -d -o cloudflared -g cloudflared -m 0700 /etc/cloudflared
sudo install -o cloudflared -g cloudflared -m 0600 \
  "$HOME/.cloudflared/TUNNEL_UUID.json" /etc/cloudflared/TUNNEL_UUID.json
sudo -u cloudflared test -r /etc/cloudflared/TUNNEL_UUID.json
rm "$HOME/.cloudflared/cert.pem" "$HOME/.cloudflared/TUNNEL_UUID.json"
```

The removed `cert.pem` authorizes Cloudflare account management.
Do not give it to the tunnel service account.

Create `/etc/cloudflared/jetson-dispatch.yml` with mode `0600` and the tunnel service account as owner:

```yaml
tunnel: TUNNEL_UUID
credentials-file: /etc/cloudflared/TUNNEL_UUID.json
ingress:
  - hostname: jetson-e2e.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run `cloudflared` as its own restricted service account.
Install `/etc/systemd/system/nemoclaw-jetson-tunnel.service`:

```ini
[Unit]
Description=NemoClaw Jetson Cloudflare Tunnel
After=network-online.target nemoclaw-jetson-dispatch.service
Wants=network-online.target

[Service]
Type=simple
User=cloudflared
Group=cloudflared
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/jetson-dispatch.yml tunnel run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

Start the tunnel service and inspect its status:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nemoclaw-jetson-tunnel.service
sudo systemctl status nemoclaw-jetson-tunnel.service
```

The origin service validates the GitHub OIDC signature and claims on every job, status, cancel, and artifact request.
Cloudflare Tunnel does not replace origin authentication.
Apply a Cloudflare rate limit to `/v1/jobs*` if the managed zone supports one.
Without that rate limit, origin authentication still rejects unauthorized work, but public requests can consume dispatcher connections.

Confirm the public endpoint also rejects an anonymous request with HTTP `401`.
Confirm Colossus has outbound HTTPS access to GitHub's OIDC key endpoint:

```bash
PUBLIC_HTTP_CODE="$(
  curl --disable --noproxy '*' --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --max-time 10 --request POST \
    --header 'Content-Type: application/json' \
    --data '{"schemaVersion":1,"target":"jetson-nvmap-gpu","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowRunId":"1","workflowRunAttempt":1}' \
    https://jetson-e2e.example.com/v1/jobs
)"
test "$PUBLIC_HTTP_CODE" = 401
curl --fail-with-body \
  https://token.actions.githubusercontent.com/.well-known/jwks
```

## Configure GitHub and Run a Proof Job

The next command updates a repository Actions variable.
Set the public HTTPS origin as a repository Actions variable:

```bash
gh variable set JETSON_DISPATCH_URL --repo NVIDIA/NemoClaw \
  --body 'https://jetson-e2e.example.com'
```

Resolve the non-fork pull request (PR) and trusted workflow identities.
Replace `1234` with the PR number:

```bash
set -euo pipefail
PR_NUMBER=1234
PR_JSON="$(gh api "repos/NVIDIA/NemoClaw/pulls/$PR_NUMBER")"
CANDIDATE_REPOSITORY="$(jq -r .head.repo.full_name <<<"$PR_JSON")"
CANDIDATE_SHA="$(jq -r .head.sha <<<"$PR_JSON")"
BASE_SHA="$(jq -r .base.sha <<<"$PR_JSON")"
git fetch --prune origin main
WORKFLOW_SHA="$(git rev-parse origin/main)"
test "$CANDIDATE_REPOSITORY" = NVIDIA/NemoClaw
[[ "$CANDIDATE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[a-f0-9]{40}$ ]]
```

Select only the Jetson target from the trusted `main` workflow:

```bash
gh workflow run .github/workflows/e2e.yaml --repo NVIDIA/NemoClaw --ref main \
  -f targets=jetson-nvmap-gpu \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_dispatch=true \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=$PR_NUMBER" \
  -f "checkout_sha=$CANDIDATE_SHA" \
  -f "checkout_repository=$CANDIDATE_REPOSITORY" \
  -f "base_sha=$BASE_SHA" \
  -f "workflow_sha=$WORKFLOW_SHA" \
  -f review_reason='Reviewed the commit under review for the isolated Jetson E2E.'
```

The `jetson-nvmap-gpu` job uses the fixed `jetson-nvmap-gpu-colossus` concurrency group.
`queue: max` queues every dispatch, and `cancel-in-progress: false` prevents automatic cancellation.

The controller must run on `ubuntu-latest`.
The GitHub controller log must show one `Jetson dispatch accepted as <jobId>` line.
The Colossus journal must not contain a bearer token.
The uploaded `e2e-jetson-nvmap-gpu` artifact must contain `jetson-dispatch.json` with these results:

- The requested candidate commit SHA and workflow run ID and attempt.
- The Jetson model, JetPack package version or `unavailable`, Jetson Linux release, and kernel.
- The test conclusion and bounded log.
- `status.cleanup: "succeeded"`.
- `status.conclusion: "success"` for the successful proof job.

Download the trusted `e2e-dispatch-<run-id>-<attempt>` receipt artifact and the `e2e-jetson-nvmap-gpu` artifact.
Set `RUN_ID` and `RUN_ATTEMPT` from the selected workflow run:

```bash
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
RUN_ID=123456789
RUN_ATTEMPT=1
gh run download "$RUN_ID" --repo NVIDIA/NemoClaw \
  --name "e2e-dispatch-$RUN_ID-$RUN_ATTEMPT" \
  --dir "$EVIDENCE_DIR/trusted-dispatch"
gh run download "$RUN_ID" --repo NVIDIA/NemoClaw \
  --name e2e-jetson-nvmap-gpu \
  --dir "$EVIDENCE_DIR/jetson"
DISPATCH_JSON="$EVIDENCE_DIR/trusted-dispatch/dispatch.json"
JETSON_JSON="$EVIDENCE_DIR/jetson/jetson-dispatch.json"
```

Require `dispatch.json` to establish the repository, PR number, base SHA, candidate SHA, and trusted workflow SHA independently:

```bash
jq -e \
  --arg repository NVIDIA/NemoClaw \
  --arg candidateRepository "$CANDIDATE_REPOSITORY" \
  --arg candidateSha "$CANDIDATE_SHA" \
  --arg baseSha "$BASE_SHA" \
  --arg workflowSha "$WORKFLOW_SHA" \
  --arg workflowRunId "$RUN_ID" \
  --argjson prNumber "$PR_NUMBER" \
  --argjson workflowRunAttempt "$RUN_ATTEMPT" '
    .kind == "nemoclaw-e2e-dispatch-v2" and
    .repository == $repository and
    .candidateRepository == $candidateRepository and
    .candidateRepository == .repository and
    .candidateSha == $candidateSha and
    .prNumber == $prNumber and
    .baseSha == $baseSha and
    .workflowSha == $workflowSha and
    .workflowRunId == $workflowRunId and
    .workflowRunAttempt == $workflowRunAttempt and
    .allowJetsonDispatch == true
  ' "$DISPATCH_JSON"
```

Then bind `jetson-dispatch.json` to that trusted receipt by comparing its candidate SHA and workflow run ID and attempt:

```bash
jq -e --slurpfile dispatch "$DISPATCH_JSON" '
  .status.request.candidateSha == $dispatch[0].candidateSha and
  .status.request.workflowRunId == $dispatch[0].workflowRunId and
  .status.request.workflowRunAttempt == $dispatch[0].workflowRunAttempt and
  .status.cleanup == "succeeded" and
  .status.conclusion == "success"
' "$JETSON_JSON"
```

It must also contain `jetson-e2e-artifacts.tar.gz`.
The dispatcher creates that archive from the remote E2E artifact directory before it removes the candidate workspace.
It rejects an artifact directory or compressed archive larger than 1 MiB.
During initialization, the dispatcher validates the schema, request, job ID, and state in every private file whose basename matches `^[a-f0-9]{64}\.json$`.
For a completed record, it also validates the terminal fields.
It ignores valid queued or running records and restores only the 128 newest completed statuses to memory.
An invalid matching file fails initialization before the dispatcher accepts work, and the error names its exact `<jobId>.json` basename.
Status and artifact requests both restore an evicted completed status from its private file.
Only an artifact request returns the persisted log and archive.
A repeated deterministic dispatch returns the persisted completed status without rerunning candidate code or clearing its evidence.
Before worker execution, the dispatcher creates `device.lock`, persists the queued status, and synchronizes the Colossus state directory.
If queued-state persistence or that directory synchronization fails, candidate code does not run and the dispatcher does not unlink the exact live job lock.
Because a failed directory synchronization cannot prove reboot durability, inspect the live state and restart the dispatcher service to invoke startup cleanup without rebooting the Colossus host.
The dispatcher persists terminal status before it removes `device.lock`.
After removing the lock, it synchronizes the state directory.
If terminal-status persistence fails, it reports a completed in-memory failure and retains the lock.
If the lock-removal directory synchronization fails and restoration succeeds, it re-establishes the exact same job lock, synchronizes the directory again, and reports the lock-removal failure.
If restoration fails, lock state is inconclusive; the dispatcher sets an in-memory recovery barrier, blocks later dispatches, and reports that operator recovery is required during shutdown.

After the workflow completes, independently verify every allowlisted resource is absent.
Require the private `<jobId>.cleanup.json` file and verify every recorded volume and process ID is absent.
The private cleanup record is Colossus state and is not part of the uploaded artifact.
Then run one controlled failing candidate.
Confirm that its `jetson-dispatch.json` artifact shows `status.cleanup: "succeeded"` and `status.conclusion: "failure"`.
Require its private cleanup record and verify every recorded identity is absent.
For a cancellation proof, cancel a controller after it logs the job ID.
The controller can exit before it downloads an artifact.
Inspect the private Colossus `<jobId>.json` status for `conclusion: "cancelled"` and `cleanup: "succeeded"`.
Independently verify the cleanup allowlist after that cancellation.

These checks establish bounded cleanup of the allowlisted resources.
They do not attest that cleanup reversed every possible host change made by candidate code.

## Recover or Disable the Deployment

The dispatcher permits one active job.
A process interruption leaves `device.lock` in the state directory.
On startup, the dispatcher invokes the cleanup program before it removes that stale lock or accepts more work.
After successful cleanup, a valid queued or running record for the locked job becomes a durable completed failure with `cleanup: "succeeded"` and error `Jetson dispatcher restarted before terminal status was persisted`.
Only then does the dispatcher remove the lock; if this recovery persistence fails, the lock remains.
A repeated deterministic dispatch returns that recovered failure without rerunning candidate code.
If cleanup fails, startup fails or the completed job reports `conclusion: "cleanup-failed"` with `cleanup: "failed"`.
If cleanup succeeds but lock removal fails, the completed job reports `conclusion: "cleanup-failed"` with `cleanup: "succeeded"`.
The lock remains after a cleanup failure or successful lock restoration.
A lock-restoration failure does not prove whether the lock exists.
Bounded status error text retains the newest cleanup, persistence, or lock-removal error.

If the service stops before durable persistence completes, destructive cleanup has not started.
If it stops after durable persistence, the cleanup record and device lock remain for startup recovery.
On startup, the helper discovers current identities and merges them with every retained identity before cleanup resumes.
For example, termination after container removal cannot erase the volume identities recorded before that removal.
The startup cleanup passes those retained volumes into deletion and independent verification.
After the helper succeeds, the worker revalidates its output and every retained identity before the dispatcher removes the lock.

The unit uses `Restart=on-failure`, so a startup cleanup failure otherwise retries every five seconds.
Stop that retry loop before investigation or repair:

```bash
sudo systemctl stop nemoclaw-jetson-dispatch.service
```

An invalid matching `<jobId>.json` file also fails startup and enters the same retry loop.
Set `JOB_ID` from the exact basename in the startup error.
For this failure, preserve and inspect the named private file under the approved incident-retention policy; treat its JSON as private candidate output.
The following command validates the exact basename, stops the retry loop, requires `ActiveState=inactive`, and accepts either no `device.lock` or the service-owned, mode `0600`, single-link regular lock whose exact contents are `JOB_ID` plus its terminating newline.
A mismatched, nonregular, or symbolic-link lock blocks recovery.
It rejects a symbolic link or non-directory quarantine parent and verifies `root:root` mode `0700` without following links.
It then moves the exact object without overwriting retained evidence and restarts the service.
For a matching lock, startup reruns cleanup and removes the lock only after cleanup succeeds; never remove the lock manually.
After it returns, repeat the loopback-bind and anonymous HTTP `401` checks under [Configure the Dispatcher Service](#configure-the-dispatcher-service) before accepting work.

```bash
set -euo pipefail
JOB_ID=0000000000000000000000000000000000000000000000000000000000000000
[[ "$JOB_ID" =~ ^[a-f0-9]{64}$ ]]
state=/var/lib/nemoclaw-jetson-dispatch/state
status_file="$state/$JOB_ID.json"
quarantine=/var/lib/nemoclaw-jetson-status-quarantine
quarantine_file="$quarantine/$JOB_ID.json.invalid"
lock="$state/device.lock"
dispatcher_uid="$(id -u nemoclaw-jetson-dispatch)"
dispatcher_gid="$(id -g nemoclaw-jetson-dispatch)"
sudo systemctl stop nemoclaw-jetson-dispatch.service
test "$(sudo systemctl show --property=ActiveState --value \
  nemoclaw-jetson-dispatch.service)" = inactive
sudo stat -- "$status_file"
sudo test ! -L "$lock"
if sudo test -e "$lock"; then
  test "$(sudo stat --format='%F:%u:%g:%a:%h' -- "$lock")" = \
    "regular file:$dispatcher_uid:$dispatcher_gid:600:1"
  printf '%s\n' "$JOB_ID" | sudo cmp --silent -- "$lock" -
fi
sudo test ! -L "$quarantine"
if sudo test -e "$quarantine"; then
  test "$(sudo stat --format='%F:%u:%g:%a' -- "$quarantine")" = \
    directory:0:0:700
else
  sudo install -d -o root -g root -m 0700 "$quarantine"
fi
test "$(sudo stat --format='%F:%u:%g:%a' -- "$quarantine")" = \
  directory:0:0:700
sudo test ! -e "$quarantine_file"
sudo test ! -L "$quarantine_file"
sudo mv -- "$status_file" "$quarantine_file"
sudo test ! -e "$status_file"
sudo test ! -L "$status_file"
sudo systemctl start nemoclaw-jetson-dispatch.service
test "$(sudo systemctl show --property=ActiveState --value \
  nemoclaw-jetson-dispatch.service)" = active
```

Do not delete `device.lock` to bypass recovery.
For `cleanup: "failed"`, inspect the recorded error before choosing a recovery action.
Repair the cleanup program or allowlisted resource state only when that named operation failed.
If the protected tool or Ollama model baseline differs after cleanup, investigate candidate activity and external host drift without assigning the change to cleanup.
For `cleanup: "succeeded"` with a lock-removal error, repair the state-directory filesystem or permissions.
If the error also reports lock-restoration failure, stop the dispatcher and treat the exact `device.lock` state as inconclusive.
Use the ownership, file-type, mode, and exact job-ID checks above to inspect it without following links; do not accept more work until approved recovery and a service restart complete startup cleanup.
Start the dispatcher after the named condition is fixed:

```bash
sudo systemctl start nemoclaw-jetson-dispatch.service
```

Startup runs cleanup and absence verification again before it removes the stale lock.

Do not dispatch another job when cleanup verification is inconclusive.
Manual recovery must stay within the same cleanup allowlist.
Escalate any suspected protected baseline change for separate host investigation.
Cleanup evidence alone is not evidence that every candidate host change was reversed.

Retain every `<jobId>.cleanup.json` file until the temporary path teardown completes.
Preserve the other private job state required for diagnosis and stale-lock recovery.
These private state files can contain candidate output, and the dispatcher does not otherwise prune them.
Apply the host's approved retention policy to other private state after GitHub uploads the artifact and no device lock exists.

To disable the temporary path, first prevent another controller from reaching the dispatcher.
Delete the repository variable and stop the public tunnel, but keep the dispatcher and its SSH credentials available while any accepted job finishes its bounded execution and cleanup:

```bash
gh variable delete JETSON_DISPATCH_URL --repo NVIDIA/NemoClaw
sudo systemctl disable --now nemoclaw-jetson-tunnel.service
```

Use the last accepted job ID from the controller log.
Wait for the device lock to disappear and require that job's private status to report successful cleanup.
Require the last job's cleanup record.
Use Node.js `readdirSync` with the exact `^[a-f0-9]{64}\.cleanup\.json$` basename pattern.
Validate and aggregate every retained cleanup record that matches this pattern.
Independently verify every aggregated resource identity and the remaining fixed allowlist:

```bash
set -euo pipefail
LAST_JOB_ID=0000000000000000000000000000000000000000000000000000000000000000
[[ "$LAST_JOB_ID" =~ ^[a-f0-9]{64}$ ]]
state=/var/lib/nemoclaw-jetson-dispatch/state
sudo -u nemoclaw-jetson-dispatch \
  timeout 3600 bash -c 'while [ -e "$1" ]; do sleep 5; done' wait-lock \
  "$state/device.lock"
sudo -u nemoclaw-jetson-dispatch test ! -e "$state/device.lock"
sudo -u nemoclaw-jetson-dispatch /usr/bin/node -e '
  const fs = require("node:fs");
  const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (status.state !== "completed" || status.cleanup !== "succeeded") process.exit(1);
' "$state/$LAST_JOB_ID.json"
cleanup_identities="$(sudo -u nemoclaw-jetson-dispatch /usr/bin/node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const stateDirectory = process.argv[1];
  const lastJobId = process.argv[2];
  const cleanupName = /^[a-f0-9]{64}\.cleanup\.json$/;
  const names = fs.readdirSync(stateDirectory).filter((name) => cleanupName.test(name)).sort();
  if (!names.includes(`${lastJobId}.cleanup.json`)) process.exit(1);
  const expectedKeys = ["processIds", "schemaVersion", "volumes"];
  const validVolume = (value) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value);
  const validProcessId = (value) => Number.isSafeInteger(value) && value > 0;
  const volumes = new Set();
  const processIds = new Set();
  for (const name of names) {
    const file = path.join(stateDirectory, name);
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) process.exit(1);
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) process.exit(1);
    const record = JSON.parse(raw);
    const keys = Object.keys(record).sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      record.schemaVersion !== 1 ||
      !Array.isArray(record.volumes) ||
      !record.volumes.every(validVolume) ||
      !Array.isArray(record.processIds) ||
      !record.processIds.every(validProcessId)
    ) process.exit(1);
    for (const volume of record.volumes) volumes.add(volume);
    for (const processId of record.processIds) processIds.add(processId);
  }
  for (const volume of [...volumes].sort()) console.log(`volume\t${volume}`);
  for (const processId of [...processIds].sort((a, b) => a - b)) {
    console.log(`processId\t${processId}`);
  }
' "$state" "$LAST_JOB_ID")"
cleanup_volumes=()
cleanup_process_ids=()
while IFS=$'\t' read -r identity_kind identity; do
  [ -n "$identity_kind" ] || continue
  case "$identity_kind" in
    volume) cleanup_volumes+=("$identity") ;;
    processId) cleanup_process_ids+=("$identity") ;;
    *) exit 1 ;;
  esac
done <<<"$cleanup_identities"
for volume in "${cleanup_volumes[@]}"; do
  timeout --kill-after=5 120 \
    sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
    -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
    -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
    nvidia@192.168.55.1 bash -s -- "$volume" <<'VERIFY_RECORDED_VOLUME'
set -euo pipefail
volume_names="$(docker volume ls --format '{{.Name}}')" || {
  echo 'Unable to list Docker volumes' >&2
  exit 1
}
if printf '%s\n' "$volume_names" | grep -Fqx -- "$1"; then
  echo "A recorded job-owned Docker volume remains: $1" >&2
  exit 1
fi
VERIFY_RECORDED_VOLUME
done
for process_id in "${cleanup_process_ids[@]}"; do
  timeout --kill-after=5 120 \
    sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
    -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
    -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
    nvidia@192.168.55.1 bash -s -- "$process_id" <<'VERIFY_RECORDED_PROCESS'
set -euo pipefail
if [ -e "/proc/$1" ]; then
  echo "A recorded job-owned process ID remains: $1" >&2
  exit 1
fi
VERIFY_RECORDED_PROCESS
done
timeout --kill-after=5 120 \
  sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
  -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
  -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
  nvidia@192.168.55.1 bash -s -- "$LAST_JOB_ID" <<'VERIFY_JETSON_IDLE'
set -euo pipefail
job_id="$1"
[[ "$job_id" =~ ^[a-f0-9]{64}$ ]]
job_home="/var/tmp/nemoclaw-jetson-e2e/$job_id/home"
test ! -e "/var/tmp/nemoclaw-jetson-e2e/$job_id"
test ! -e /tmp/nemoclaw-services-e2e-jetson-nvmap
if [ -e /var/tmp/nemoclaw-jetson-e2e ]; then
  test -d /var/tmp/nemoclaw-jetson-e2e
  test ! -L /var/tmp/nemoclaw-jetson-e2e
  test -z "$(find /var/tmp/nemoclaw-jetson-e2e -mindepth 1 -maxdepth 1 -print -quit)"
fi
sandbox_container_output="$(docker ps -aq \
  --filter label=openshell.ai/managed-by=openshell \
  --filter label=openshell.ai/sandbox-name=e2e-jetson-nvmap)" || {
  echo 'Unable to list labeled sandbox containers' >&2
  exit 1
}
test -z "$sandbox_container_output"
container_rows="$(docker container ls --all --no-trunc --format '{{.ID}}\t{{.Names}}')" || {
  echo 'Unable to list Docker containers' >&2
  exit 1
}
if printf '%s\n' "$container_rows" |
  awk -F '\t' '$2 == "openshell-cluster-nemoclaw" { found = 1 } END { exit found ? 0 : 1 }'; then
  echo 'The job-owned gateway container remains' >&2
  exit 1
fi
volume_names="$(docker volume ls --format '{{.Name}}')" || {
  echo 'Unable to list Docker volumes' >&2
  exit 1
}
if printf '%s\n' "$volume_names" | grep -Fqx openshell-cluster-nemoclaw; then
  echo 'The job-owned gateway volume remains' >&2
  exit 1
fi
read_proc_uid() {
  awk '/^Uid:/ { print $2; found = 1; exit } END { exit found ? 0 : 1 }' \
    "$1/status" 2>/dev/null
}
read_proc_environment() {
  dd if="$1/environ" status=none 2>/dev/null | tr '\000' '\n'
}
read_proc_command() {
  dd if="$1/cmdline" status=none 2>/dev/null | tr '\000' ' '
}
handle_proc_read_failure() {
  local proc_dir="$1" field="$2" process_uid directory_uid
  [ -d "$proc_dir" ] || return 0
  if process_uid="$(read_proc_uid "$proc_dir")"; then
    [ "$process_uid" = "$(id -u)" ] || return 0
  else
    [ -d "$proc_dir" ] || return 0
    if ! directory_uid="$(stat -c %u "$proc_dir" 2>/dev/null)"; then
      [ -d "$proc_dir" ] || return 0
      echo "Unable to verify the owner of a live process after a failed $field read" >&2
      exit 1
    fi
    [ "$directory_uid" = "$(id -u)" ] || return 0
  fi
  echo "Unable to inspect $field for a live same-user process" >&2
  exit 1
}
for proc_dir in /proc/[0-9]*; do
  if ! process_uid="$(read_proc_uid "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" owner
    continue
  fi
  [ "$process_uid" = "$(id -u)" ] || continue
  if ! environment="$(read_proc_environment "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" environment
    continue
  fi
  printf '%s\n' "$environment" | grep -Fqx "HOME=$job_home" || continue
  if ! cmdline="$(read_proc_command "$proc_dir")"; then
    handle_proc_read_failure "$proc_dir" command
    continue
  fi
  case "$cmdline" in
    *ollama-auth-proxy.*|*openshell-gateway*|*openshell-forward*|*openshell\ forward*|*cloudflared*)
      echo "A job-owned helper process remains: ${proc_dir##*/}" >&2
      exit 1
      ;;
  esac
done
image_rows="$(docker image ls nemoclaw-sandbox-local --format '{{.Repository}}\t{{.Tag}}')" || {
  echo 'Unable to list job-owned Docker images' >&2
  exit 1
}
test -z "$(printf '%s\n' "$image_rows" |
  awk '$1 == "nemoclaw-sandbox-local" && index($2, "e2e-jetson-nvmap-") == 1 { print $1 ":" $2 }')"
command -v node npm ollama
timeout --kill-after=5 30 ollama list >/dev/null
for openshell_component in openshell openshell-gateway openshell-sandbox; do
  if command -v "$openshell_component" >/dev/null 2>&1; then
    echo "A host-level OpenShell binary remains after cleanup: $openshell_component" >&2
    exit 1
  fi
  for host_bin in \
    "/usr/local/bin/$openshell_component" \
    "/usr/bin/$openshell_component" \
    "$HOME/.local/bin/$openshell_component"; do
    test ! -e "$host_bin"
    test ! -L "$host_bin"
  done
done
test -c /dev/nvmap
case "$(docker info --format '{{json .Runtimes}}')" in
  *nvidia*) ;;
  *) exit 1 ;;
esac
VERIFY_JETSON_IDLE
```

If the last cleanup record is missing, keep the dispatcher and SSH credentials.
Keep them when any retained cleanup record is malformed or an absence check fails.
Use the recovery procedure above before teardown.
Only after every check passes should you stop the dispatcher:

```bash
sudo systemctl disable --now nemoclaw-jetson-dispatch.service
```

Reauthenticate with `cloudflared tunnel login` as a Cloudflare administrator.
Delete the `jetson-e2e.example.com` DNS record from the Cloudflare zone.
Delete the named tunnel with `cloudflared tunnel delete TUNNEL_UUID`.
Confirm that `cloudflared tunnel list` no longer returns `TUNNEL_UUID`.
Remove the new local account certificate after the administrative deletion.
Remove the local tunnel credential, configuration, and service unit:

```bash
rm "$HOME/.cloudflared/cert.pem"
sudo rm /etc/cloudflared/TUNNEL_UUID.json \
  /etc/cloudflared/jetson-dispatch.yml \
  /etc/systemd/system/nemoclaw-jetson-tunnel.service
sudo systemctl daemon-reload
test ! -e /etc/cloudflared/TUNNEL_UUID.json
test ! -e /etc/cloudflared/jetson-dispatch.yml
test ! -e /etc/systemd/system/nemoclaw-jetson-tunnel.service
```

Confirm that the public endpoint is unreachable and the repository variable is absent:

```bash
if curl --silent --show-error --output /dev/null --connect-timeout 10 \
  https://jetson-e2e.example.com/v1/jobs; then
  echo 'Jetson dispatch endpoint is still reachable' >&2
  exit 1
fi
test -z "$(gh variable list --repo NVIDIA/NemoClaw --json name \
  --jq '.[] | select(.name == "JETSON_DISPATCH_URL") | .name')"
```

Remove the dedicated Jetson public key and the Colossus SSH private key.
Encode the exact authorized-key line so the space-containing value remains one remote-command argument, then verify that exact line is absent before deleting the Colossus key:

```bash
set -euo pipefail
JETSON_PUBLIC_KEY="$(sudo cat /var/lib/nemoclaw-jetson-dispatch/id_ed25519.pub)"
case "$JETSON_PUBLIC_KEY" in
  ssh-ed25519\ *) ;;
  *) echo 'Unexpected Jetson public key format' >&2; exit 1 ;;
esac
JETSON_AUTHORIZED_KEY_LINE="from=\"192.168.55.100\",restrict $JETSON_PUBLIC_KEY"
JETSON_AUTHORIZED_KEY_B64="$(printf '%s' "$JETSON_AUTHORIZED_KEY_LINE" | base64 --wrap=0)"
timeout --kill-after=5 120 \
  sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
  -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
  -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
  nvidia@192.168.55.1 bash -s -- "$JETSON_AUTHORIZED_KEY_B64" <<'REMOVE_DISPATCH_KEY'
set -euo pipefail
authorized_key_line="$(printf '%s' "$1" | base64 --decode)"
authorized_keys="$HOME/.ssh/authorized_keys"
test -f "$authorized_keys"
temporary="$(mktemp "$HOME/.ssh/.authorized_keys.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
chmod 600 "$temporary"
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" != "$authorized_key_line" ]; then
    printf '%s\n' "$line"
  fi
done <"$authorized_keys" >"$temporary"
mv "$temporary" "$authorized_keys"
trap - EXIT
if grep -Fqx -- "$authorized_key_line" "$authorized_keys"; then
  echo 'Dedicated Jetson public key remains authorized' >&2
  exit 1
fi
REMOVE_DISPATCH_KEY
sudo rm -- \
  /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
  /var/lib/nemoclaw-jetson-dispatch/id_ed25519.pub
sudo test ! -e /var/lib/nemoclaw-jetson-dispatch/id_ed25519
sudo test ! -e /var/lib/nemoclaw-jetson-dispatch/id_ed25519.pub
```

An SSH transport failure keeps the Colossus SSH key and pinned host-key files.
The Jetson `authorized_keys` result is inconclusive in this case.
Use the serial console to confirm that the exact key line is absent before you continue credential removal.

Remove the cleanup executable and pinned SSH host-key file, then verify their absence:

```bash
sudo rm -- \
  /usr/local/libexec/nemoclaw-jetson-cleanup \
  /var/lib/nemoclaw-jetson-dispatch/known_hosts
sudo test ! -e /usr/local/libexec/nemoclaw-jetson-cleanup
sudo test ! -L /usr/local/libexec/nemoclaw-jetson-cleanup
sudo test ! -e /var/lib/nemoclaw-jetson-dispatch/known_hosts
```

After the required retention period, remove the private job state and logs.
When no investigation, recovery, or retention requirement remains, remove these remaining deployment files:

```bash
sudo rm -- \
  /etc/nemoclaw-jetson-dispatch/environment \
  /etc/systemd/system/nemoclaw-jetson-dispatch.service \
  /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy
sudo rm -rf -- \
  /opt/nemoclaw-jetson-dispatch \
  /var/lib/nemoclaw-jetson-status-quarantine
sudo systemctl daemon-reload
sudo test ! -e /etc/nemoclaw-jetson-dispatch/environment
sudo test ! -e /etc/systemd/system/nemoclaw-jetson-dispatch.service
sudo test ! -e /usr/local/sbin/nemoclaw-colossus-jetson-dispatch-deploy
sudo test ! -e /opt/nemoclaw-jetson-dispatch
sudo test ! -L /opt/nemoclaw-jetson-dispatch
sudo test ! -e /var/lib/nemoclaw-jetson-status-quarantine
sudo test ! -L /var/lib/nemoclaw-jetson-status-quarantine
test "$(systemctl show --property=LoadState --value \
  nemoclaw-jetson-dispatch.service)" = not-found
```
