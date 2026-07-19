// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const policies = requireForTest(
  path.join(import.meta.dirname, "..", "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

const hasScopeHeader = (m: unknown): m is string =>
  typeof m === "string" && m.includes("Effective egress that would be opened");

const LIVE_NPM_POLICY = [
  "version: 1",
  "network_policies:",
  "  npm_yarn:",
  "    name: npm_yarn",
  "    endpoints:",
  "      - host: registry.npmjs.org",
  "        port: 443",
  "        access: full",
  "        tls: skip",
  "      - host: registry.yarnpkg.com",
  "        port: 443",
  "        access: full",
  "        tls: skip",
  "    binaries:",
  "      - { path: /usr/local/bin/npm* }",
  "      - { path: /usr/local/bin/npx* }",
  "      - { path: /usr/local/bin/node* }",
  "      - { path: /usr/local/bin/yarn* }",
  "      - { path: /usr/bin/npm* }",
  "      - { path: /usr/bin/node* }",
  "",
].join("\n");

describe("preset egress disclosure does not claim new egress for a no-op (#7179)", () => {
  it("applyPreset does not claim new egress when the preset already matches the live policy", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-noop-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    fs.writeFileSync(
      fakeOpenshell,
      `#!/bin/sh\ncat <<'POLICY_EOF'\n${LIVE_NPM_POLICY}POLICY_EOF\nexit 0\n`,
      { mode: 0o755 },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
    try {
      try {
        policies.applyPreset("test-sandbox", "npm");
      } catch {
        /* applyPreset may throw if sandbox not running — we only care about the log */
      }
      const messages = logSpy.mock.calls.map((call) =>
        typeof call[0] === "string" ? call[0] : undefined,
      );
      expect(messages.some(hasScopeHeader)).toBe(false);
      expect(
        messages.some((m) => m?.includes("already matches the sandbox's live network policy")),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("mergePresetNamesIntoPolicy discloses effective egress for a newly merged preset before onboarding creates the sandbox", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const current = "version: 1\n\nnetwork_policies: {}\n";

      policies.mergePresetNamesIntoPolicy(current, ["npm"]);

      const messages = logSpy.mock.calls.map((call) =>
        typeof call[0] === "string" ? call[0] : undefined,
      );
      expect(messages.some(hasScopeHeader)).toBe(true);
      expect(messages.some((m) => m?.includes("registry.npmjs.org"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("mergePresetNamesIntoPolicy does not claim new egress when the named preset already matches the current policy", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      policies.mergePresetNamesIntoPolicy(LIVE_NPM_POLICY, ["npm"]);

      const messages = logSpy.mock.calls.map((call) =>
        typeof call[0] === "string" ? call[0] : undefined,
      );
      expect(messages.some(hasScopeHeader)).toBe(false);
      expect(
        messages.some((m) => m?.includes("already matches the sandbox's live network policy")),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
