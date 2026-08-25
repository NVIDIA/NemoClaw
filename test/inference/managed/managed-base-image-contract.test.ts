// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const exporter = path.join(repoRoot, "scripts", "export-managed-base-image-contract.sh");
const sourceRevision = "c".repeat(40);
const digest = `sha256:${"d".repeat(64)}`;
const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const agents = [
  {
    agent: "openclaw",
    image: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  },
  {
    agent: "hermes",
    image: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
  },
  {
    agent: "langchain-deepagents-code",
    image: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
  },
] as const;

function exportContract(output: string, agent: string, image: string, amd64 = amd64Digest) {
  return spawnSync(
    exporter,
    [agent, image, digest, amd64, arm64Digest, sourceRevision, "42", "3", output],
    { encoding: "utf8" },
  );
}

describe("managed base image contract exporter", () => {
  it.each(agents)(
    "binds both native platform digests for every managed agent [case %#] (#7744)",
    ({ agent, image }) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-contract-"));

      try {
        const output = path.join(temporaryRoot, agent, "contract.json");
        const result = exportContract(output, agent, image);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
          contractVersion: 1,
          agent,
          image,
          digest,
          reference: `${image}@${digest}`,
          platforms: ["linux/amd64", "linux/arm64"],
          platformDigests: {
            "linux/amd64": amd64Digest,
            "linux/arm64": arm64Digest,
          },
          platformReferences: {
            "linux/amd64": `${image}@${amd64Digest}`,
            "linux/arm64": `${image}@${arm64Digest}`,
          },
          sourceRevision,
          run: { id: 42, attempt: 3 },
        });
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects a platform digest that is not a full SHA-256 value (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-contract-"));

    try {
      const output = path.join(temporaryRoot, "contract.json");
      const result = exportContract(
        output,
        "openclaw",
        "ghcr.io/nvidia/nemoclaw/sandbox-base",
        "sha256:bad",
      );

      expect(result.status).not.toBe(0);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
