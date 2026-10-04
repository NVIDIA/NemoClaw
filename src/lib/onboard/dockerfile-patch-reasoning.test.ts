// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

describe("Dockerfile reasoning capability patch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reasoning-patch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("uses validated reasoning state instead of drifted ambient env (#7570)", () => {
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_REASONING=false\n", "utf8");
    vi.stubEnv("NEMOCLAW_REASONING", "false");

    patchStagedDockerfile(
      dockerfilePath,
      "nemotron-3-super",
      "https://chat.example",
      "build-1",
      "compatible-endpoint",
      "openai-completions",
      null,
      null,
      false,
      null,
      [],
      { compatibleEndpointReasoning: "true" },
    );

    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ARG NEMOCLAW_REASONING=true");
    expect(dockerfile).not.toContain("ARG NEMOCLAW_REASONING=false");
  });
});
