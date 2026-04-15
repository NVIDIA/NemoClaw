<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Deployment — Security Considerations

> **The manifest in [`nemoclaw-k8s.yaml`](./nemoclaw-k8s.yaml) is for evaluation only. Do not run it as-is in a production cluster.**

The existing `k8s/README.md` already calls the deployment "experimental",
but the specific patterns that make it experimental are not spelled out.
This page lists each one, why it is unsafe in production, and what a
production-ready alternative would look like. It addresses the gap
flagged in [#1442](https://github.com/NVIDIA/NemoClaw/issues/1442).

## What the evaluation manifest does

The pod runs **two containers** plus an init container:

| Container | Image | Purpose |
|---|---|---|
| `dind` | `docker:24-dind` | Docker-in-Docker daemon. Required because OpenShell sandboxes are Docker containers and a sandbox-on-sandbox needs a real daemon. |
| `workspace` | `node:22` | Runs the official NemoClaw installer over the DinD socket. |
| `init-docker-config` | `busybox` | Writes `daemon.json` so DinD uses host cgroup namespacing. |

That arrangement is the simplest possible way to get NemoClaw onto a
Kubernetes cluster — and also the most dangerous one. The patterns
below are intentional for an *evaluation* deployment but would be
unacceptable in *production*.

## Security risks in the evaluation manifest

### 1. `privileged: true` on the DinD container

```yaml
securityContext:
  privileged: true
```

A privileged container has effectively **no isolation from the node**.
It can load kernel modules, mount the host filesystem, access every
device, and (with a single misstep) escalate to full node compromise.
This is required to run a nested Docker daemon — the daemon needs
unrestricted access to cgroups, namespaces, and `/var/lib/docker` —
but it means a successful exploit inside the sandbox escalates not
just to the pod but to the entire node.

**Production alternative:** run the sandbox container directly on the
host's container runtime via a CSI driver or a runtime class
(`runc`, `kata`, `gvisor`), and skip DinD entirely. NemoClaw's
OpenShell runtime does not require Docker-in-Docker if the host
already has a compatible runtime.

### 2. Docker TLS disabled

```yaml
env:
  - name: DOCKER_TLS_CERTDIR
    value: ""
```

Setting `DOCKER_TLS_CERTDIR=""` makes the DinD daemon listen on a
plain Unix socket with no client authentication. Any process inside
the workspace container that can reach `/var/run/docker.sock` can
issue arbitrary Docker API calls — including `docker run -v /:/host`
to escape the sandbox.

**Production alternative:** leave `DOCKER_TLS_CERTDIR` at its default
so the daemon issues client certs, then mount only the certs (not the
socket) into the workspace container.

### 3. `NEMOCLAW_POLICY_MODE=suggested`

```yaml
- name: NEMOCLAW_POLICY_MODE
  value: "suggested"
```

The current manifest uses `suggested` — a permissive mode that
applies NemoClaw's suggested policy presets without strictly
enforcing them. This is a meaningful improvement over the previous
`skip` default (which disabled policy enforcement entirely), but it
is still not the strictest setting. For production workloads
handling sensitive data, reduce the allowed policy set to only the
presets the agent actually needs during onboard.

### 4. Installer pulled over the network at pod start

The manifest now downloads the installer to a local file with
HTTPS-only curl flags before executing:

```yaml
curl --proto '=https' --tlsv1.2 --fail --show-error --silent \
  --location \
  --output /tmp/nemoclaw-install.sh \
  https://www.nvidia.com/nemoclaw.sh
chmod 700 /tmp/nemoclaw-install.sh
bash /tmp/nemoclaw-install.sh
```

This is better than the original `curl | bash` — the download and
execute are now separate steps, TLS 1.2+ is enforced, and HTTP is
rejected. However, the installer script itself is still pulled at
pod start with no checksum verification and no version pinning. A
compromise of the installer URL or a transient redirect is still a
one-shot supply-chain compromise of every pod that ever restarts.

**Production alternative:** build a NemoClaw image at a known tag,
publish it to your own registry pinned by digest (see #1438), and
deploy that image instead of running the installer at pod start.

### 5. API key handling

The manifest now loads `COMPATIBLE_API_KEY` from an optional
Kubernetes `Secret` with a `dummy` fallback in startup shell logic
for unauthenticated endpoints like local Dynamo/vLLM:

```yaml
- name: COMPATIBLE_API_KEY
  valueFrom:
    secretKeyRef:
      name: nemoclaw-compatible-api-key
      key: api-key
      optional: true
```

This is the correct pattern for production. The `optional: true`
flag allows the manifest to deploy without the Secret (useful for
evaluation against open endpoints), and the startup shell assigns
`dummy` when the Secret is absent so the CLI's credential
validation does not block startup. For production, create the
Secret with a real key before applying the manifest — see the
step-by-step in [README.md](./README.md).

### 6. No `NetworkPolicy`

The pod has no Kubernetes `NetworkPolicy` attached. With the default
"allow all" cluster behavior, the workspace container can reach any
service in the cluster — including the kube-apiserver — via the
node's cluster network, and `POLICY_MODE=skip` removes the
NemoClaw-side guardrail too.

**Production alternative:** ship a default-deny `NetworkPolicy` for
the `nemoclaw` namespace and explicitly allow only the inference
endpoint and DNS.

### 7. No `limits` (only `requests`)

```yaml
resources:
  requests:
    memory: "8Gi"
    cpu: "2"
```

Without `resources.limits`, a runaway agent or a memory leak in the
sandbox can consume unbounded CPU and memory on the node, causing
OOMKills of unrelated workloads. This is the gap flagged in
[#1447](https://github.com/NVIDIA/NemoClaw/issues/1447).

**Production alternative:**

```yaml
resources:
  requests:
    memory: "8Gi"
    cpu: "2"
  limits:
    memory: "16Gi"
    cpu: "4"
```

## Minimum bar for production

If you need to run NemoClaw on a real Kubernetes cluster, none of the
above is acceptable as-is. At a minimum:

1. **Drop `privileged: true`.** Use a runtime class instead of DinD.
2. **Build and pin a NemoClaw image** by digest. Do not `curl | bash`
   at pod start.
3. **Source credentials from `Secret` resources**, not env vars.
4. **Reduce the policy preset set.** The manifest already uses
   `NEMOCLAW_POLICY_MODE=suggested` (a permissive but non-skip
   default). Narrow the suggested presets to only what the agent
   actually needs during onboard.
5. **Attach a default-deny `NetworkPolicy`** to the `nemoclaw`
   namespace.
6. **Set `resources.limits`** so a sandbox cannot starve the node.
7. **Add `livenessProbe` / `readinessProbe`** so kubelet can detect
   and restart unhealthy pods.

The current manifest deliberately ships **none** of those because it
optimizes for "kubectl apply and try it out". That tradeoff is fine
for evaluation, dangerous for production, and the reason this page
exists.
