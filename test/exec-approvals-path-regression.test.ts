// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("exec approvals path regression guard", () => {
  it("Dockerfile.base installs OpenClaw and validates version against blueprint minimum", () => {
    const dockerfileBase = path.join(import.meta.dirname, "..", "Dockerfile.base");
    const src = fs.readFileSync(dockerfileBase, "utf-8");

    expect(src).toContain("OPENCLAW_VERSION");
    expect(src).toContain("min_openclaw_version");
    expect(src).toContain('npm install -g "openclaw@${OPENCLAW_VERSION}"');
  });

  it("Dockerfile flattens legacy .openclaw-data and startup restores mutable-default permissions", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const startScript = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
    const src = fs.readFileSync(dockerfile, "utf-8");
    const startSrc = fs.readFileSync(startScript, "utf-8");

    expect(src).toContain("config_dir=/sandbox/.openclaw");
    expect(src).toContain("data_dir=/sandbox/.openclaw-data");
    expect(src).toContain('mkdir -p "$config_dir"');
    expect(src).toContain(
      'touch "$config_dir/update-check.json" "$config_dir/exec-approvals.json"',
    );
    expect(src).toContain('if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then');
    expect(src).toContain("ERROR: legacy data dir still exists after cleanup");
    expect(src).toContain("ERROR: legacy symlink remains after cleanup");
    expect(src).toContain("chown -R sandbox:sandbox /sandbox/.openclaw");
    expect(src).toContain("chmod 755 /sandbox/.openclaw");
    expect(src).toContain("chmod 644 /sandbox/.openclaw/openclaw.json");

    expect(startSrc).toContain('chmod 700 "$openclaw_dir"');
    expect(startSrc).toContain(
      'chmod 600 "$openclaw_dir/openclaw.json" "$openclaw_dir/.config-hash"',
    );
  });
});
