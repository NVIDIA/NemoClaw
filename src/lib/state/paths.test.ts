// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ROOT, resolveNemoclawHomeDir, resolveNemoclawStateDir, SCRIPTS } from "./paths";

describe("paths", () => {
  it("resolves the repo root", () => {
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(ROOT, "bin", "nemoclaw.js"))).toBe(true);
  });

  it("resolves the scripts directory from the repo root", () => {
    expect(SCRIPTS).toBe(join(ROOT, "scripts"));
    expect(existsSync(join(SCRIPTS, "debug.sh"))).toBe(true);
  });

  it("isolates default state during Vitest without changing explicit home resolution", () => {
    const isolatedState = process.env.NEMOCLAW_TEST_STATE_DIR;

    expect(isolatedState).toBeDefined();
    expect(resolveNemoclawStateDir()).toBe(isolatedState);
    expect(resolveNemoclawStateDir("/explicit-home")).toBe(
      join("/explicit-home", ".nemoclaw", "state"),
    );
  });

  it("honors a test fixture that explicitly changes HOME", () => {
    vi.stubEnv("HOME", "/fixture-home");

    expect(resolveNemoclawStateDir()).toBe(join("/fixture-home", ".nemoclaw", "state"));
  });

  it("does not honor the internal state override outside Vitest", () => {
    vi.stubEnv("VITEST", "false");

    expect(resolveNemoclawStateDir()).toBe(join(resolveNemoclawHomeDir(), "state"));
  });
});
