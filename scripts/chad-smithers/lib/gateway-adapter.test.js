// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Test scaffold for lib/gateway-adapter.js (Upgrade A — live sync).
// See GATEWAY-UI-MIGRATION-PLAN.md, task T.1.
//
// These are `todo` tests: they enumerate the acceptance criteria for the
// gateway -> runs-UI shape adapter BEFORE it exists, so implementation has a
// spec to fill in. They do NOT fail CI (node:test reports todo separately).
// As lib/gateway-adapter.js lands, replace each `{ todo: true }` with a real
// assertion body and drop the import guard.
//
// Run: node --test lib/gateway-adapter.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

// The adapter does not exist yet. Import lazily so the file runs (as todos)
// before implementation, and flips to real tests once the module is present.
let adapter = null;
try {
  adapter = await import("./gateway-adapter.js");
} catch {
  /* not implemented yet — tests below are todo */
}

// ── run row mapping ─────────────────────────────────────────────────────────
test("maps a gateway run frame to the { workflow_name, status, started, dur, db } row index.html renders", { todo: !adapter }, () => {
  // GIVEN a gateway run object + its db basename
  // WHEN adapter.toRunRow(gwRun, db)
  // THEN keys/shape exactly match serve-runs' /api/runs row (so renderRuns() is source-agnostic)
  assert.ok(adapter?.toRunRow);
});

// ── node / attempt mapping ──────────────────────────────────────────────────
test("keys loop/retry attempts by structural position, not logical node id", { todo: !adapter }, () => {
  // gateway-ui NodeRow keys children by runNodeKey because loop/retry attempts
  // share an id. Two attempts of the same node id must produce two distinct rows.
  assert.ok(adapter?.toNodeRows);
});

test("maps node state -> our status pill classes (finished/failed/running/waiting-approval/cancelled)", { todo: !adapter }, () => {
  assert.ok(adapter?.statusToPill);
});

// ── event frame mapping ─────────────────────────────────────────────────────
test("maps a gateway event frame to the event-log line shape (ts, kind, node, color class)", { todo: !adapter }, () => {
  assert.ok(adapter?.toEventLine);
});

test("preserves event ordering and de-dupes frames already seen (live stream idempotency)", { todo: !adapter }, () => {
  assert.ok(adapter?.mergeEvents);
});

// ── token telemetry rollup ──────────────────────────────────────────────────
test("rolls up per-node tokens (input/output/reasoning/cache) matching the current 'N tokens, reasoning hidden' display", { todo: !adapter }, () => {
  assert.ok(adapter?.tokenRollup);
});

// ── round-trip against a captured fixture ───────────────────────────────────
test("round-trips a captured gateway fixture to the exact object the detail pane renders today", { todo: !adapter }, () => {
  // Load tests/fixtures/gateway-run.json (captured in Phase 0, task P0.3) and
  // assert adapter output deep-equals the /api/runs/:id detail object for the
  // same run. This is the parity guarantee for the flag-on path.
  assert.ok(adapter?.toRunDetail);
});
