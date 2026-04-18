// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");
const BASE_DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile.base");

describe("OpenClaw config layout (#719)", () => {
  it("promotes OPENCLAW_CONFIG_PATH into the image environment", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");

    expect(src).toMatch(/OPENCLAW_STATE_DIR=\/sandbox\/\.openclaw/);
    expect(src).toMatch(/OPENCLAW_CONFIG_PATH=\/sandbox\/\.openclaw-data\/config\/openclaw\.json/);
  });

  it("creates the openclaw.json wrapper symlink in both Dockerfiles", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const baseDockerfile = fs.readFileSync(BASE_DOCKERFILE, "utf-8");

    expect(dockerfile).toMatch(/os\.symlink\(config_path, wrapper_path\)/);
    expect(baseDockerfile).toContain(
      "ln -s /sandbox/.openclaw-data/config/openclaw.json /sandbox/.openclaw/openclaw.json",
    );
  });

  it("shares the live config directory between sandbox and gateway", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");

    expect(src).toContain(
      "chown sandbox:gateway /sandbox/.openclaw-data/config /sandbox/.openclaw-data/config/openclaw.json",
    );
    expect(src).toContain("chmod 2775 /sandbox/.openclaw-data/config");
    expect(src).toContain("chmod 664 /sandbox/.openclaw-data/config/openclaw.json");
  });
});
