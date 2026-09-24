// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PI_SETTINGS_OWNERSHIP, runJsonMerge } from "./state-file-key-merge-test-fixture";
import { buildKeyAllowlistMergeRestoreCommand } from "./state-file-key-merge";

describe("JSON key-allowlist state-file merge", () => {
  it("uses Pi's system Python and permits an absent fresh settings file", () => {
    const command = buildKeyAllowlistMergeRestoreCommand(
      "/sandbox/.pi/agent",
      { path: "settings.json" },
      PI_SETTINGS_OWNERSHIP,
    );

    expect(command).toContain("/usr/bin/python3 -I -c");
    expect(command).not.toContain("/opt/venv/bin/python3");
    expect(command).toContain('[ ! -e "$dst" ]');
    expect(command).toContain('[ ! -L "$dst" ]');
  });

  it("creates a missing private settings file from allowlisted backup keys only", () => {
    const result = runJsonMerge(
      { theme: "nvidia-dark", quietStartup: true, unowned: "drop-me" },
      null,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.current).toEqual({ quietStartup: true, theme: "nvidia-dark" });
    expect(result.mode).toBe(0o600);
  });

  it("preserves fresh managed JSON while restoring an allowlisted user preference", () => {
    const result = runJsonMerge(
      { theme: "nvidia-dark", unowned: "drop-me" },
      { managed: { route: "fresh" }, theme: "light" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.current).toEqual({ managed: { route: "fresh" }, theme: "nvidia-dark" });
    expect(result.mode).toBe(0o600);
  });

  it("still requires a fresh file when the ownership declares managed fresh data", () => {
    const result = runJsonMerge({ theme: "nvidia-dark" }, null, {
      ...PI_SETTINGS_OWNERSHIP,
      requireFreshTables: ["managed"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("current config is missing or unsafe");
    expect(result.current).toBeNull();
  });
});
