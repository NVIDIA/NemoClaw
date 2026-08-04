// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
const imageProbePath = "/opt/nemoclaw-hermes-config/image-build-probes.py";
const commands = [
  "cron-backup",
  "cron-create",
  "cron-reopen",
  "cron-runtime-source",
  "dashboard-policy",
  "discord-backup",
  "discord-create",
  "discord-recovery-source",
  "discord-reopen",
  "gateway-process-identity",
  "gateway-runtime-metadata",
  "langfuse-credentials",
  "neutral-platform-inertness",
  "profile-policy",
  "session-preview",
] as const;

describe("Hermes image build probes", () => {
  it("uses a checked-in probe runner instead of builder-dependent heredocs (#7981)", () => {
    expect(dockerfile).not.toMatch(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/u);
    expect(dockerfile).toContain(`COPY agents/hermes/image-build-probes.py ${imageProbePath}`);
    const normalizedDockerfile = dockerfile.replace(/\\\n/gu, "").replace(/\s+/gu, " ");

    for (const command of commands) {
      expect(normalizedDockerfile).toContain(`${imageProbePath} ${command}`);
    }

    const removal = dockerfile.indexOf(`rm -f ${imageProbePath}`);
    expect(removal).toBeGreaterThan(dockerfile.indexOf(`${imageProbePath} discord-reopen`));
    expect(dockerfile.indexOf(`check_absent ${imageProbePath}`)).toBeGreaterThan(removal);
  });

  it("lists every Dockerfile probe command in the runner usage", () => {
    const result = spawnSync("python3", ["-I", probes], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    for (const command of commands) {
      expect(result.stderr).toContain(command);
    }
  });
});
