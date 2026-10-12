// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-authority-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeSandboxRegistry(sandboxName: string, agent: "hermes" | null = null): void {
  const stateRoot = path.join(TMP_HOME, ".nemoclaw");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent,
        },
      },
    }),
  );
}

describe("complete native-home machine authority", () => {
  it.each([16, 100, 2000])(
    "backs up growing Hermes configuration with %i settings without changing live state (#13044)",
    (count) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-growing-config-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const settings = Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`setting${index}`, "on"]),
        );
        const source = `${Object.keys(settings)
          .map((key) => `${key}: on\n`)
          .join("")}api_key: private-fixture-value\n`;
        // Even removing the credential field cannot make compact JSON fit the YAML member.
        expect(Buffer.byteLength(JSON.stringify(settings))).toBeGreaterThan(
          Buffer.byteLength(source),
        );
        const configPath = ".hermes/config.yaml";
        const savedConfigPath = ".hermes/backups/config/config.yml.saved";
        fs.mkdirSync(path.dirname(path.join(nativeRoot, savedConfigPath)), { recursive: true });
        fs.writeFileSync(path.join(nativeRoot, configPath), source);
        fs.writeFileSync(path.join(nativeRoot, savedConfigPath), source);
        const trailing = Buffer.alloc(1024 * 1024 + 513, 0x61);
        fs.writeFileSync(path.join(nativeRoot, "workspace.txt"), trailing);
        writeSandboxRegistry("alpha", "hermes");

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        });

        expect(backup.success, backup.error).toBe(true);
        expect(
          fs
            .readFileSync(path.join(backup.manifest!.backupPath, "native-home.tar"))
            .includes("private-fixture-value"),
        ).toBe(false);
        sandboxState.inspectNativeSandboxState(backup.manifest!.backupPath, (root: string) => {
          const expected = { ...settings, api_key: "[STRIPPED_BY_MIGRATION]" };
          expect(parseYaml(fs.readFileSync(path.join(root, configPath), "utf8"))).toEqual(expected);
          expect(parseYaml(fs.readFileSync(path.join(root, savedConfigPath), "utf8"))).toEqual(
            expected,
          );
          expect(fs.readFileSync(path.join(root, "workspace.txt"))).toEqual(trailing);
        });
        expect(fs.readFileSync(path.join(nativeRoot, configPath), "utf8")).toBe(source);
        expect(fs.readFileSync(path.join(nativeRoot, savedConfigPath), "utf8")).toBe(source);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each([".openclaw", ".openclaw-data"])(
    "replaces the %s device identity with an explicit startup placeholder",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-identity-state-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const identityPath = path.join(nativeRoot, stateDirectory, "identity", "device.json");
        const identity = {
          version: 1,
          deviceId: "a".repeat(64),
          publicKeyPem: "public-key-material",
          privateKeyPem: "private-key-material",
          createdAtMs: 1,
        };
        fs.mkdirSync(path.dirname(identityPath), { recursive: true });
        fs.writeFileSync(identityPath, JSON.stringify(identity));
        writeSandboxRegistry("alpha");

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: vi.fn(),
          },
        });

        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            expect(
              JSON.parse(
                fs.readFileSync(path.join(root, stateDirectory, "identity", "device.json"), "utf8"),
              ),
            ).toEqual({ nemoclawSanitizedDeviceIdentity: 1 });
          },
          `${stateDirectory}/identity/device.json`,
        );
        expect(JSON.parse(fs.readFileSync(identityPath, "utf8"))).toEqual(identity);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
