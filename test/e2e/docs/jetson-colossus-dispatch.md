<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Jetson Dispatch Through Colossus

This temporary path runs the `jetson-nvmap-gpu` end-to-end (E2E) job on one Jetson behind a Colossus host.
GitHub Actions controls the job through an authenticated HTTPS endpoint.
Colossus retains the Cloudflare Tunnel credential, Jetson SSH key, SSH host key, device lock, and reset capability.
Candidate code runs only on the Jetson.

Do not set `allow_jetson_dispatch=true` until every deployment check on this page passes.

## Trust Boundary

The deployment has these input and credential boundaries:

| System | Receives | Must not receive |
| --- | --- | --- |
| GitHub-hosted controller | Candidate commit SHA, workflow run identity, public dispatch URL, and short-lived GitHub OpenID Connect (OIDC) token | Jetson SSH key, tunnel credential, and reset privilege |
| Colossus dispatcher | Validated workflow identity, fixed target, and candidate commit SHA | Request-controlled command, SSH host, repository, path, or reset command |
| Jetson | Candidate checkout and the fixed live E2E command | GitHub OIDC token, tunnel credential, and Colossus SSH private key |

The dispatcher accepts only `NVIDIA/NemoClaw` and the trusted `main` E2E workflow.
It requires a GitHub-hosted controller, one repository ID, one workflow run identity, and the `jetson-nvmap-gpu` target.
It also requires a lowercase 40-character candidate commit SHA.
The temporary path rejects fork repositories.

The credentials have these lifecycles:

| Credential | Location and access | Lifetime and removal |
| --- | --- | --- |
| GitHub OIDC token | GitHub-hosted controller process memory and the authenticated request | The client requests a new token for each request. It does not write the token to disk. |
| Cloudflare account certificate | The administrator account that runs `cloudflared tunnel login` | Remove `cert.pem` from Colossus after tunnel creation and DNS routing. Reauthenticate before later management changes. |
| Cloudflare Tunnel credential | `/etc/cloudflared/TUNNEL_UUID.json`, readable only by the tunnel service account | Keep it for this temporary deployment. Revoke the tunnel and remove the file when the deployment ends. |
| Jetson SSH private key | `/var/lib/nemoclaw-jetson-dispatch/id_ed25519`, readable only by the dispatcher service account | Keep it for this temporary deployment. Remove the matching Jetson public key and private key when the deployment ends. |

The dispatcher rejects an OIDC token whose issued-to-expiry window exceeds 15 minutes.
The GitHub repository variable contains only the public dispatch URL.
Do not put a credential in `JETSON_DISPATCH_URL`.

## Prepare a Known Jetson Baseline

Use a dedicated Jetson without production data or credentials.
The E2E job gives candidate code Docker access, which can control the dedicated host.
The reset procedure must restore a known image after every result.

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

Define a reset procedure that restores the verified baseline.
A reboot alone does not reset candidate changes.
Candidate code can change the `nvidia` home directory, SSH configuration, packages, processes, and Docker state.

The reset procedure must verify these conditions before it returns success:

- The expected Jetson model, Jetson Linux release, kernel, and storage layout are present.
- SSH is reachable with the dispatcher's restricted key and pinned host key.
- `/var/tmp/nemoclaw-jetson-e2e` is absent.
- The `e2e-jetson-nvmap` sandbox, `nemoclaw` gateway, and test containers are absent.
- `/dev/nvmap` and the NVIDIA Docker runtime are available.
- No candidate-created process remains.

Use a known-image reflash, immutable-root rollback, or equivalent reprovisioning procedure.
Do not treat `boardctl reset` or another power cycle as baseline restoration.
A reviewed Thor flash process can use `boardctl` only as one step in known-image restoration.
The reset attestation must not rely only on commands that run through the candidate-controlled Jetson account.
If a known-image restore and independent attestation cannot be automated, stop the deployment.

