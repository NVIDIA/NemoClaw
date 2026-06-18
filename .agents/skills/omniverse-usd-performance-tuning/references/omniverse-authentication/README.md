# Omniverse Authentication

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when omniverse:// assets need Kit or omni.client auth preflight. Do not use for local USD files.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Use this before opening `omniverse://` assets from Kit, USD Python, validators,
or Scene Optimizer operations.

Confirm the agent can access the remote stage and explain any authentication
side effects. A browser window or SSO prompt is expected on first access and is
not a validation failure.

## Prerequisites

- Target `omniverse://` URL and server name.
- User approval for interactive browser authentication when cached credentials
  are unavailable.
- Kit runtime with `omni.client` and `omni.usd_resolver` available.

## Limitations

- This reference verifies access; it does not grant new permissions.
- Do not invent, request, or persist passwords or tokens in the repo.
- A local exported copy can unblock profiling, but remote-vs-local I/O is not a
  fair cold-open comparison.

## Preflight

1. Identify the target URL and server, e.g. `omniverse://host/path/file.usd`.
2. Ask whether interactive browser authentication is acceptable. If the user is
   away or downloads/auth prompts are forbidden, do not rely on a fresh SSO
   flow.
3. Start Kit with remote access extensions enabled:

```python
app.startup([
    "--no-window",
    "--enable", "omni.client",
    "--enable", "omni.usd_resolver",
])
```

4. Run a cheap `omni.client.stat(url)` or open the parent folder before opening
   the full stage.
5. If auth succeeds, note that credentials are cached locally for later Kit
   sessions on the same machine/user.

## Supported Access Patterns

- **Interactive browser SSO:** Kit or `omni.client` opens a browser/device login.
  Good for attended desktop sessions.
- **Cached user credentials:** Prior Omniverse/Kit login is reused. Good for
  repeat tests; still preflight with `omni.client.stat`.
- **Enterprise/service account:** Use only if the customer provides an approved
  non-interactive credential path. Do not invent or persist secrets in the repo.
- **Mounted or synced local mirror:** Prefer this when the customer cannot
  authenticate or when network I/O dominates profiling.
- **Local exported copy:** Useful for after-profiles, but report that cold-open
  comparisons against remote source are not fair optimization signals.

## Troubleshooting

If remote open fails:

- Distinguish auth failure from resolver/network failure and missing asset.
- Preserve the exact URL and error in the run log.
- Suggest pre-authenticating in a Kit/Omniverse desktop app when browser SSO is
  required.
- Do not repeatedly retry full-stage opens; use `stat` or a parent-folder probe.
- Do not ask the user to paste passwords or tokens into chat.

## Reporting

State:

- Whether remote access was preflighted.
- Whether auth was interactive, cached, service-based, or unavailable.
- Whether the stage profile used the remote URL or a local exported copy.
- Any comparison caveat caused by remote vs local I/O.
