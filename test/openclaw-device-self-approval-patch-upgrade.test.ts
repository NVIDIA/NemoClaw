// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runPatch, writeFixtureDist } from "./helpers/openclaw-device-self-approval-patch-harness";

describe("OpenClaw device self-approval patch upgrades (#4462)", () => {
  it("adds pairing-only stored auth to an earlier patched settlement list (#9844)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-list-upgrade-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const file = path.join(dist, "devices-cli.runtime-fixture.js");
      const current = [
        "async function listPairingWithFallback(opts, callOpts) { // nemoclaw: preflight bounded stored device auth before live pairing list (#4462)",
        '\tconst nemoclawSettlementListCallOpts = process.env.NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT === "1" ? {',
        "\t\tscopes: [PAIRING_SCOPE],",
        "\t\tuseStoredDeviceAuth: true,",
        "\t\trequiredStoredDeviceAuthScopes: [PAIRING_SCOPE]",
        "\t} : void 0; // nemoclaw: use stored device auth for pairing settlement list (#9844)",
        "\tcallOpts ??= nemoclawSettlementListCallOpts;",
      ].join("\n");
      const legacy = current.split("\n")[0] as string;
      const source = fs.readFileSync(file, "utf8");
      expect(source).toContain(current);
      fs.writeFileSync(file, source.replace(current, legacy));

      expect(runPatch(dist).status).toBe(0);
      expect(fs.readFileSync(file, "utf8")).toContain(current);
      expect(runPatch(dist).status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("migrates the restored-clone mode from the force flag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-clone-mode-upgrade-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const legacyReplacements = new Map([
        [
          "call-fixture.js",
          [
            [
              '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1" || process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") return false;',
              '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return false;',
            ],
            [
              '\tif (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") {',
              '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") {',
            ],
          ],
        ],
        [
          "device-identity-fixture.js",
          [
            [
              '\tif (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") return loadNemoClawForcedDeviceIdentity();',
              '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return loadNemoClawForcedDeviceIdentity();',
            ],
          ],
        ],
        [
          "devices-cli.runtime-fixture.js",
          [
            [
              '\tconst nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";',
              '\tconst nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1";',
            ],
          ],
        ],
      ]);
      [...legacyReplacements].forEach(([name, replacements]) => {
        const file = path.join(dist, name);
        let source = fs.readFileSync(file, "utf8");
        for (const [current, legacy] of replacements) {
          expect(source).toContain(current);
          source = source.replace(current, legacy);
        }
        fs.writeFileSync(file, source);
      });

      expect(runPatch(dist).status).toBe(0);

      const callSource = fs.readFileSync(path.join(dist, "call-fixture.js"), "utf8");
      expect(callSource).toContain(
        'process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1" || process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1"',
      );
      expect(callSource).toContain(
        'if (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") {',
      );
      expect(fs.readFileSync(path.join(dist, "device-identity-fixture.js"), "utf8")).toContain(
        'if (process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1") return loadNemoClawForcedDeviceIdentity();',
      );
      expect(fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8")).toContain(
        'const nemoclawPairedTokenRequested = process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
