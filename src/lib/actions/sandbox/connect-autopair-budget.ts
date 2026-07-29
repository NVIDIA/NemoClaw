// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// SOURCE_OF_TRUTH_REVIEW: Budget constants for the connect-time auto-pair scope-approval pass
// (runConnectAutoPairApprovalPass in ./connect). Kept in a dependency-free leaf
// module so tests can import and assert the invariant on the real values
// without pulling in connect.ts's heavy transitive requires (#4504).

export const CONNECT_AUTO_PAIR_MAX_APPROVALS = 1;
// `openclaw devices list` budget (seconds), interpolated into the in-sandbox
// script so the invariant below is asserted on real values, not source text.
// OpenClaw 2026.7.1 gives its device-list gateway call 10s after CLI startup.
// Keep the enclosing subprocess above that internal deadline so a supported
// but resource-constrained host cannot terminate the command before OpenClaw
// can classify its own result (#4504).
export const CONNECT_AUTO_PAIR_LIST_TIMEOUT_S = 15;
// `openclaw devices approve` budget (seconds); matches the in-sandbox watcher's
// RUN_TIMEOUT_SECS = 10 (nemoclaw-start.sh).
export const CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S = 10;
// Outer spawnSync cap (ms). Must exceed the internal worst case
// (CONNECT_AUTO_PAIR_LIST_TIMEOUT_S + CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S ×
// CONNECT_AUTO_PAIR_MAX_APPROVALS) PLUS shell/python startup, since the outer
// timer starts at `sh` spawn before the proxy env is sourced and python3
// launches; the 5s slack prevents the outer timeout from terminating a
// legitimate slow approve mid-loop, which would strand the allowlisted request.
export const CONNECT_AUTO_PAIR_TIMEOUT_MS = 30_000;
