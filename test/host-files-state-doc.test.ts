// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation gate for the unified host-side state reference (#6088).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

const doc = readFileSync(path.join(repoRoot, "docs/reference/host-files-and-state.mdx"), "utf8");
const nav = readFileSync(path.join(repoRoot, "docs/index.yml"), "utf8");

describe("Host files and state documentation (#6088)", () => {
  it("is listed in both OpenClaw and Hermes reference navigation", () => {
    const matches = nav.match(/path: reference\/host-files-and-state\.mdx/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("covers the host-side files and directories called out by the issue", () => {
    for (const entry of [
      "~/.nemoclaw/sandboxes.json",
      "~/.nemoclaw/rebuild-backups/<sandbox>/",
      "~/.nemoclaw/backups/<timestamp>/",
      "~/.nemoclaw/onboard-session.json",
      "~/.nemoclaw/onboard.lock",
      "~/.nemoclaw/ollama-proxy-token",
      "~/.nemoclaw/credentials.json",
      "~/.nemoclaw/mounts/<sandbox>/",
    ]) {
      expect(doc).toContain(entry);
    }
  });

  it("clarifies registry.json is not the current persisted registry filename", () => {
    expect(doc).toContain("There is no current `~/.nemoclaw/registry.json` file");
    expect(doc).toContain("the persisted filename is `sandboxes.json`");
  });

  it("separates host state from sandbox-side config.json", () => {
    expect(doc).toContain("Do not confuse host `~/.nemoclaw/`");
    expect(doc).toContain("/sandbox/.nemoclaw/config.json");
    expect(doc).toContain("`HOME=/sandbox`");
    expect(doc).toContain("not a host-side `~/.nemoclaw/config.json`");
  });
});
