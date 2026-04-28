// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("exec approvals path regression guard", () => {
  it("Dockerfile.base patches and validates OpenClaw exec approvals path across dist bundles", () => {
    const dockerfileBase = path.join(import.meta.dirname, "..", "Dockerfile.base");
    const src = fs.readFileSync(dockerfileBase, "utf-8");

    expect(src).toContain("LEGACY_EXEC_APPROVALS_PATH=\"$(printf '%b'");
    expect(src).toContain("DATA_EXEC_APPROVALS_PATH=\"$(printf '%b'");
    expect(src).toContain('files_with_old_path_file="$(mktemp)"');
    expect(src).toContain("--include='*.js'");
    expect(src).toContain("OpenClaw dist directory not found:");
    expect(src).toContain("Unable to verify OpenClaw exec approvals path in dist");
  });

  it("Dockerfile applies a runtime compatibility patch for stale base images", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain('[ ! -d "$OPENCLAW_DIST_DIR" ]');
    expect(src).toContain("mkdir -p /sandbox/.openclaw-data");
    expect(src).toContain("chown sandbox:sandbox /sandbox/.openclaw-data");
    expect(src).toContain("chmod 755 /sandbox/.openclaw-data");
    expect(src).toContain("LEGACY_EXEC_APPROVALS_PATH=\"$(printf '%b'");
    expect(src).toContain("DATA_EXEC_APPROVALS_PATH=\"$(printf '%b'");
    expect(src).toContain('files_with_old_path_file="$(mktemp)"');
    expect(src).toContain("--include='*.js'");
    expect(src).toContain("Unable to verify OpenClaw exec approvals path in dist");
    expect(src).toContain("OpenClaw dist directory not found:");
    expect(src).toContain("OpenClaw exec approvals path patch failed");
  });
});
