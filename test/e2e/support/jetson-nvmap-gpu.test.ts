// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const liveTestSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "live", "jetson-nvmap-gpu.test.ts"),
  "utf8",
);

describe("Jetson CPU-only inference fixture", () => {
  it("keeps onboarding independent of the persistent host Ollama version (#9157)", () => {
    expect(liveTestSource).toContain("startFakeOpenAiCompatibleServer");
    expect(liveTestSource).toContain('NEMOCLAW_PROVIDER: "custom"');
    expect(liveTestSource).toContain("NEMOCLAW_ENDPOINT_URL:");
    expect(liveTestSource).toContain("COMPATIBLE_API_KEY:");
    expect(liveTestSource).not.toContain(
      'NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER ?? "ollama"',
    );
    expect(liveTestSource).not.toContain('"command -v ollama && ollama list"');
  });
});
