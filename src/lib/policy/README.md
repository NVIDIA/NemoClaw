<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Policy

Policy modules own sandbox network-policy preset loading, tier resolution, and
policy application helpers. They may orchestrate OpenShell policy commands while
legacy flows are being migrated, but pure selection/planning helpers should move
under `src/lib/domain/**` when they can be isolated.

## Policy authority

The policy module reads the effective OpenShell policy through the sandbox's recorded gateway.
NemoClaw records the first qualified authority before another policy read or set.
NemoClaw refuses the operation when it cannot write that record.

Immediately before each policy set, NemoClaw reads authority again and compares it with the record.
NemoClaw refuses the policy set when:

- NemoClaw cannot determine authority.
- Recorded and observed authority differ.
- An external authority owns the policy.

For external authority, preset requests only verify the effective policy.
NemoClaw requires the exact preset entries before it reports success.
NemoClaw does not set policy or record preset or custom-policy attribution.
The external authority must supply a missing or changed entry.

If policy authority becomes external while Shields is down, NemoClaw keeps the
saved restrictive policy snapshot and refuses to set policy. The external
policy authority must make the effective policy for the named sandbox match the
saved restrictive snapshot and current managed MCP entries without changing
policy authority. `shields status` identifies that required policy by its
canonical JSON SHA-256 digest and network policy keys. The first status can
report no artifact. Run `nemoclaw <sandbox> shields up` once to create and
report the complete recovery artifact. The artifact contains no credential
values. It contains the saved restrictive policy and current managed MCP policy
entries, which may include credential bindings. Apply the artifact as the exact
policy through the external authority; do not reconstruct it from the digest
or key list. Then rerun `nemoclaw <sandbox> shields up`. NemoClaw verifies the
exact effective policy and locks configuration. If policy changes during the
lock, NemoClaw records the verified config lock and keeps Shields down until
policy recovery succeeds.

A legacy sandbox record retains the first qualified `policyAuthority` after a later operation fails.
An inspection that cannot determine authority does not change the record.
