<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
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
  - POST to inference paths on `api.anthropic.com`, POST on `statsig.anthropic.com`, GET only on `sentry.io`

* - `nvidia`
  - `integrate.api.nvidia.com:443`, `inference-api.nvidia.com:443`
  - `/usr/local/bin/claude`, `/usr/local/bin/openclaw`
  - POST to inference and embedding paths, GET to model listings

* - `clawhub`
  - `clawhub.ai:443`
  - `/usr/local/bin/openclaw`, `/usr/local/bin/node`
  - GET, POST

* - `openclaw_api`
  - `openclaw.ai:443`
  - `/usr/local/bin/openclaw`, `/usr/local/bin/node`
  - GET, POST

* - `openclaw_docs`
  - `docs.openclaw.ai:443`
  - `/usr/local/bin/openclaw`
  - GET only

* - `npm_registry`
  - `registry.npmjs.org:443`
  - `/usr/local/bin/openclaw`, `/usr/local/bin/npm`, `/usr/local/bin/node`
  - GET only

:::

All endpoints use TLS termination and are enforced at port 443.

> **Note:** GitHub access (`github.com`, `api.github.com`) is not included in the baseline policy.
> Apply the `github` preset during onboarding if your agent needs GitHub access.
> See Customize the Network Policy (see the `nemoclaw-user-manage-policy` skill).

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
