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
saved restrictive policy snapshot and refuses to restore it. The external
policy authority must keep the restrictive policy active until it returns
policy authority to NemoClaw management. Then run
`nemoclaw <sandbox> shields up` to restore the saved snapshot and finish the
Shields transition. `shields status` reports this recovery requirement while
the sandbox remains unlocked.

A legacy sandbox record retains the first qualified `policyAuthority` after a later operation fails.
An inspection that cannot determine authority does not change the record.
