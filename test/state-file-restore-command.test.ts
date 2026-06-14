// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "dist", "lib", "state", "sandbox.js")).href
)) as typeof import("../dist/lib/state/sandbox.js");

const spec = { path: "openclaw.json", strategy: "copy" } as const;

describe("buildStateFileRestoreCommand (#5202)", () => {
  it("refreshes the OpenClaw .last-good anchor before swapping the live config", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, true);

    // The anchor write targets openclaw.json.last-good and rejects symlinks.
    expect(cmd).toContain('last_good="${dst}.last-good"');
    expect(cmd).toContain("refusing symlinked last-good target");

    // The anchor is staged through a temp and installed via atomic rename, and
    // fails closed (exit 14) so a partial write never reaches .last-good.
    expect(cmd).toContain(".nemoclaw-lastgood.XXXXXX");
    expect(cmd).toContain('mv -f "$anchor_tmp" "$last_good"');
    expect(cmd).toContain("exit 14");

    // Anchor must be installed BEFORE the live file is swapped, so OpenClaw's
    // integrity watcher never observes a config that disagrees with .last-good.
    const anchorIdx = cmd.indexOf('mv -f "$anchor_tmp" "$last_good"');
    const swapIdx = cmd.indexOf('mv -f "$tmp" "$dst"');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(anchorIdx);

    // The .config-hash is still refreshed after the swap.
    expect(cmd).toContain("sha256sum");
  });

  it("does not touch the .last-good anchor for non-OpenClaw state restores", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, false);
    expect(cmd).not.toContain("last-good");
    expect(cmd).not.toContain("sha256sum");
    expect(cmd).toContain('mv -f "$tmp" "$dst"');
  });
});
