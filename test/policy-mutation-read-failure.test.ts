// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const policies = requireForTest(
  path.join(import.meta.dirname, "..", "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");
const CUSTOM_PRESET = "network_policies:\n  example:\n    host: example.com\n";

describe("OpenShell policy mutation read failures", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const [mutation, apply] of [
    ["applyPresetContent", () => policies.applyPresetContent("alpha", "custom", CUSTOM_PRESET)],
    ["applyPresets", () => policies.applyPresets("alpha", ["npm"])],
  ] as const) {
    it(`${mutation} refuses to set policy when the base-policy read fails`, () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-read-failure-"));
      tempDirs.push(tempDir);
      const callsPath = path.join(tempDir, "calls.log");
      const fakeOpenshell = path.join(tempDir, "openshell");
      fs.writeFileSync(
        fakeOpenshell,
        ["#!/bin/sh", `printf '%s\\n' "$*" >>${JSON.stringify(callsPath)}`, "exit 42"].join("\n"),
        { mode: 0o755 },
      );
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(apply()).toBe(false);
      const calls = fs.readFileSync(callsPath, "utf-8").trim().split("\n");
      expect(calls).toEqual(["policy get --base alpha"]);
      expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("refusing to apply"));
    });
  }
});
