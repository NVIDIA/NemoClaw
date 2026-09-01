// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
const root = path.join(import.meta.dirname, "../../..");
const dockerfileBase = fs.readFileSync(path.join(root, "agents/hermes/Dockerfile.base"), "utf8");
const hindsightProbeRequirementsPath = path.join(
  root,
  "agents/hermes/hindsight-client-probe-requirements.txt",
);

function arg(name: string): string {
  const match = dockerfileBase.match(new RegExp(`^ARG ${name}=(.+)$`, "mu"));
  expect(match, `Missing Dockerfile ARG ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

function uvVersionCheckStatus(output: string, expectedVersion: string): number | null {
  const dockerfileLines = dockerfileBase.split("\n");
  const installIndex = dockerfileLines.findIndex(
    (line) => line.startsWith("RUN pip3 install ") && line.includes('"uv==${UV_VERSION}"'),
  );
  expect(installIndex, "Missing Dockerfile uv install command").toBeGreaterThanOrEqual(0);
  const commandLines = dockerfileLines.slice(installIndex);
  const commandEndIndex = commandLines.findIndex((line) => !line.endsWith("\\"));
  const versionCheckLines = commandLines.slice(1, commandEndIndex + 1);
  const script = [
    'uv() { printf "%s\\n" "$UV_OUTPUT"; }',
    "set -e",
    ...versionCheckLines.map((line) => line.replace(/^\s*&&\s*/u, "").replace(/\s*\\$/u, "")),
  ].join("\n");
  return spawnSync("/bin/sh", ["-c", script], {
    env: { ...process.env, UV_OUTPUT: output, UV_VERSION: expectedVersion },
  }).status;
}

describe("Hermes 0.20.6 dependency review", () => {
  it("accepts uv build metadata and rejects a different semantic version", () => {
    const expectedVersion = arg("UV_VERSION");
    const differentVersion = expectedVersion.replace(/\d+$/u, (patchVersion) =>
      String(Number.parseInt(patchVersion, 10) + 1),
    );
    expect(
      uvVersionCheckStatus(
        `uv ${expectedVersion} (fece32fc5 2026-07-28 aarch64-unknown-linux-gnu)`,
        expectedVersion,
      ),
    ).toBe(0);
    expect(uvVersionCheckStatus(`uv ${differentVersion} (different)`, expectedVersion)).toBe(1);
  });

  it("rejects an altered Hindsight wheel before the compatibility import", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hindsight-hash-"));
    const artifact = path.join(temporaryRoot, "hindsight_client-0.6.1-py3-none-any.whl");
    const installTarget = path.join(temporaryRoot, "install");
    fs.writeFileSync(artifact, "same version, altered wheel digest\n", "utf8");
    try {
      const result = spawnSync(
        "python3",
        [
          "-m",
          "pip",
          "install",
          "--target",
          installTarget,
          "--no-deps",
          "--no-index",
          "--find-links",
          temporaryRoot,
          "--require-hashes",
          "-r",
          hindsightProbeRequirementsPath,
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("DO NOT MATCH THE HASHES");
      expect(fs.existsSync(path.join(installTarget, "hindsight_client"))).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
