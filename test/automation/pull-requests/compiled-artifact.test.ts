// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCompiledArtifact } from "../../../.github/actions/ci-compile-artifacts/compiled-artifact.mts";
import {
  COMPILED_ARTIFACT_SHA,
  cleanupCompiledArtifactFixtures,
  createCompiledArtifactFixture,
  runCompiledArtifactPreparation,
} from "../../helpers/compiled-artifact-fixture";

afterEach(cleanupCompiledArtifactFixtures);

describe("compiled artifact cache boundary", () => {
  it("accepts a complete CLI and plugin package for the checkout", () => {
    expect(() =>
      verifyCompiledArtifact(createCompiledArtifactFixture(), COMPILED_ARTIFACT_SHA),
    ).not.toThrow();
  });

  it("rejects compiled output from another commit", () => {
    expect(() => verifyCompiledArtifact(createCompiledArtifactFixture(), "b".repeat(40))).toThrow(
      "checkout SHA",
    );
  });

  it("rejects a CLI-only package", () => {
    const root = createCompiledArtifactFixture();
    rmSync(join(root, "nemoclaw/dist/index.js"));
    expect(() => verifyCompiledArtifact(root, COMPILED_ARTIFACT_SHA)).toThrow();
  });

  it("rejects an empty plugin entry point", () => {
    const root = createCompiledArtifactFixture();
    writeFileSync(join(root, "nemoclaw/dist/index.js"), "");
    expect(() => verifyCompiledArtifact(root, COMPILED_ARTIFACT_SHA)).toThrow(
      "Missing compiled output",
    );
  });

  it("rejects a link before reading build identity", () => {
    const root = createCompiledArtifactFixture();
    symlinkSync("/unavailable", join(root, "dist/linked"));
    expect(() => verifyCompiledArtifact(root, COMPILED_ARTIFACT_SHA)).toThrow(
      "link or special file",
    );
  });
});

describe("compiled artifact preparation", () => {
  it.each(["pull_request", "push", "workflow_dispatch"])(
    "skips installation and compilation on a %s cache hit",
    (event) => {
      const result = runCompiledArtifactPreparation(true, event);
      expect(result.failure).toBe("");
      expect(result.summary).not.toContain("gh cache delete");
      expect(result.commands).toEqual([]);
      expect(result.saved).toBe(0);
      expect(result.outputs.identity.sha).toBe(COMPILED_ARTIFACT_SHA);
    },
  );

  it.each(["pull_request", "push", "workflow_dispatch"])(
    "builds and caches the full package after a %s miss",
    (event) => {
      const result = runCompiledArtifactPreparation(false, event);
      expect(result.failure).toBe("");
      expect(result.summary).not.toContain("gh cache delete");
      expect(result.commands).toEqual(["install", "--prefix nemoclaw run build", "run build:cli"]);
      expect(existsSync(join(result.root, "dist/stale"))).toBe(false);
      expect(result.saved).toBe(1);
      expect(() => verifyCompiledArtifact(result.root, COMPILED_ARTIFACT_SHA)).not.toThrow();
    },
  );

  it("reports recovery for a rejected cache hit without compiling or saving", () => {
    const result = runCompiledArtifactPreparation(true, "pull_request", true);
    expect(result.failure).toContain("checkout SHA");
    expect(result.commands).toEqual([]);
    expect(result.saved).toBe(0);
    expect(result.summary).toContain(`Cache key: \`${result.outputs.identity.key}\``);
    expect(result.summary).toContain("Result: failure. Cache hit: true.");
    expect(result.summary).toContain(
      `gh cache delete "${result.outputs.identity.key}" --repo "NVIDIA/NemoClaw"`,
    );
  });

  it("uses the same cache identity for main CI and manual E2E of the same commit", () => {
    const main = runCompiledArtifactPreparation(true, "push");
    const e2e = runCompiledArtifactPreparation(true, "workflow_dispatch");
    expect(main.failure).toBe("");
    expect(e2e.failure).toBe("");
    expect(main.outputs.identity.key).toBe(e2e.outputs.identity.key);
  });
});
