// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const resolver = path.join(repoRoot, "scripts/checks/resolve-managed-pr-base.sh");

describe("managed-image PR base resolution", () => {
  it("pins one native-platform descriptor and rejects torn index evidence", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const aliasRaw = path.join(temporaryRoot, "alias.raw");
    const exactRaw = path.join(temporaryRoot, "exact.raw");
    const arm64ExactRaw = path.join(temporaryRoot, "arm64-exact.raw");
    const output = path.join(temporaryRoot, "output");
    const summary = path.join(temporaryRoot, "summary");
    fs.mkdirSync(fakeBin);
    const exactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"a".repeat(64)}`, size: 1 },
      layers: [],
    });
    const digest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const arm64ExactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"b".repeat(64)}`, size: 1 },
      layers: [],
    });
    const arm64Digest = `sha256:${createHash("sha256").update(arm64ExactBody).digest("hex")}`;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: exactBody.length,
      platform: { os: "linux", architecture: "amd64" },
    };
    const arm64Descriptor = {
      ...descriptor,
      digest: arm64Digest,
      size: arm64ExactBody.length,
      platform: { os: "linux", architecture: "arm64" },
    };
    const writeAlias = (manifests: unknown[]) => {
      fs.writeFileSync(
        aliasRaw,
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests,
        }),
      );
    };
    writeAlias([descriptor, arm64Descriptor]);
    fs.writeFileSync(exactRaw, exactBody);
    fs.writeFileSync(arm64ExactRaw, arm64ExactBody);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-} \${2:-} \${3:-}" != "buildx imagetools inspect" ]; then
  exit 90
fi
if [[ "\${4:-}" == *":latest" ]]; then
  cat "$ALIAS_RAW"
elif [[ "\${4:-}" == *"@$ARM64_DIGEST" ]]; then
  cat "$ARM64_EXACT_RAW"
else
  cat "$EXACT_RAW"
fi
`,
      { mode: 0o755 },
    );
    const runResolver = (platform = "linux/amd64") =>
      spawnSync("bash", [resolver], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT: "openclaw",
          ALIAS_RAW: aliasRaw,
          ARM64_DIGEST: arm64Digest,
          ARM64_EXACT_RAW: arm64ExactRaw,
          BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          BASE_DOCKERFILE: "Dockerfile.base",
          BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          BASE_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).stdout.trim(),
          CANDIDATE_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).stdout.trim(),
          DISPLAY_NAME: "OpenClaw",
          EXACT_RAW: exactRaw,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/openclaw-base:test",
          PLATFORM: platform,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      const accepted = runResolver();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
      );

      const acceptedArm64 = runResolver("linux/arm64");
      expect(acceptedArm64.status, acceptedArm64.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${arm64Digest}`,
      );

      writeAlias([descriptor, descriptor, arm64Descriptor]);
      const duplicate = runResolver();
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("does not contain exactly one linux/amd64 image");

      writeAlias([descriptor, arm64Descriptor]);
      fs.appendFileSync(exactRaw, " ");
      const wrongBody = runResolver();
      expect(wrongBody.status).not.toBe(0);
      expect(wrongBody.stderr).toContain(
        "exact PR base bytes do not match the selected descriptor digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
