---
title:
  page: "Proxy-Only Host Bridge Local Channel"
  nav: "Host Bridge Local Channel"
description:
  main: "Design and operator workflow for a proxy-only OpenShell host bridge used by NemoClaw."
  agent: "Explains the codex_version host bridge, the OpenShell/NemoClaw responsibility split, and the evidence needed for Stage 5 validation."
keywords: ["nemoclaw host bridge", "openshell host-service", "codex bridge", "proxy-only service"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "security", "network_policy"]
content:
  type: reference
  difficulty: advanced
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Proxy-Only Host Bridge for `codex_version`

This document defines the NemoClaw-side v1 wrapper used to prepare a future OpenShell host bridge for hoiku Stage 5 without copying host credentials into the sandbox or mounting host filesystems.

This change does not implement the OpenShell primitive itself.

## Problem

The hoiku Stage 5 proof needs a sandboxed OpenClaw agent to trigger exactly one host-side Codex operation:

- method: `POST`
- path: `/codex_version`
- service name: `codex-bridge.local`

The current runtime has no supported sandbox-to-host local channel for that flow.
Direct host access through `host.docker.internal` is not acceptable because it can be reached outside the proxy path with `--noproxy`.
Hoiku Stage 5 remains blocked until the OpenShell primitive exists.

## Transport Choice

The MVP uses plain HTTP from the sandbox-visible interface:

```text
http://codex-bridge.local/codex_version
```

The request must traverse the OpenShell proxy.
The service name is logical and proxy-only:

- it must not be published in sandbox DNS
- it must not be written into `/etc/hosts`
- it must not be exposed through generic host aliases

Expected flow:

1. sandbox runs `curl -X POST http://codex-bridge.local/codex_version`
2. OpenShell proxy matches `Host: codex-bridge.local`
3. OpenShell enforces sandbox, service, port, method, and path
4. OpenShell forwards plain HTTP to `127.0.0.1:36566`

Direct access such as `curl --noproxy '*' http://codex-bridge.local/codex_version` must fail before the request reaches the host bridge.

HTTPS/TLS can be future work after OpenShell provides proxy-only routing for the service.

## Threat Model

The design must not allow:

- arbitrary shell execution on the host
- arbitrary Codex prompts
- wildcard host or path access
- host home mounts
- credential copying into the sandbox
- broad `host.docker.internal` egress

This is safer than a host mount or credential copy because the sandbox gets only a constrained proxy route.
The host keeps the Codex runtime, login session, and any related secrets entirely outside the sandbox filesystem.

## Responsibility Split

### OpenShell upstream

OpenShell owns the primitive:

- `openshell host-service register`
- `openshell host-service unregister`
- `openshell host-service list`
- proxy-only service-name routing
- REST enforcement on sandbox, service name, port, method, and path
- audit logging
- request id generation and propagation

OpenShell registration must not widen sandbox policy automatically.

### NemoClaw

NemoClaw owns:

- `nemoclaw <sandbox> host-bridge add codex-version`
- `nemoclaw <sandbox> host-bridge remove codex-version`
- `nemoclaw <sandbox> host-bridge list`
- local policy merge and `openshell policy set`
- evidence capture
- revert script generation

NemoClaw does not patch gateway internals directly.
It is a thin CLI, policy, and evidence wrapper around OpenShell commands and records the before/after state needed for validation.

## Request ID and Audit

OpenShell should generate one request id per bridge request and forward it as:

```text
X-OpenShell-Request-Id: <uuid>
```

OpenShell audit logs should include:

- request id
- sandbox name
- service name
- target host and port
- method
- path
- decision
- binary path if available

The host bridge access log should record the same request id and echo it in the response when practical.

## Registration Shape

The expected registration payload is captured in `bridge_registration.json` and is intended to be passed to the future OpenShell command:

```json
{
  "version": 1,
  "sandbox": "hoiku-readonly-secure",
  "service_name": "codex-bridge.local",
  "service_port": 80,
  "target_scheme": "http",
  "target_host": "127.0.0.1",
  "target_port": 36566,
  "target_path": "/codex_version",
  "protocol": "rest",
  "enforcement": "enforce",
  "rules": [
    {
      "allow": {
        "method": "POST",
        "path": "/codex_version"
      }
    }
  ],
  "binaries": [
    {
      "path": "/usr/bin/curl"
    }
  ]
}
```

Binary identity is a best-effort restriction unless OpenShell exposes binary identity at the enforcement point.
The v1 acceptance boundary is sandbox, service, port, method, and path.

## Evidence and Revert

NemoClaw writes evidence under:

```text
~/.nemoclaw/state/host-bridges/<sandbox>/<timestamp>-<operation>-codex-version/
```

Required artifacts:

- `policy_before.yaml`
- `policy_after.yaml`
- `bridge_registration.json`
- `revert.sh`
- `validation_notes.txt`

`revert.sh` restores the prior policy and unregisters or re-registers the host service depending on the operation.

## Stage 5 Retry

Stage 5 is retryable only when all of the following are true:

- OpenShell provides proxy-only `host-service` commands
- `codex-bridge.local` is not directly resolvable outside the proxy path
- the fixed-purpose host bridge server is running on the host
- NemoClaw can produce before/after/revert evidence
- allow and deny logs correlate with the forwarded request id

Until then, Hoiku Stage 5 cannot pass and Stage 6 must remain blocked.

Then rerun:

```console
$ python3 scripts/ops/nemoclaw/prove_hoiku_openclaw_stage5_bridge.py --allow-operator-approved-bridge --json
```
