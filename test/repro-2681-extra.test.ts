// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural-invariant coverage for the EACCES patches in Dockerfile (#2681).
 *
 * The PR is a Dockerfile sed-style patch that wraps OpenClaw's
 * mutateConfigFile in a try/catch mirroring the existing Patch 4 wrap of
 * replaceConfigFile. There's no unit-testable code path; this guard
 * locks the structural invariants so future Dockerfile edits can't
 * silently regress them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");
const SRC = fs.readFileSync(DOCKERFILE, "utf-8");

describe("Issue #2681 — EACCES patch structural invariants", () => {
  it("BOTH PATCHES PRESENT: Patch 4 and Patch 4b are wired", () => {
    expect(SRC).toContain("Patch 4: graceful EACCES in replaceConfigFile");
    expect(SRC).toContain("Patch 4b: graceful EACCES in mutateConfigFile");
  });

  it("PARALLEL EACCES GUARD: both patches gate on OPENSHELL_SANDBOX === \"1\" + EACCES", () => {
    // The guards must be identical so behavior in production matches between
    // replaceConfigFile (plugin install) and mutateConfigFile (control UI).
    const eaccesGuards = SRC.match(/process\.env\.OPENSHELL_SANDBOX === \\"1\\" && _\w+\.code === \\"EACCES\\"/g);
    expect(eaccesGuards).not.toBeNull();
    expect(eaccesGuards!.length).toBe(2);
  });

  it("BUILD-TIME ASSERTIONS: both patches have grep guards that fail the build if missing", () => {
    expect(SRC).toContain('"ERROR: Patch 4 (replaceConfigFile EACCES) not applied"');
    expect(SRC).toContain('"ERROR: Patch 4b (mutateConfigFile EACCES) not applied"');
    // Each patch is followed by a grep -REq … || { echo "ERROR: …" >&2; exit 1; }
    const exitGuards = SRC.match(/exit 1; \}/g) || [];
    expect(exitGuards.length).toBeGreaterThanOrEqual(2);
  });

  it("DISTINCT LOG MESSAGES: Patch 4 and 4b emit different swallow lines", () => {
    // If the messages collide, log-driven debugging can't tell which path
    // hit EACCES. Lock the distinction.
    expect(SRC).toContain("plugin metadata not persisted");
    expect(SRC).toContain("mutation not persisted");
  });

  it("ORDERING: Patch 4 must run before Patch 4b (4b explicitly mirrors 4)", () => {
    const idx4 = SRC.indexOf("Patch 4: graceful EACCES");
    const idx4b = SRC.indexOf("Patch 4b: graceful EACCES");
    expect(idx4).toBeGreaterThan(0);
    expect(idx4b).toBeGreaterThan(idx4);
  });

  it("RETHROW ON UNKNOWN: both catches re-throw when the error isn't EACCES-in-sandbox", () => {
    // Without re-throw, real bugs would be silently swallowed in any non-
    // sandbox context. Each catch block must `else { throw _<x>Err; }`.
    const rethrows = SRC.match(/} else \{ throw _\w+Err; \}/g) || [];
    expect(rethrows.length).toBe(2);
  });
});
