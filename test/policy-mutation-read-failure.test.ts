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
const MALFORMED_BASE_POLICIES = [
  ["network_policies string", "version: 1\nnetwork_policies: invalid\n"],
  ["network_policies sequence", "version: 1\nnetwork_policies: []\n"],
  ["network_policies null", "version: 1\nnetwork_policies: null\n"],
  ["string version", 'version: "1"\nnetwork_policies: {}\n'],
  ["fractional version", "version: 1.5\nnetwork_policies: {}\n"],
] as const;
const UNMARKED_NON_POLICY_MAPPINGS = [
  ["message diagnostic", "message: gateway unavailable\n"],
  ["details diagnostic", "details: connection refused\n"],
  ["arbitrary diagnostic", "reason: gateway unavailable\nretryable: true\n"],
] as const;

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

    for (const [outputName, emitOutput] of [
      ["empty", ":"],
      ["whitespace-only", "printf '   \\n'"],
    ] as const) {
      it(`${mutation} refuses to set policy when the successful base-policy read is ${outputName}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-empty-read-"));
        tempDirs.push(tempDir);
        const callsPath = path.join(tempDir, "calls.log");
        const fakeOpenshell = path.join(tempDir, "openshell");
        fs.writeFileSync(
          fakeOpenshell,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >>${JSON.stringify(callsPath)}`,
            emitOutput,
            "exit 0",
          ].join("\n"),
          { mode: 0o755 },
        );
        vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
        const policyTempPrefix = path.join(os.tmpdir(), "nemoclaw-policy-");
        const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(apply()).toBe(false);
        const calls = fs.readFileSync(callsPath, "utf-8").trim().split("\n");
        expect(calls).toEqual(["policy get --base alpha"]);
        expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
        expect(
          mkdtempSpy.mock.calls.filter(([prefix]) => String(prefix).startsWith(policyTempPrefix)),
        ).toEqual([]);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("refusing to apply"));
      });
    }

    for (const [shapeName, policyOutput] of MALFORMED_BASE_POLICIES) {
      it(`${mutation} refuses to set policy when the base-policy read has ${shapeName}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-malformed-read-"));
        tempDirs.push(tempDir);
        const callsPath = path.join(tempDir, "calls.log");
        const outputPath = path.join(tempDir, "policy-output.yaml");
        const fakeOpenshell = path.join(tempDir, "openshell");
        fs.writeFileSync(outputPath, policyOutput);
        fs.writeFileSync(
          fakeOpenshell,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >>${JSON.stringify(callsPath)}`,
            `cat ${JSON.stringify(outputPath)}`,
          ].join("\n"),
          { mode: 0o755 },
        );
        vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
        const policyTempPrefix = path.join(os.tmpdir(), "nemoclaw-policy-");
        const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(apply()).toBe(false);
        const calls = fs.readFileSync(callsPath, "utf-8").trim().split("\n");
        expect(calls).toEqual(["policy get --base alpha"]);
        expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
        expect(
          mkdtempSpy.mock.calls.filter(([prefix]) => String(prefix).startsWith(policyTempPrefix)),
        ).toEqual([]);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("refusing to apply"));
      });
    }

    for (const [shapeName, policyOutput] of UNMARKED_NON_POLICY_MAPPINGS) {
      it(`${mutation} refuses to set policy when the successful base-policy read is an unmarked ${shapeName}`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-diagnostic-read-"));
        tempDirs.push(tempDir);
        const callsPath = path.join(tempDir, "calls.log");
        const outputPath = path.join(tempDir, "policy-output.yaml");
        const fakeOpenshell = path.join(tempDir, "openshell");
        fs.writeFileSync(outputPath, policyOutput);
        fs.writeFileSync(
          fakeOpenshell,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >>${JSON.stringify(callsPath)}`,
            `cat ${JSON.stringify(outputPath)}`,
          ].join("\n"),
          { mode: 0o755 },
        );
        vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
        const policyTempPrefix = path.join(os.tmpdir(), "nemoclaw-policy-");
        const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(apply()).toBe(false);
        const calls = fs.readFileSync(callsPath, "utf-8").trim().split("\n");
        expect(calls).toEqual(["policy get --base alpha"]);
        expect(calls.some((call) => call.startsWith("policy set "))).toBe(false);
        expect(
          mkdtempSpy.mock.calls.filter(([prefix]) => String(prefix).startsWith(policyTempPrefix)),
        ).toEqual([]);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("refusing to apply"));
      });
    }
  }
});
