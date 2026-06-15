// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression: docs/manage-sandboxes/runtime-controls.mdx told users the OpenClaw
// "runtime source of truth inside the sandbox" was /opt/nemoclaw/openclaw.json,
// but that directory holds the NemoClaw plugin (installed via
// `openclaw plugins install /opt/nemoclaw`), not the config. OpenClaw reads its
// config from /sandbox/.openclaw/openclaw.json — the path the Dockerfile writes
// and that src/lib/channel-runtime-status.ts calls "the same file OpenClaw
// parses at startup." The Hermes sibling row already used the correct
// /sandbox/.hermes paths.
const REPO_ROOT = path.dirname(import.meta.dirname);
const DOC = path.join(REPO_ROOT, "docs", "manage-sandboxes", "runtime-controls.mdx");
const text = fs.readFileSync(DOC, "utf-8");

describe("runtime-controls.mdx in-sandbox config path", () => {
  it("points OpenClaw at the real in-sandbox config path", () => {
    expect(text).not.toMatch(/\/opt\/nemoclaw\/openclaw\.json/);
    expect(text).toContain("/sandbox/.openclaw/openclaw.json");
  });

  it("keeps the correct Hermes runtime source-of-truth paths", () => {
    expect(text).toContain("/sandbox/.hermes/config.yaml");
    expect(text).toContain("/sandbox/.hermes/.env");
  });
});
