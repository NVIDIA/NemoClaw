// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseManagedImageDiscoveryContract } from "../../../tools/e2e/managed-image-discovery-contract.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const reviewedArtifacts = [
  "BUNDLED_PACKAGES.json",
  "THIRD_PARTY_LICENSES.txt",
  "mcp-tool-discovery.bundle",
] as const;
const agentPlatforms = [
  { agent: "openclaw", platform: "linux/amd64" },
  { agent: "openclaw", platform: "linux/arm64" },
  { agent: "hermes", platform: "linux/amd64" },
  { agent: "hermes", platform: "linux/arm64" },
  { agent: "langchain-deepagents-code", platform: "linux/amd64" },
  { agent: "langchain-deepagents-code", platform: "linux/arm64" },
] as const;
const rejectedContracts = [
  '{"protocol":1,"ok":false,"detail":"wrong"}\n',
  '{"protocol":1,"ok":false,"detail":"tool discovery received invalid runtime arguments","extra":NaN}\n',
  '\uFEFF{"protocol":1,"ok":false,"detail":"tool discovery received invalid runtime arguments"}\n',
  JSON.stringify({
    protocol: 1,
    ok: false,
    detail: "tool discovery received invalid runtime arguments",
    padding: "x".repeat(65 * 1024),
  }),
] as const;

describe("managed image discovery behavior", () => {
  it.each(agentPlatforms)(
    "accepts the $agent discovery failure contract on $platform",
    ({ agent, platform }) => {
      expect(() =>
        parseManagedImageDiscoveryContract(
          JSON.stringify({
            protocol: 1,
            ok: false,
            count: 0,
            tools: [],
            truncated: false,
            detail: "tool discovery received invalid runtime arguments",
            agent,
            platform,
          }),
        ),
      ).not.toThrow();
    },
  );

  it.each(rejectedContracts)("rejects malformed discovery output %#", (source) => {
    expect(() => parseManagedImageDiscoveryContract(source)).toThrow();
  });

  it("reproduces permission drift without following a reviewed artifact symlink", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discovery-drift-"));
    const reviewedRoot = path.join(fixture, "reviewed-runtime-bundle", "mcp-tool-discovery");
    const script = path.join(
      repoRoot,
      "scripts",
      "checks",
      "reproduce-reviewed-discovery-permission-drift.sh",
    );
    fs.mkdirSync(reviewedRoot, { recursive: true });
    try {
      fs.writeFileSync(path.join(reviewedRoot, reviewedArtifacts[0]), `${reviewedArtifacts[0]}\n`, {
        mode: 0o444,
      });
      fs.writeFileSync(path.join(reviewedRoot, reviewedArtifacts[1]), `${reviewedArtifacts[1]}\n`, {
        mode: 0o444,
      });
      fs.writeFileSync(path.join(reviewedRoot, reviewedArtifacts[2]), `${reviewedArtifacts[2]}\n`, {
        mode: 0o444,
      });
      const accepted = spawnSync("bash", [script, reviewedRoot], {
        encoding: "utf8",
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.statSync(path.join(reviewedRoot, reviewedArtifacts[0])).mode & 0o777).toBe(0o664);
      expect(fs.statSync(path.join(reviewedRoot, reviewedArtifacts[1])).mode & 0o777).toBe(0o664);
      expect(fs.statSync(path.join(reviewedRoot, reviewedArtifacts[2])).mode & 0o777).toBe(0o664);

      const linkedArtifact = path.join(reviewedRoot, reviewedArtifacts[0]);
      const externalArtifact = path.join(fixture, "external-reviewed-artifact.json");
      fs.unlinkSync(linkedArtifact);
      fs.writeFileSync(externalArtifact, "{}\n", { mode: 0o444 });
      fs.symlinkSync(externalArtifact, linkedArtifact);
      const rejected = spawnSync("bash", [script, reviewedRoot], {
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "ERROR: reviewed discovery permission fixture must be a regular non-symlink:",
      );
      expect(fs.statSync(externalArtifact).mode & 0o777).toBe(0o444);
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  });
});
