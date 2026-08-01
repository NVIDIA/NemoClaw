// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// SOURCE_OF_TRUTH_REVIEW: Budget constants for the connect-time auto-pair scope-approval pass
// (runConnectAutoPairApprovalPass in ./connect). Kept in a lightweight module
// so tests can import and assert the invariant on the real values without
// pulling in connect.ts's heavy transitive requires (#4504).

export const CONNECT_AUTO_PAIR_MAX_APPROVALS = 1;
// `openclaw devices list` budget (seconds), interpolated into the in-sandbox
// script so the invariant below is asserted on real values, not source text.
// A cold OpenClaw 2026.6.10 CLI can take just over 2s to load its runtime
// preloads on supported but resource-constrained hosts, so 5s prevents the
// finalization recovery from timing out before it can observe the pending
// request (#4504).
export const CONNECT_AUTO_PAIR_LIST_TIMEOUT_S = 5;
// `openclaw devices approve` budget (seconds); matches the in-sandbox watcher's
// RUN_TIMEOUT_SECS = 10 (nemoclaw-start.sh).
export const CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S = 10;
// Bounds for reading restored-clone pending state while the agent gateway
// publishes it, and for observing a timed-out approval. These feed the
// in-sandbox script and the outer-cap invariant below so the budgets cannot
// drift apart.
export const CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS = 10;
export const CONNECT_AUTO_PAIR_PENDING_READ_POLL_S = 0.1;
export const CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S = 4;
// Outer spawnSync cap (ms). Must exceed the internal worst case
// for either ordinary listing or restored-clone publication and observation.
// The outer timer starts at `openshell sandbox exec`, before the remote shell
// sources the proxy environment and launches Python. Keep 10s beyond the longer
// inner path so the outer timer cannot terminate a legitimate approval before
// its fixed receipt is returned.
export const CONNECT_AUTO_PAIR_TIMEOUT_MS = 25_000;
