// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runHermesPortableUninstallOpenShell,
  type HermesPortableUninstallOpenShellSpawn,
} from "./hermes-portable-uninstall";

describe("Hermes Portable uninstall OpenShell adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("captures one authority-bound command without interpreting its exit (#9608)", () => {
    const error = new Error("timed out");
    const spawn = vi.fn(() => ({
      pid: 7,
      output: [null, "provider output", "provider error"],
      stdout: "provider output",
      stderr: "provider error",
      status: 3,
      signal: null,
      error,
    })) as unknown as HermesPortableUninstallOpenShellSpawn;
    const env = { HOME: "/private/home", PATH: "/usr/bin" };

    expect(
      runHermesPortableUninstallOpenShell(
        "/verified/openshell",
        ["provider", "delete", "portable-ollama"],
        env,
        12_345,
        spawn,
      ),
    ).toEqual({
      status: 3,
      stdout: "provider output",
      stderr: "provider error",
      error,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/verified/openshell",
      ["provider", "delete", "portable-ollama"],
      {
        encoding: "utf8",
        env,
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 12_345,
      },
    );
  });
});
