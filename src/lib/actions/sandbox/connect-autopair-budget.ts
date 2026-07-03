// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Budget constants for the connect-time auto-pair scope-approval pass
// (runConnectAutoPairApprovalPass in ./connect). Kept in a dependency-free leaf
// module so tests can import and assert the invariant on the real values
// without pulling in connect.ts's heavy transitive requires (#4504).

export const CONNECT_AUTO_PAIR_MAX_APPROVALS = 1;
// Historical list budget retained for compatibility with the approval-pass
// options object. The state-only approval pass does not invoke `openclaw`.
export const CONNECT_AUTO_PAIR_LIST_TIMEOUT_S = 2;
// Historical approve budget retained for compatibility with the approval-pass
// options object. The state-only approval pass does not invoke `openclaw`.
export const CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S = 10;
// Outer spawnSync cap (ms). The state-only pass is quick, but this still bounds
// sandbox exec, shell startup, proxy env sourcing, and python3 launch.
export const CONNECT_AUTO_PAIR_TIMEOUT_MS = 15_000;
