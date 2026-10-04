// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../../..");
const troubleshootingPath = path.join(repoRoot, "docs", "reference", "troubleshooting.mdx");

function managedSparkMemorySection(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf8");
  const start = markdown.indexOf(
    "### Host freezes or logs `NVRM NV_ERR_NO_MEMORY` under local vLLM load",
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const section = markdown.slice(start);
  const end = section.indexOf("\n### CoreDNS CrashLoop after onboarding");
  expect(end).toBeGreaterThanOrEqual(0);
  return section.slice(0, end);
}

describe("managed vLLM troubleshooting documentation", () => {
  it("derives the managed host port and uses the authentication-independent health route (#684)", () => {
    const section = managedSparkMemorySection();

    expect(section).toContain("docker port nemoclaw-vllm 8000/tcp");
    expect(section).toContain("sort -u");
    expect(section).toContain("${NEMOCLAW_VLLM_PORT:?Set NEMOCLAW_VLLM_PORT");
    expect(section).toContain("http://127.0.0.1:${VLLM_HOST_PORT}/health");
    expect(section).not.toContain("${NEMOCLAW_VLLM_PORT:-8000}");
    expect(section).not.toMatch(/curl[^\n]*\/v1\/models/u);
  });
});
