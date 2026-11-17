// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  applyHermesManagedRoute,
  refreshHermesNativeLocalCredential,
  type HermesManagedRouting,
} from "../../src/lib/hermes-managed-route.ts";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../../src/lib/inference/native-nvidia/contract.ts";
import { useOrderedNativeCapture } from "../support/native-snapshot.ts";

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
  type ManagedHermesConfig = Record<string, unknown> & HermesManagedRouting;
  describe.each([
    {
      provider: "openrouter-api",
      baseUrl: "https://openrouter.ai/api/v1",
      template: "${OPENROUTER_API_KEY}",
    },
    {
      provider: "nvidia-prod",
      baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
      template: "${NVIDIA_INFERENCE_API_KEY}",
    },
  ])("Hermes $provider archive references", ({ provider, baseUrl, template }) => {
    it.each([
      {
        name: "managed route with Discord",
        change: (_config: ManagedHermesConfig) => {},
        retained: true,
      },
      {
        name: "managed route without Discord",
        change: (config: ManagedHermesConfig) => {
          delete config.discord;
        },
        retained: true,
      },
      {
        name: "mismatched endpoint",
        change: (config: ManagedHermesConfig) => {
          config.model.base_url = "https://other.example/v1";
        },
        retained: false,
      },
      {
        name: "mismatched provider",
        change: (config: ManagedHermesConfig) => {
          config._nemoclaw_upstream.provider = "openai-api";
        },
        retained: false,
      },
      {
        name: "partial credential reference",
        change: (config: ManagedHermesConfig) => {
          config.providers[provider]!.api_key = `${template}-extra`;
        },
        retained: false,
      },
      {
        name: "duplicate custom provider",
        change: (config: ManagedHermesConfig) => {
          config.custom_providers.push({ ...config.custom_providers[0]! });
        },
        retained: false,
      },
      {
        name: "raw credential",
        change: (config: ManagedHermesConfig) => {
          config.model.api_key = "raw-provider-fixture-secret";
        },
        retained: false,
      },
    ])(
      "preserves only the validated managed reference: $name (#13759, #14020)",
      ({ change, retained }) => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-managed-archive-"));
        try {
          const nativeRoot = path.join(fixture, "native-home");
          const configPath = ".hermes/config.yaml";
          const archivedConfigPath = ".hermes/backups/config/config.yaml.saved";
          const alternateConfigPath = ".hermes/config.yml";
          fs.mkdirSync(path.join(nativeRoot, ".hermes"), { recursive: true });
          const config: Record<string, unknown> = {
            unrelated: { api_key: "raw-unrelated-fixture-secret", token: template },
            discord: { require_mention: true },
            settings: { max_turns: 12 },
          };
          const route = {
            model: "nvidia/nemotron-3-ultra-550b-a55b",
            upstreamProvider: provider,
            baseUrl,
            inferenceApi: "openai-completions",
          };
          applyHermesManagedRoute(config, route);
          change(config);
          const source = JSON.stringify(config);
          fs.writeFileSync(path.join(nativeRoot, configPath), source);
          fs.mkdirSync(path.dirname(path.join(nativeRoot, archivedConfigPath)), {
            recursive: true,
          });
          fs.writeFileSync(path.join(nativeRoot, archivedConfigPath), source);
          fs.writeFileSync(path.join(nativeRoot, alternateConfigPath), source);
          writeSandboxRegistry("hermes-managed-archive", "hermes");

          const backup = sandboxState.backupSandboxState("hermes-managed-archive", {
            nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
          });

          expect(backup.success, backup.error).toBe(true);
          sandboxState.inspectNativeSandboxState(backup.manifest!.backupPath, (root: string) => {
            const restored = parseYaml(fs.readFileSync(path.join(root, configPath), "utf8"));
            const expected = retained ? template : "[STRIPPED_BY_MIGRATION]";
            expect(restored.model.api_key).toBe(expected);
            expect(restored.providers[provider].api_key).toBe(expected);
            expect(restored.custom_providers[0].api_key).toBe(expected);
            expect(restored.unrelated).toEqual({
              api_key: "[STRIPPED_BY_MIGRATION]",
              token: "[STRIPPED_BY_MIGRATION]",
            });
            expect(restored.discord).toEqual(config.discord);
            expect(restored.settings).toEqual(config.settings);
            const strippedSlots = {
              model: { api_key: "[STRIPPED_BY_MIGRATION]" },
              providers: { [provider]: { api_key: "[STRIPPED_BY_MIGRATION]" } },
              custom_providers: expect.arrayContaining([
                expect.objectContaining({ api_key: "[STRIPPED_BY_MIGRATION]" }),
              ]),
            };
            const saved = parseYaml(fs.readFileSync(path.join(root, archivedConfigPath), "utf8"));
            expect(saved).toMatchObject(strippedSlots);
            const alternate = parseYaml(
              fs.readFileSync(path.join(root, alternateConfigPath), "utf8"),
            );
            expect(alternate).toMatchObject(strippedSlots);
          });
          expect(fs.readFileSync(path.join(nativeRoot, configPath), "utf8")).toBe(source);
          expect(fs.readFileSync(path.join(nativeRoot, archivedConfigPath), "utf8")).toBe(source);
          expect(fs.readFileSync(path.join(nativeRoot, alternateConfigPath), "utf8")).toBe(source);
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      },
    );

    it("rejects an opaque secret beside an approved managed reference (#14020)", () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-archive-secret-"));
      try {
        const config: Record<string, unknown> = { notes: "PASSWORD=abc12345" };
        applyHermesManagedRoute(config, {
          model: "m",
          upstreamProvider: provider,
          baseUrl,
          inferenceApi: "openai-completions",
        });
        const nativeRoot = path.join(fixture, "native-home");
        fs.mkdirSync(path.join(nativeRoot, ".hermes"), { recursive: true });
        const configPath = path.join(nativeRoot, ".hermes/config.yaml");
        const source = JSON.stringify(config);
        fs.writeFileSync(configPath, source);
        writeSandboxRegistry("hermes-archive-secret", "hermes");
        const backup = sandboxState.backupSandboxState("hermes-archive-secret", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        });
        expect(backup.success).toBe(false);
        expect(backup.error).toContain("credential-bearing or uninspectable content");
        expect(backup.error).not.toContain("abc12345");
        expect(fs.readFileSync(configPath, "utf8")).toBe(source);
        const backupRoot = path.join(TMP_HOME, ".nemoclaw/rebuild-backups/hermes-archive-secret");
        expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toEqual([]);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
  });

  it.each([
    { name: "fresh route without Discord", settings: {}, nativeCredentialHandle: undefined },
    {
      name: "fresh route with Discord",
      settings: { discord: { require_mention: true } },
      nativeCredentialHandle: undefined,
    },
    {
      name: "issued route with Discord",
      settings: { discord: { require_mention: true } },
      nativeCredentialHandle: "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    },
  ])(
    "rebinds an archived NVIDIA $name without changing settings (#14020)",
    ({ settings, nativeCredentialHandle }) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-nvidia-rebind-"));
      try {
        const config: Record<string, unknown> = { ...settings, max_turns: 12 };
        const route = {
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          upstreamProvider: "nvidia-prod",
          baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
          inferenceApi: "openai-completions",
          contextWindow: 131072,
        };
        applyHermesManagedRoute(config, { ...route, nativeCredentialHandle });
        const nativeRoot = path.join(fixture, "native-home");
        fs.mkdirSync(path.join(nativeRoot, ".hermes"), { recursive: true });
        const configPath = path.join(nativeRoot, ".hermes/config.yaml");
        const source = JSON.stringify(config);
        fs.writeFileSync(configPath, source);
        writeSandboxRegistry("hermes-nvidia-rebind", "hermes");
        const backup = sandboxState.backupSandboxState("hermes-nvidia-rebind", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        });
        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(backup.manifest!.backupPath, (root: string) => {
          const restored = parseYaml(
            fs.readFileSync(path.join(root, ".hermes/config.yaml"), "utf8"),
          );
          expect(restored).toEqual(config);
          const fresh = "openshell:resolve:env:v8_NVIDIA_INFERENCE_API_KEY";
          refreshHermesNativeLocalCredential(restored, { ...route, nativeCredentialHandle: fresh });
          const expected = structuredClone(config);
          expected.model.api_key = fresh;
          expected.providers["nvidia-prod"]!.api_key = fresh;
          expected.custom_providers[0]!.api_key = fresh;
          expect(restored).toEqual(expected);
        });
        expect(fs.readFileSync(configPath, "utf8")).toBe(source);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

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

  it("rejects cumulative configuration growth beyond the backup-space limit", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-growth-limit-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const source = `${Array.from({ length: 2000 }, (_, index) => `setting${index}: on\n`).join("")}api_key: private-fixture-value\n`;
      const config = path.join(nativeRoot, ".hermes/config.yaml");
      const saved = path.join(nativeRoot, ".hermes/backups/config/config.yml.saved");
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(config, source);
      fs.writeFileSync(saved, source);
      const captured = spawnSync("tar", ["-C", nativeRoot, "-cf", "-", "."]);
      expect(captured.status).toBe(0);
      const replacement = JSON.stringify({
        ...parseYaml(source),
        api_key: "[STRIPPED_BY_MIGRATION]",
      });
      const growth =
        (Math.ceil(Buffer.byteLength(replacement) / 512) -
          Math.ceil(Buffer.byteLength(source) / 512)) *
        512;
      expect(growth).toBeGreaterThan(0);
      // The capture and one expansion fit; the second expansion must be rejected.
      const limit = captured.stdout.byteLength + growth;
      const boundedArchive = path.join(fixture, "bounded.tar");
      fs.writeFileSync(boundedArchive, captured.stdout);
      expect(sandboxState.sanitizeMachineLocalArchiveConfig(boundedArchive, limit)).toContain(
        "backup-space limit",
      );
      expect(fs.statSync(boundedArchive).size).toBe(limit);
      writeSandboxRegistry("growth-limit", "hermes");
      const backup = sandboxState.backupSandboxState("growth-limit", {
        nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        nativeStateCaptureMaxBytes: limit,
      });
      expect(backup.success).toBe(false);
      expect(backup.error).toContain("sanitation failed");
      expect(backup.error).toContain("backup-space limit");
      expect(backup.error).toContain("Free backup-disk space");
      const backups = path.join(TMP_HOME, ".nemoclaw/rebuild-backups/growth-limit");
      expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
      expect(fs.readFileSync(config, "utf8")).toBe(source);
      expect(fs.readFileSync(saved, "utf8")).toBe(source);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "stops archive growth at the deadline with deferred cleanup %s",
    (deferCleanup) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-growth-deadline-"));
      const originalWrite = fs.writeSync;
      let now = Date.now();
      const deadline = now + 60_000;
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const source = `${Array.from({ length: 2000 }, (_, index) => `setting${index}: on\n`).join("")}api_key: private-fixture-value\n`;
        const config = path.join(nativeRoot, ".hermes/config.yaml");
        const saved = path.join(nativeRoot, ".hermes/backups/config/config.yml.saved");
        fs.mkdirSync(path.dirname(saved), { recursive: true });
        fs.writeFileSync(config, source);
        fs.writeFileSync(saved, source);
        const trailing = Buffer.alloc(3 * 1024 * 1024, 0x61);
        fs.writeFileSync(path.join(nativeRoot, "workspace.txt"), trailing);
        writeSandboxRegistry("growth-deadline", "hermes");
        vi.spyOn(Date, "now").mockImplementation(() => now);
        useOrderedNativeCapture(nativeRoot, [
          ".hermes/config.yaml",
          ".hermes/backups/config/config.yml.saved",
          "workspace.txt",
        ]);
        const writes = vi.spyOn(fs, "writeSync").mockImplementationOnce((...args) => {
          expect(args[1]).toBeInstanceOf(Buffer);
          expect(args[1]).toHaveLength(1024 * 1024);
          const result = Reflect.apply(originalWrite, fs, args);
          now = deadline;
          return result;
        });
        syncBuiltinESMExports();
        const backup = sandboxState.backupSandboxState("growth-deadline", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
          deadlineMs: deadline,
          deferSanitizationDeadlineCleanup: deferCleanup,
        });
        expect(writes, backup.error).toHaveBeenCalledTimes(1);
        expect(backup.success).toBe(false);
        expect(backup.error).toContain("sanitation failed");
        expect(backup.error).toContain("backup deadline");
        expect(backup.manifest).toBeUndefined();
        const backups = path.join(TMP_HOME, ".nemoclaw/rebuild-backups/growth-deadline");
        expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
        expect(fs.readFileSync(config, "utf8")).toBe(source);
        expect(fs.readFileSync(saved, "utf8")).toBe(source);
        expect(fs.readFileSync(path.join(nativeRoot, "workspace.txt"))).toEqual(trailing);
      } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
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