## Create the Colossus Dispatcher Account

Run these commands on Colossus.
Replace the checkout path if the host uses a managed deployment location.
The dispatcher requires `/usr/bin/node` 22.19.0 or later.
Replace `REVIEWED_COMMIT_SHA` with the full 40-character SHA of the reviewed commit to deploy.

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
The service runs controller and dispatcher files from this trusted commit.
It never checks candidate code out on Colossus.

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

The known image must preserve the verified SSH host identity.
Do not accept a changed host key without reconciling it through the serial console or another trusted channel.

Install the reset program at an absolute path such as `/usr/local/libexec/nemoclaw-jetson-reset`.
It must accept no arguments and must not be group- or world-writable.
It must perform and attest the baseline restoration defined above.
It must not remove `/var/lib/nemoclaw-jetson-dispatch/state/device.lock`.
The dispatcher removes that lock only after the reset program exits with status zero.

Run the reset program as `nemoclaw-jetson-dispatch` when host permissions allow it.
Use device rules to grant access to the exact USB devices that the reset program needs.
If restoration requires root, use a reviewed privilege-separated service whose unprivileged,
root-owned client accepts no arguments and returns only after restoration and attestation finish.
The dispatcher service unit below prevents privilege elevation, so a reset client that invokes
`sudo` or relies on a set-user-ID executable is incompatible with this deployment.
Do not remove that protection or grant the dispatcher account passwordless `sudo` access.

Test the SSH and reset paths as the service account:

> Warning: The reset test replaces Jetson state with the known baseline.
> Remove any data that the deployment must retain before this test.

```bash
sudo -u nemoclaw-jetson-dispatch ssh -F /dev/null -o BatchMode=yes \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/var/lib/nemoclaw-jetson-dispatch/known_hosts \
  -i /var/lib/nemoclaw-jetson-dispatch/id_ed25519 \
  nvidia@192.168.55.1 'uname -m'
sudo -u nemoclaw-jetson-dispatch /usr/local/libexec/nemoclaw-jetson-reset
```

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
JETSON_DISPATCH_RESET_TIMEOUT_SECONDS=300
JETSON_DISPATCH_TEST_TIMEOUT_SECONDS=2700
JETSON_DISPATCH_SSH_DESTINATION=nvidia@192.168.55.1
JETSON_DISPATCH_SSH_IDENTITY_FILE=/var/lib/nemoclaw-jetson-dispatch/id_ed25519
JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE=/var/lib/nemoclaw-jetson-dispatch/known_hosts
JETSON_DISPATCH_RESET_EXECUTABLE=/usr/local/libexec/nemoclaw-jetson-reset
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

Start the service and confirm that it listens only on loopback:

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
- `reset: "succeeded"` before `conclusion: "success"`.

After the workflow completes, independently rerun the baseline checks.
Then run one controlled failing candidate and confirm that its artifact records the same reset evidence.
For a cancellation proof, cancel a controller after it logs the job ID.
The controller can exit before it downloads an artifact, so inspect the private Colossus
`<jobId>.json` status for `conclusion: "cancelled"` and `reset: "succeeded"` instead.
Independently rerun the baseline checks after that cancellation.

## Recover or Disable the Deployment

The dispatcher permits one active job.
A process crash leaves `device.lock` in the state directory.
On restart, the dispatcher invokes the reset program before it removes that stale lock or accepts more work.
If reset fails, startup fails or the completed job reports `reset-failed`.
The lock remains after either reset failure.

Do not delete `device.lock` to bypass recovery.
Repair the reset path, run and verify the reset program, and restart the dispatcher.
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
Delete the `jetson-e2e.example.com` DNS record from the Cloudflare zone, then delete the named
tunnel with `cloudflared tunnel delete TUNNEL_UUID`.
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
Remove the dispatcher environment, service unit, and trusted checkout when no investigation or
rollback requirement remains.
