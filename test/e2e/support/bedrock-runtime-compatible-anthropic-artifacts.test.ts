// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  projectRawOutputForArtifact,
  summarizeSandboxSnapshot,
} from "../live/bedrock-runtime-compatible-anthropic-artifacts.ts";

describe("Bedrock Runtime snapshot artifact projection", () => {
  it("keeps unknown sandbox-generated secrets out of published output", () => {
    const generatedToken = "unknown-generated-device-token";
    const generatedPrivateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "unknown-generated-private-key-material",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\\n");
    const raw = [
      "@@NEMOCLAW_E2E_FILE@@ /sandbox/.openclaw/identity/device.json",
      JSON.stringify({ generatedToken, generatedPrivateKey }),
    ].join("\n");

    const projected = projectRawOutputForArtifact(raw, "stdout", "metadata-only");
    const metadata = JSON.parse(projected) as Record<string, unknown>;

    expect(metadata).toEqual({
      stream: "stdout",
      capturedBytes: Buffer.byteLength(raw, "utf8"),
      capturedLines: 2,
      content: "omitted: inspected in memory only",
    });
    expect(projected).not.toContain(generatedToken);
    expect(projected).not.toContain(generatedPrivateKey);
    expect(projected).not.toContain("PRIVATE KEY");
  });

  it("summarizes the in-memory scan without retaining file contents", () => {
    const raw = [
      "@@NEMOCLAW_E2E_FILE@@ /sandbox/one.json",
      "first-sensitive-value",
      "@@NEMOCLAW_E2E_FILE@@ /tmp/two.env",
      "second-sensitive-value",
    ].join("\n");

    expect(summarizeSandboxSnapshot(raw)).toEqual({
      capturedBytes: Buffer.byteLength(raw, "utf8"),
      capturedFiles: 2,
      capturedLines: 4,
    });
  });
});
