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
- `npm_config_prefix=<workspace>/npm-prefix`
- `PATH=$XDG_BIN_HOME:<workspace>/npm-prefix/bin:$PATH`

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
- The resolved Ollama path and a SHA-256 digest of the sorted Ollama model names and IDs.
- The required absence of host-level `openshell`, `openshell-gateway`, and `openshell-sandbox` binaries.

The dispatcher stores the recorded values in a private `<jobId>.baseline.json` state file.
After cleanup, the worker repeats the probes and compares them with that record.
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
Review its command construction and target resolution before deployment.
Do not use broad process termination, Docker pruning, wildcard paths, or host-wide package removal.

## Create the Colossus Dispatcher Account

Run these commands on Colossus.
Replace the checkout path if the host uses a managed deployment location.
The dispatcher requires `/usr/bin/node` 22.19.0 or later.
Replace `REVIEWED_COMMIT_SHA` with the full lowercase 40-character SHA of the reviewed commit to deploy.

```bash
/usr/bin/node --version
/usr/bin/node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
'
sudo useradd --system --create-home \
  --home-dir /var/lib/nemoclaw-jetson-dispatch \
  --shell /usr/sbin/nologin nemoclaw-jetson-dispatch
sudo install -d -o nemoclaw-jetson-dispatch -g nemoclaw-jetson-dispatch -m 0700 \
  /var/lib/nemoclaw-jetson-dispatch /etc/nemoclaw-jetson-dispatch
REVIEWED_COMMIT_SHA=0000000000000000000000000000000000000000
sudo install -d -o root -g root -m 0755 /opt/nemoclaw-jetson-dispatch
sudo git -C /opt/nemoclaw-jetson-dispatch init
sudo git -C /opt/nemoclaw-jetson-dispatch remote add origin \
  https://github.com/NVIDIA/NemoClaw.git
sudo git -C /opt/nemoclaw-jetson-dispatch fetch --depth=1 --no-tags origin \
  "$REVIEWED_COMMIT_SHA"
sudo git -C /opt/nemoclaw-jetson-dispatch checkout --detach FETCH_HEAD
test "$(sudo git -C /opt/nemoclaw-jetson-dispatch rev-parse HEAD)" = \
  "$REVIEWED_COMMIT_SHA"
test -z "$(sudo git -C /opt/nemoclaw-jetson-dispatch status --short)"
```

The two final checks must pass before the dispatcher service starts.
Do not deploy a branch reference or automatically update this checkout.
The Colossus service runs the dispatcher files from this trusted commit.
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
ssh-keyscan -H 192.168.55.1 >/tmp/jetson_known_hosts
ssh-keygen -lf /tmp/jetson_known_hosts
sudo install -o nemoclaw-jetson-dispatch -g nemoclaw-jetson-dispatch -m 0600 \
  /tmp/jetson_known_hosts /var/lib/nemoclaw-jetson-dispatch/known_hosts
rm /tmp/jetson_known_hosts
```

Treat the verified SSH host identity as part of the protected baseline.
Do not accept a changed host key without reconciling it through the serial console or another trusted channel.

## Define the Cleanup Program

Install the bundled cleanup program from the trusted checkout:

```bash
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 \
  /opt/nemoclaw-jetson-dispatch/tools/e2e/jetson-dispatch-cleanup.sh \
  /usr/local/libexec/nemoclaw-jetson-cleanup
```

It must accept no arguments and must not be group- or world-writable.
It must derive the lowercase 64-character job ID from the private dispatcher `device.lock`.
It must reject a missing or malformed lock instead of selecting a broader target.
The bundled program fixes the state directory, SSH files, SSH destination, and cleanup names listed on this page.
Changing one of those values requires a corresponding reviewed source change.
The dispatcher invokes it after success, failure, cancellation, and timeout.
The dispatcher also invokes it during startup when `device.lock` remains from an interrupted service process.

Before destructive cleanup, the program discovers and validates the job-owned Docker volume and process identities.
It merges them into a mode-`0600` private `<jobId>.cleanup.json` record on Colossus.
The record survives retries so stale-lock recovery can clean and verify the same identities.

The destructive phase must perform these bounded actions:

1. Use only the canonical job-local OpenShell installation to stop the named forwards, sandbox, and gateway.
2. Stop only the recorded helper PIDs after verifying the process owner, command marker, and job `HOME`.
3. Remove only the labeled sandbox containers, exact gateway container, recorded volumes, and reserved test image tags.
4. Remove only the helper-service directory and `/var/tmp/nemoclaw-jetson-e2e/<validated-job-id>` workspace for the locked job.
5. After workspace removal, verify that the allowlisted resources are absent, host OpenShell remains absent, and the host baseline matches.

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
- Every recorded Node.js, npm, Ollama, and Ollama model baseline value matches.
- No host-level `openshell`, `openshell-gateway`, or `openshell-sandbox` binary resolves or exists in a checked host binary path.
- `/dev/nvmap` exists, and Docker still reports the NVIDIA runtime.

The worker reports cleanup failure when any helper or independent verification step fails.

The dispatcher runs the cleanup program as `nemoclaw-jetson-dispatch`.
The service unit below prevents privilege elevation.
Do not remove that protection or grant the dispatcher account passwordless `sudo` access.

Test cleanup-program access and the SSH path as the service account:

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

## Configure the Dispatcher Service

Get the immutable GitHub repository ID:

```bash
gh api repos/NVIDIA/NemoClaw --jq .id
```

Create `/etc/nemoclaw-jetson-dispatch/environment` as a root-owned file with mode `0600`.
Substitute the repository ID returned above:

```text
JETSON_DISPATCH_STATE_DIRECTORY=/var/lib/nemoclaw-jetson-dispatch/state
JETSON_DISPATCH_GITHUB_REPOSITORY_ID=REPOSITORY_ID
JETSON_DISPATCH_PORT=8787
JETSON_DISPATCH_EXECUTION_TIMEOUT_SECONDS=3000
JETSON_DISPATCH_CLEANUP_TIMEOUT_SECONDS=300
JETSON_DISPATCH_TEST_TIMEOUT_SECONDS=2700
JETSON_DISPATCH_SSH_DESTINATION=nvidia@192.168.55.1
JETSON_DISPATCH_SSH_IDENTITY_FILE=/var/lib/nemoclaw-jetson-dispatch/id_ed25519
JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE=/var/lib/nemoclaw-jetson-dispatch/known_hosts
JETSON_DISPATCH_CLEANUP_EXECUTABLE=/usr/local/libexec/nemoclaw-jetson-cleanup
```

Install `/etc/systemd/system/nemoclaw-jetson-dispatch.service`:

```ini
[Unit]
Description=NemoClaw Jetson dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nemoclaw-jetson-dispatch
Group=nemoclaw-jetson-dispatch
UMask=0077
WorkingDirectory=/opt/nemoclaw-jetson-dispatch
EnvironmentFile=/etc/nemoclaw-jetson-dispatch/environment
ExecStart=/usr/bin/node --experimental-strip-types --no-warnings tools/e2e/jetson-dispatch-service.mts
Restart=on-failure
RestartSec=5
TimeoutStopSec=360
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/nemoclaw-jetson-dispatch

