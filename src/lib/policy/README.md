<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Policy

OpenShell is the sole durable source of truth for sandbox policy. NemoClaw
provides convenience commands that read the current OpenShell policy, compose a
requested delta, submit it to OpenShell, and verify the resulting live state.

NemoClaw does not persist policy ownership, policy receipts, applied preset
lists, custom policy copies, baseline exclusion ledgers, or policy hashes and
versions as policy authority. Registry and onboarding-session normalization
discard legacy copies of those fields without replaying them.

During an incomplete onboarding policy step, the session temporarily retains
the selected preset names and tier with the sandbox identity. Resume reconciles
that pending selection against live OpenShell policy; it is cleared only after
the live policy confirms application. It is not applied-policy authority.

Policy mutations preserve unrelated live entries. Custom preset identity is
encoded in namespaced OpenShell policy keys so list and remove commands can
derive it from live state. Generated MCP policy is derived from durable MCP
target and credential-domain state, not from a second policy registry.

Rebuild and clone operations use a private temporary copy of the current
OpenShell base policy for the active transaction and remove that copy after
completion.
