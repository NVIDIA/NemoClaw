// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Denial-adjacent guidance for `nemoclaw <name> exec -- ...` (#5978).
 *
 * OpenShell's proxy records structured policy-denial details, while generic
 * child tools surface only an opaque CONNECT 403. NemoClaw cannot change that
 * upstream failure site, so the post-exec boundary correlates a fresh audit
 * event and emits a bounded host-side breadcrumb without changing child output
 * or exit status.
 *
 * Internal boundaries:
 * - detection: structured denial matching, endpoint sanitization, recency;
 * - rendering: sandbox-name sanitization, breadcrumb text, suppression;
 * - emission: bounded runtime probes, retries, and best-effort output.
 *
 * Remove this bridge when OpenShell exposes a typed exec-denial result with the
 * denied endpoint and logs pointer. Regression coverage is split across the
 * matching focused test files plus exec.test.ts for action-boundary behavior.
 */

export * from "./exec-policy-hint-detection";
export * from "./exec-policy-hint-emission";
export * from "./exec-policy-hint-rendering";
