// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

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

function writeOpenClawRegistry(sandboxName: string): void {
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
          agent: null,
        },
      },
    }),
  );
}

describe("complete native-home machine authority", () => {
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
        writeOpenClawRegistry("alpha");

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
