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
git --version
npm --version
command -v bash curl docker git node npm ollama timeout
docker info --format '{{json .Runtimes}}'
test -c /dev/nvmap
if sudo -n true 2>/dev/null; then echo 'unexpected passwordless sudo'; exit 1; fi
```

The architecture must be `aarch64`, and Node.js must have major version 22.
Docker must expose the NVIDIA runtime required by the existing Jetson live E2E test.
Preinstall Ollama so candidate code does not invoke its host installer.
The `nvidia` account must not have passwordless `sudo` access.
The worker gives each job its own `HOME`, `TMPDIR`, XDG directories, and npm prefix under the job workspace.
The test installs the NemoClaw CLI and its state only in those job-owned paths, so workspace removal removes them without a host-wide uninstall.
If a later reviewed cleanup path requires the NemoClaw uninstaller, it must use `--keep-openshell` and must retain the same resource allowlist.

Reserve these names and paths for this E2E target:

- The current dispatcher-created `/var/tmp/nemoclaw-jetson-e2e/<jobId>` workspace.
- The `/tmp/nemoclaw-services-e2e-jetson-nvmap` helper-service directory.
- The `e2e-jetson-nvmap` NemoClaw and OpenShell sandbox name.
- The `nemoclaw` OpenShell gateway name and forwards for the named sandbox.
- The recorded `ollama-auth-proxy`, OpenShell Docker gateway, and helper `cloudflared` processes.
- OpenShell-managed Docker containers labeled for `e2e-jetson-nvmap`.
- The volumes recorded from those labeled containers.
- The `openshell-cluster-nemoclaw` gateway container, volume, and recorded attached volumes.

Do not run unrelated work under these reserved names.
The cleanup program must act only on this allowlist.

Before candidate execution, the worker records this protected tool and model baseline:

- The resolved Node.js path and version.
- The resolved npm path and version.
- The resolved Ollama path and a SHA-256 digest of the sorted Ollama model names and IDs.
- The resolved OpenShell path.

The dispatcher stores the recorded values in a private `<jobId>.baseline.json` state file.
After cleanup, the worker repeats the probes and compares them with that record.
Before and after candidate execution, the worker also requires `/dev/nvmap` and the Docker NVIDIA runtime to be available.
The worker removes the record only after every comparison and cleanup absence check succeeds.

These other host resources also remain outside the cleanup allowlist:

- Node.js, npm, the OpenShell executable, and the Docker engine.
- The Ollama binary, service, models, configuration, and unrelated `ollama serve` processes.
- The NVIDIA container runtime and Docker images that the test does not own exclusively.
- The `/dev/nvmap` character device and its permissions.
- JetPack, Jetson Linux, CUDA, NVIDIA packages, other `apt` packages, SDK Manager, and downloaded flashing files.
- User accounts, SSH keys, and user files outside the current job workspace and named NemoClaw resources.
- Docker resources without the exact label or name association defined above.
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

The cleanup program must perform these bounded actions:

1. Stop and remove only the named sandbox, its forwards, and the named gateway.
2. Stop only the recorded helper PIDs after verifying the process owner, command marker, and job `HOME`.
3. Remove only the labeled sandbox containers, the exact gateway container, and their recorded volumes.
4. Remove only the helper-service directory and `/var/tmp/nemoclaw-jetson-e2e/<validated-job-id>` workspace for the locked job.
5. Verify that every allowlisted resource is absent.

The cleanup program must be idempotent.
It must treat an already absent allowlisted resource as success.
It must exit nonzero when target ownership is ambiguous, cleanup fails, or absence verification is inconclusive.
It must not remove `/var/lib/nemoclaw-jetson-dispatch/state/device.lock`.
The dispatcher removes that lock only after cleanup and absence verification succeed.

After the helper exits, the worker independently verifies these conditions over pinned-host-key SSH:

- The validated job workspace is absent and is not a symbolic link.
- No OpenShell-managed container has the `e2e-jetson-nvmap` sandbox label.
- The `openshell-cluster-nemoclaw` gateway container and volume are absent.
- Every recorded Node.js, npm, Ollama, Ollama model, and OpenShell baseline value matches.
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

First select only the Jetson target from the trusted `main` workflow:

```bash
gh workflow run .github/workflows/e2e.yaml --repo NVIDIA/NemoClaw --ref main \
  -f targets=jetson-nvmap-gpu \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_dispatch=true \
  -f allow_dgx_spark_runner_queue=false
```

The controller must run on `ubuntu-latest`.
The GitHub controller log must show one `Jetson dispatch accepted as <jobId>` line.
The Colossus journal must not contain a bearer token.
The uploaded `e2e-jetson-nvmap-gpu` artifact must contain `jetson-dispatch.json` with these results:

- The requested candidate commit SHA and workflow run identity.
- The Jetson model, JetPack package version or `unavailable`, Jetson Linux release, and kernel.
- The test conclusion and bounded log.
- `cleanup: "succeeded"` before `conclusion: "success"`.

It must also contain `jetson-e2e-artifacts.tar.gz`.
The dispatcher creates that archive from the remote E2E artifact directory before it removes the candidate workspace.
It rejects an artifact directory or compressed archive larger than 1 MiB.

After the workflow completes, independently verify every allowlisted resource is absent.
Then run one controlled failing candidate and confirm that its artifact records the same cleanup evidence.
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

Do not delete `device.lock` to bypass recovery.
For `cleanup: "failed"`, repair the cleanup program or the allowlisted resource state.
For `cleanup: "succeeded"` with a lock-removal error, repair the state-directory filesystem or permissions.
Restart the dispatcher after the repair.
Startup runs cleanup and absence verification again before it removes the stale lock.

Do not dispatch another job when cleanup verification is inconclusive.
Manual recovery must stay within the same cleanup allowlist.
Escalate any suspected protected baseline change for separate host investigation.
Cleanup evidence alone is not evidence that every candidate host change was reversed.

Preserve the job JSON and log files for diagnosis.
These private state files can contain candidate output, and the dispatcher does not prune them.
Apply the host's approved retention policy after GitHub uploads the artifact and no device lock exists.

To disable the temporary path, leave `allow_jetson_dispatch=false` on later dispatches and run:

```bash
gh variable delete JETSON_DISPATCH_URL --repo NVIDIA/NemoClaw
sudo systemctl disable --now nemoclaw-jetson-tunnel.service
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
After the required retention period, remove the private job state and logs.
Remove the dispatcher environment, service unit, and trusted checkout when no investigation or rollback requirement remains.
