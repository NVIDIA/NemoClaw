// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(repoRoot, "scripts/checks/validate-managed-base-index.sh");
const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const indexDigest = `sha256:${"c".repeat(64)}`;

function index(amd64: string, arm64: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    manifests: [
      { digest: amd64, platform: { architecture: "amd64", os: "linux" } },
      { digest: arm64, platform: { architecture: "arm64", os: "linux" } },
    ],
  });
}

describe("managed base index validation", () => {
  it("rejects a retagged index whose platform descriptors came from another run", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-index-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const rawIndex = path.join(temporaryRoot, "index.json");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
test "\${1:-} \${2:-} \${3:-} \${5:-}" = "buildx imagetools inspect --raw"
cat "$RAW_INDEX"
`,
      { mode: 0o755 },
    );

    const run = () =>
      spawnSync(
        validator,
        [`ghcr.io/nvidia/nemoclaw/base@${indexDigest}`, amd64Digest, arm64Digest],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            RAW_INDEX: rawIndex,
          },
        },
      );

    try {
      fs.writeFileSync(rawIndex, index(amd64Digest, arm64Digest));
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);

      fs.writeFileSync(rawIndex, index(`sha256:${"d".repeat(64)}`, arm64Digest));
      const retagged = run();
      expect(retagged.status).not.toBe(0);
      expect(retagged.stderr).toContain(
        "linux/amd64 descriptor does not match this run's platform digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
