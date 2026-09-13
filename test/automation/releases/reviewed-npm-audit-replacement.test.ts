// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  lockedGraphAuditProvenance,
  parseAuditConfig,
  selectReviewedLockedGraphIdentity,
} from "../../../scripts/audit-reviewed-npm-graph.mts";
import { verifyReviewedNpmLock } from "../../../scripts/lib/reviewed-npm-archive.mts";
import { openClawReplacementGraphFixture } from "./reviewed-npm-audit-fixtures.ts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const REVIEWED_AUDIT_CONFIG = parseAuditConfig(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf8"),
);

describe("reviewed npm audit replacement identity", () => {
  it("verifies the checked-in OpenClaw replacement lock and audit provenance", () => {
    const graph = REVIEWED_AUDIT_CONFIG.lockedGraphs.find(({ id }) => id === "openclaw-runtime")!;
    expect(graph).toBeDefined();
    expect(graph.replacement).toBeDefined();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-replacement-"));
    const lockfile = path.join(root, "package-lock.json");
    const fixture = openClawReplacementGraphFixture(REPO_ROOT, graph);
    fs.writeFileSync(lockfile, fixture.lock);

    try {
      const identity = selectReviewedLockedGraphIdentity(lockfile, graph);
      expect(identity).toEqual(graph.replacement);
      const metadataLookups: string[][] = [];
      expect(
        verifyReviewedNpmLock(
          {
            expectedIntegrity: identity.integrity,
            expectedLockSha256: identity.lockSha256,
            label: identity.label,
            lockfilePath: lockfile,
            packageSpec: identity.packageSpec,
            registryOrigin: REVIEWED_AUDIT_CONFIG.registryOrigin,
            tarballUrl: identity.tarballUrl,
          },
          (args, request) => {
            metadataLookups.push([...args]);
            return args[2] === "dist.integrity" ? request.expectedIntegrity : request.tarballUrl;
          },
        ),
      ).toContain("openclaw@2026.9.1");
      expect(metadataLookups).toEqual([
        ["view", "openclaw@2026.9.1", "dist.integrity"],
        ["view", "openclaw@2026.9.1", "dist.tarball"],
      ]);
      expect(lockedGraphAuditProvenance(identity, "v22.23.2", "10.9.4")).toEqual({
        label: "OpenClaw 2026.9.1 locked runtime graph",
        nodeVersion: "v22.23.2",
        npmVersion: "10.9.4",
        packageSpecs: ["openclaw@2026.9.1"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
