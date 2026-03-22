# Network Policies

NemoClaw runs with a deny-by-default network policy.
The sandbox can only reach endpoints that are explicitly allowed.
Any request to an unlisted destination is intercepted by OpenShell, and the operator is prompted to approve or deny it in real time through the TUI.

## Baseline Policy

The baseline policy is defined in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.

### Filesystem

| Path | Access |
|---|---|
| `/sandbox`, `/tmp`, `/dev/null` | Read-write |
| `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/app`, `/etc`, `/var/log` | Read-only |

The sandbox process runs as a dedicated `sandbox` user and group.
Landlock LSM enforcement applies on a best-effort basis.

### Network Policies

The following endpoint groups are allowed by default:

:::{list-table}
:header-rows: 1
:widths: 20 30 20 30

* - Policy
  - Endpoints
  - Binaries
  - Rules

* - `claude_code`
  - `api.anthropic.com:443`, `statsig.anthropic.com:443`, `sentry.io:443`
  - `/usr/local/bin/claude`
  - All methods

* - `nvidia`
  - `integrate.api.nvidia.com:443`, `inference-api.nvidia.com:443`
  - `/usr/local/bin/claude`, `/usr/local/bin/openclaw`
  - All methods

* - `github`
  - `github.com:443`
  - `/usr/bin/gh`, `/usr/bin/git`
  - All methods, all paths

* - `github_rest_api`
  - `api.github.com:443`
  - `/usr/bin/gh`
  - GET, POST, PATCH, PUT, DELETE

* - `clawhub`
  - `clawhub.com:443`
  - `/usr/local/bin/openclaw`
  - GET, POST

* - `openclaw_api`
  - `openclaw.ai:443`
  - `/usr/local/bin/openclaw`
  - GET, POST

* - `openclaw_docs`
  - `docs.openclaw.ai:443`
  - `/usr/local/bin/openclaw`
  - GET only

* - `npm_registry`
  - `registry.npmjs.org:443`
  - `/usr/local/bin/openclaw`, `/usr/local/bin/npm`
  - GET only

* - `telegram`
  - `api.telegram.org:443`
  - Any binary
  - GET, POST on `/bot*/**`

:::

All endpoints use TLS termination and are enforced at port 443.

### Inference

The baseline policy allows only the `local` inference route. External inference
providers are reached through the OpenShell gateway, not by direct sandbox egress.

## Operator Approval Flow

When the agent attempts to reach an endpoint not listed in the policy, OpenShell intercepts the request and presents it in the TUI for operator review:

1. The agent makes a network request to an unlisted host.
2. OpenShell blocks the connection and logs the attempt.
3. The TUI command `openshell term` displays the blocked request with host, port, and requesting binary.
4. The operator approves or denies the request.
5. If approved, the endpoint is added to the running policy for the session.

To try this, run the walkthrough:

```console
$ ./scripts/walkthrough.sh
```

This opens a split tmux session with the TUI on the left and the agent on the right.

## Modifying the Policy

### Static Changes

Edit `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` and re-run the onboard wizard:

```console
$ nemoclaw onboard
```

### Dynamic Changes

Apply policy updates to a running sandbox without restarting:

```console
$ openshell policy set <policy-file>
```