[Install]
WantedBy=multi-user.target
```

Start the service and confirm that it listens only on the loopback address:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nemoclaw-jetson-dispatch.service
sudo systemctl status nemoclaw-jetson-dispatch.service
sudo ss -ltnp | grep '127.0.0.1:8787'
```

An anonymous request must fail:

```bash
curl --fail-with-body -X POST http://127.0.0.1:8787/v1/jobs \
  -H 'Content-Type: application/json' \
  --data '{"schemaVersion":1,"target":"jetson-nvmap-gpu","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowRunId":"1","workflowRunAttempt":1}'
```

The expected result is HTTP `401`.
A malformed request returns HTTP `400`, and an unknown route returns HTTP `404`.

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
  -f review_reason='Reviewed this PR commit for the isolated Jetson E2E.'
```

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
Before a restarted dispatcher replays the same deterministic job ID, it removes the earlier log and archive so evidence cannot cross executions.

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
If cleanup fails, startup fails or the completed job reports `conclusion: "cleanup-failed"` with `cleanup: "failed"`.
If cleanup succeeds but lock removal fails, the completed job reports `conclusion: "cleanup-failed"` with `cleanup: "succeeded"`.
The lock remains in either case.

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

Do not delete `device.lock` to bypass recovery.
For `cleanup: "failed"`, inspect the recorded error before choosing a recovery action.
Repair the cleanup program or allowlisted resource state only when that named operation failed.
If the protected tool or Ollama model baseline differs after cleanup, investigate candidate activity and external host drift without assigning the change to cleanup.
For `cleanup: "succeeded"` with a lock-removal error, repair the state-directory filesystem or permissions.
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
  sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
    -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
    nvidia@192.168.55.1 bash -s -- "$volume" <<'VERIFY_RECORDED_VOLUME'
set -euo pipefail
docker info >/dev/null
if docker volume inspect "$1" >/dev/null 2>&1; then
  echo "A recorded job-owned Docker volume remains: $1" >&2
  exit 1
fi
VERIFY_RECORDED_VOLUME
done
for process_id in "${cleanup_process_ids[@]}"; do
  sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
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
sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
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
test -z "$(docker ps -aq --filter label=openshell.ai/managed-by=openshell \
  --filter label=openshell.ai/sandbox-name=e2e-jetson-nvmap)"
! docker container inspect openshell-cluster-nemoclaw >/dev/null 2>&1
! docker volume inspect openshell-cluster-nemoclaw >/dev/null 2>&1
for proc_dir in /proc/[0-9]*; do
  [ -r "$proc_dir/environ" ] || continue
  tr '\000' '\n' <"$proc_dir/environ" | grep -Fqx "HOME=$job_home" || continue
  cmdline="$(tr '\000' ' ' <"$proc_dir/cmdline")"
  case "$cmdline" in
    *ollama-auth-proxy.*|*openshell-gateway*|*cloudflared*)
      echo "A job-owned helper process remains: ${proc_dir##*/}" >&2
      exit 1
      ;;
  esac
done
test -z "$(docker image ls --format '{{.Repository}}\t{{.Tag}}' |
  awk '$1 == "nemoclaw-sandbox-local" && index($2, "e2e-jetson-nvmap-") == 1 { print $1 ":" $2 }')"
command -v node npm ollama
ollama list >/dev/null
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
JETSON_PUBLIC_KEY="$(sudo cat /var/lib/nemoclaw-jetson-dispatch/id_ed25519.pub)"
case "$JETSON_PUBLIC_KEY" in
  ssh-ed25519\ *) ;;
  *) echo 'Unexpected Jetson public key format' >&2; exit 1 ;;
esac
JETSON_AUTHORIZED_KEY_LINE="from=\"192.168.55.100\",restrict $JETSON_PUBLIC_KEY"
JETSON_AUTHORIZED_KEY_B64="$(printf '%s' "$JETSON_AUTHORIZED_KEY_LINE" | base64 --wrap=0)"
sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
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

After the required retention period, remove the private job state and logs.
Remove the dispatcher environment, service unit, and trusted checkout when no investigation, recovery, or retention requirement remains.
