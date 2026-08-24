// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as dockerLlamaCppOperation from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import { privateBridgeFixture } from "../../onboard/runtime-provider/docker-llama-cpp-private-bridge.test-support";
import {
  createHostLocalCreateJournalStore,
  HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
} from "../../onboard/runtime-provider/host-local-create-journal";
import { serializeHostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";
import {
  loadManagedLlamaCppReceipt,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "../llama-cpp/managed-state";
import { PERSISTED_ENGINE_AUTHORITY_DIRECTORY } from "../../onboard/runtime-provider/persisted-engine-authority";
import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CATALOG_LABEL,
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
  HOST_LOCAL_VLLM_PRESET_LABEL,
  HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
  HOST_LOCAL_VLLM_RECIPE_LABEL,
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  persistHostLocalVllmRuntimeReceipt,
} from "../serving/vllm-host-local-lifecycle";
import { managedVllmStateDir } from "../vllm-api-key";
import {
  cleanupHuggingFaceCacheData,
  cleanupLocalModelRuntimes,
  cleanupManagedLlamaCppRuntimeForSandbox,
  finalizeManagedLlamaCppLifecycleCleanup,
  prepareManagedLlamaCppLifecycleCleanup,
  prepareManagedLlamaCppRuntimeCleanupForSandbox,
  resolveManagedLlamaCppCleanupTarget,
} from "./cleanup";
import {
  createManagedState,
  createPreStartManagedState,
  engineHarness,
  NETWORK_ID,
  RUNTIME_ID,
  TRANSACTION_ID,
} from "./cleanup.test-support";

const temporaryDirectories: string[] = [];
let createManagedLlamaCppEngineSpy: MockInstance | undefined;

afterEach(() => {
  createManagedLlamaCppEngineSpy?.mockRestore();
  createManagedLlamaCppEngineSpy = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-cleanup-"));
  const canonicalHome = fs.realpathSync(home);
  temporaryDirectories.push(canonicalHome);
  return canonicalHome;
}

function ownedContainer(
  name: string,
  id: string,
  labels: Record<string, string>,
  env: string[] = [],
): string {
  return JSON.stringify([{ Id: id, Name: `/${name}`, Config: { Env: env, Labels: labels } }]);
}

describe("host-local model cleanup", () => {
  it("treats an absent home as no managed runtime state", () => {
    const homeDir = path.join(temporaryHome(), "absent-home");

    expect(resolveManagedLlamaCppCleanupTarget(homeDir, 8080)).toBeNull();
    expect(cleanupManagedLlamaCppRuntimeForSandbox("sandbox", { homeDir })).toEqual({
      ok: true,
      preserved: [],
      removed: [],
    });
    expect(cleanupLocalModelRuntimes({ homeDir })).toEqual({
      ok: true,
      preserved: [],
      removed: [],
    });
  });

  it("retires an interrupted pre-start owner only after proving both runtime names absent", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: false, networkPresent: false });
    createPreStartManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "rm",
      "--force",
    ]);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "network",
      "rm",
    ]);
  });

  it("retains pre-start ownership when either fixed Docker name is present", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: true, networkPresent: false });
    createPreStartManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("cannot prove its fixed runtime names absent");
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    expect(harness.capture.mock.calls.map((call) => call[0]?.slice(0, 2))).not.toContainEqual([
      "rm",
      "--force",
    ]);
  });

  it("removes authenticated legacy host-local vLLM when key and fingerprint match", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "c".repeat(64);
    const containerId = "d".repeat(64);
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const capture = vi.fn((argv: readonly string[]) =>
      argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            containerId,
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "",
    );

    expect(
      cleanupLocalModelRuntimes({
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(false);
  });

  it("removes exact host-global vLLM state when cleanup is requested for a nondefault gateway", () => {
    const homeDir = temporaryHome();
    const gatewayPort = 8091;
    const stateDir = managedVllmStateDir(homeDir);
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "a".repeat(64);
    const containerId = "b".repeat(64);
    const serving = {
      catalogDigest: `sha256:${"c".repeat(64)}`,
      presetId: "vllm.dgx-spark-gb10.single.example",
      presetDigest: `sha256:${"d".repeat(64)}`,
      recipeId: "vllm.dgx-spark-gb10.single.example",
      recipeDigest: `sha256:${"e".repeat(64)}`,
    } as const;
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    persistHostLocalVllmRuntimeReceipt(
      { containerId, authFingerprint: runtimeAuthFingerprint(apiKey), serving },
      stateDir,
    );
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const capture = vi.fn((argv: readonly string[]) =>
      argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            containerId,
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
              [HOST_LOCAL_VLLM_CATALOG_LABEL]: serving.catalogDigest,
              [HOST_LOCAL_VLLM_PRESET_LABEL]: serving.presetId,
              [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: serving.presetDigest,
              [HOST_LOCAL_VLLM_RECIPE_LABEL]: serving.recipeId,
              [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: serving.recipeDigest,
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "",
    );

    expect(
      cleanupLocalModelRuntimes({
        gatewayPort,
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(forceRm).toHaveBeenCalledWith(containerId, {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE))).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          managedLlamaCppStatePaths(homeDir, gatewayPort).root,
          "dual-station-vllm-api-key",
        ),
      ),
    ).toBe(false);
  });

  it("removes a profile-labeled vLLM and its exact ownership receipt", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "1".repeat(64);
    const containerId = "2".repeat(64);
    const serving = {
      catalogDigest: `sha256:${"3".repeat(64)}`,
      presetId: "vllm.dgx-spark-gb10.single.example",
      presetDigest: `sha256:${"4".repeat(64)}`,
      recipeId: "vllm.dgx-spark-gb10.single.example",
      recipeDigest: `sha256:${"5".repeat(64)}`,
    } as const;
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    persistHostLocalVllmRuntimeReceipt(
      { containerId, authFingerprint: runtimeAuthFingerprint(apiKey), serving },
      stateDir,
    );
    const forceRm = vi.fn(() => ({ status: 0 }) as never);
    const capture = vi.fn((argv: readonly string[]) =>
      argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            containerId,
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
              [HOST_LOCAL_VLLM_CATALOG_LABEL]: serving.catalogDigest,
              [HOST_LOCAL_VLLM_PRESET_LABEL]: serving.presetId,
              [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: serving.presetDigest,
              [HOST_LOCAL_VLLM_RECIPE_LABEL]: serving.recipeId,
              [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: serving.recipeDigest,
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "",
    );

    expect(
      cleanupLocalModelRuntimes({
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(fs.existsSync(path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(false);
  });

  it("refuses to remove a profile-labeled vLLM without its ownership receipt", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "6".repeat(64);
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    const labels = {
      [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
      [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
      [HOST_LOCAL_VLLM_CATALOG_LABEL]: `sha256:${"7".repeat(64)}`,
      [HOST_LOCAL_VLLM_PRESET_LABEL]: "vllm.dgx-spark-gb10.single.example",
      [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: `sha256:${"8".repeat(64)}`,
      [HOST_LOCAL_VLLM_RECIPE_LABEL]: "vllm.dgx-spark-gb10.single.example",
      [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: `sha256:${"9".repeat(64)}`,
    };
    const forceRm = vi.fn(() => ({ status: 0 }) as never);

    expect(
      cleanupLocalModelRuntimes({
        homeDir,
        deps: {
          capture: vi.fn((argv: readonly string[]) =>
            argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
              ? ownedContainer(HOST_LOCAL_VLLM_CONTAINER_NAME, "a".repeat(64), labels, [
                  `VLLM_API_KEY=${apiKey}`,
                ])
              : "",
          ) as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("ownership receipt") });
    expect(forceRm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(true);
  });

  it("fails closed when the vLLM container name is foreign while local key state remains", () => {
    const homeDir = temporaryHome();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${"e".repeat(64)}\n`, {
      mode: 0o600,
    });
    const capture = vi.fn((argv: readonly string[]) => {
      return argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(HOST_LOCAL_VLLM_CONTAINER_NAME, "f".repeat(64), {})
        : "";
    });
    const forceRm = vi.fn(() => ({ status: 0 }) as never);

    expect(
      cleanupLocalModelRuntimes({
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => ({ status: 0 }) as never),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("container name is foreign") });
    expect(forceRm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(true);
  });

  it("removes only exact receipt-owned llama.cpp resources through the qualified engine", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const cache = path.join(homeDir, ".cache", "huggingface");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "shared-model"), "delete");
    fs.writeFileSync(path.join(cache, "token"), "keep-credential", { mode: 0o600 });
    fs.writeFileSync(path.join(cache, "stored_tokens"), "keep-stored-credentials", { mode: 0o600 });
    const ambientCapture = vi.fn(() => "") as never;
    const ambientForceRm = vi.fn(() => ({ status: 0 })) as never;
    const ambientRun = vi.fn(() => ({ status: 0 })) as never;

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
      deps: {
        capture: ambientCapture,
        forceRm: ambientForceRm,
        run: ambientRun,
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
    expect(ambientCapture).not.toHaveBeenCalled();
    expect(ambientForceRm).not.toHaveBeenCalled();
    expect(ambientRun).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(cache, "shared-model"), "utf8")).toBe("delete");
    expect(fs.readFileSync(path.join(cache, "token"), "utf8")).toBe("keep-credential");
    expect(fs.readFileSync(path.join(cache, "stored_tokens"), "utf8")).toBe(
      "keep-stored-credentials",
    );
    expect(result.removed).not.toContain(`cache-contents:${cache}`);
    expect(result.preserved).toContain(cache);
  });

  it("finishes common-lifecycle llama.cpp cleanup and preserves the shared model cache", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const receipt = loadManagedLlamaCppReceipt(paths)!;
    createHostLocalCreateJournalStore(paths.stateDir).retire(TRANSACTION_ID);
    const cache = path.join(homeDir, ".cache", "huggingface");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "shared-model"), "keep");
    const privateBridge = privateBridgeFixture();

    expect(
      prepareManagedLlamaCppLifecycleCleanup("spark-agent", receipt, {
        homeDir,
        engine: harness.engine,
      }),
    ).toEqual(receipt);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );

    const result = finalizeManagedLlamaCppLifecycleCleanup("spark-agent", receipt, {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });

    expect(result).toMatchObject({ ok: true });
    expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(privateBridge.assertStopped).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
    expect(fs.existsSync(paths.stateDir)).toBe(false);
    expect(fs.readFileSync(path.join(cache, "shared-model"), "utf8")).toBe("keep");
    expect(result.preserved).toContain(cache);
  });

  it("retries exact common-lifecycle cleanup after private state is already absent", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const receipt = loadManagedLlamaCppReceipt(paths)!;
    fs.rmSync(paths.stateDir, { recursive: true });
    const privateBridge = privateBridgeFixture();

    expect(
      prepareManagedLlamaCppLifecycleCleanup("spark-agent", receipt, {
        homeDir,
        engine: harness.engine,
      }),
    ).toEqual(receipt);
    const first = finalizeManagedLlamaCppLifecycleCleanup("spark-agent", receipt, {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });
    const second = finalizeManagedLlamaCppLifecycleCleanup("spark-agent", receipt, {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });

    expect(first).toMatchObject({ ok: true });
    expect(first.removed).toEqual([`container:${RUNTIME_ID}`, `network:${NETWORK_ID}`]);
    expect(second).toEqual({ ok: true, removed: [], preserved: [] });
  });

  it("removes non-credential Hugging Face cache data without running runtime cleanup", () => {
    const homeDir = temporaryHome();
    const cache = path.join(homeDir, ".cache", "huggingface");
    const runtimePaths = managedLlamaCppStatePaths(homeDir);
    createManagedState(homeDir, engineHarness().engine);
    const runtimeOwner = fs.readFileSync(runtimePaths.ownerPath, "utf8");
    const runtimeReceipt = fs.readFileSync(runtimePaths.receiptPath, "utf8");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "shared-model"), "delete");
    fs.writeFileSync(path.join(cache, "token"), "keep-credential", { mode: 0o600 });
    fs.writeFileSync(path.join(cache, "stored_tokens"), "keep-stored-credentials", { mode: 0o600 });

    const result = cleanupHuggingFaceCacheData({ homeDir });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(cache, "shared-model"))).toBe(false);
    expect(fs.readFileSync(path.join(cache, "token"), "utf8")).toBe("keep-credential");
    expect(fs.readFileSync(path.join(cache, "stored_tokens"), "utf8")).toBe(
      "keep-stored-credentials",
    );
    expect(fs.readFileSync(runtimePaths.ownerPath, "utf8")).toBe(runtimeOwner);
    expect(fs.readFileSync(runtimePaths.receiptPath, "utf8")).toBe(runtimeReceipt);
    expect(result.removed).toContain(`cache-contents:${cache}`);
    expect(result.preserved).toEqual(
      expect.arrayContaining([path.join(cache, "token"), path.join(cache, "stored_tokens")]),
    );
  });

  it("preserves the shared Hugging Face cache during runtime cleanup", () => {
    const homeDir = temporaryHome();
    const cache = path.join(homeDir, ".cache", "huggingface");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "shared-model"), "keep");

    const result = cleanupLocalModelRuntimes({ homeDir });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(cache, "shared-model"))).toBe(true);
    expect(result.preserved).toContain(cache);
    expect(result.removed).not.toContain(cache);
  });

  it("canonicalizes a symlink HOME alias before exact managed llama.cpp cleanup", () => {
    const homeDir = temporaryHome();
    const homeAlias = path.join(homeDir, "home-alias");
    fs.symlinkSync(homeDir, homeAlias, "dir");
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir: homeAlias,
      engine: harness.engine,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
  });

  it("rejects a final-component managed llama.cpp state-directory symlink", () => {
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    const symlinkTarget = path.join(homeDir, "foreign-managed-state");
    fs.mkdirSync(paths.root, { mode: 0o700, recursive: true });
    fs.mkdirSync(symlinkTarget, { mode: 0o700 });
    fs.symlinkSync(symlinkTarget, paths.stateDir, "dir");
    const harness = engineHarness();

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("state directory is a symlink"),
    });
    expect(harness.capture).not.toHaveBeenCalled();
    expect(fs.lstatSync(paths.stateDir).isSymbolicLink()).toBe(true);
  });

  it.each(["network-creating", "creating", "created", "started", "receipt-prepared"] as const)(
    "rolls back an unfinished %s create journal before deleting state",
    (phase) => {
      const homeDir = temporaryHome();
      const harness = engineHarness({ containerPresent: phase !== "network-creating" });
      createManagedState(homeDir, harness.engine, { phase });
      const privateBridge = privateBridgeFixture();

      const result = cleanupLocalModelRuntimes({
        homeDir,
        engine: harness.engine,
        privateBridge,
      });

      expect(result).toMatchObject({ ok: true });
      expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
    },
  );

  it("fails closed on a fresh uncertain create that has no exact container yet", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerPresent: false });
    createManagedState(homeDir, harness.engine, {
      phase: "creating",
      createIntentUnixMs: Date.now(),
    });

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("grace period"),
    });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("refuses a changed engine authority before any Docker inspection", () => {
    const homeDir = temporaryHome();
    const original = engineHarness({ authorityId: "docker:original" });
    const changed = engineHarness({ authorityId: "docker:changed" });
    const privateBridge = privateBridgeFixture();
    createManagedState(homeDir, original.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: changed.engine,
      privateBridge,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("endpoint"),
    });
    expect(privateBridge.stopTransaction).toHaveBeenCalledExactlyOnceWith(TRANSACTION_ID);
    expect(privateBridge.assertStopped).toHaveBeenCalledExactlyOnceWith(TRANSACTION_ID);
    expect(changed.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("does not collapse a daemon inspection error into exact absence", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ daemonInspectFailure: true });
    createManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("absence proof"),
    });
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("does not race cleanup against a live lifecycle execution lease", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const privateBridge = privateBridgeFixture();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    const store = createHostLocalCreateJournalStore(managedLlamaCppStatePaths(homeDir).stateDir);
    const lease = store.acquireExecution(TRANSACTION_ID);
    try {
      const result = cleanupLocalModelRuntimes({
        homeDir,
        engine: harness.engine,
        privateBridge,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("live process"),
      });
      expect(harness.capture).not.toHaveBeenCalledWith(
        ["rm", "--force", RUNTIME_ID],
        expect.any(Number),
      );
      expect(privateBridge.stopTransaction).not.toHaveBeenCalled();
      expect(privateBridge.assertStopped).not.toHaveBeenCalled();
      expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    } finally {
      store.releaseExecution(lease);
    }
  });

  it("does not prepare sandbox deletion against a live lifecycle execution lease (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    const store = createHostLocalCreateJournalStore(managedLlamaCppStatePaths(homeDir).stateDir);
    const lease = store.acquireExecution(TRANSACTION_ID);
    try {
      expect(() =>
        prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
          homeDir,
          engine: harness.engine,
        }),
      ).toThrow("live process");
      expect(harness.capture).not.toHaveBeenCalled();
    } finally {
      store.releaseExecution(lease);
    }
  });

  it("retains cleanup execution ownership until sandbox deletion is aborted (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    const contender = createHostLocalCreateJournalStore(
      managedLlamaCppStatePaths(homeDir).stateDir,
    );

    expect(() => contender.acquireExecution(TRANSACTION_ID)).toThrow("live process");
    prepared?.abort();
    const replacement = contender.acquireExecution(TRANSACTION_ID);
    contender.assertExecution(replacement);
    contender.releaseExecution(replacement);
  });

  it("retains cleanup execution ownership through final private-state removal (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    const contender = createHostLocalCreateJournalStore(paths.stateDir);
    const remove = fs.rmSync.bind(fs);
    let contentionError: unknown;
    let unexpectedLease: unknown;
    vi.spyOn(fs, "rmSync").mockImplementationOnce(((target, options) => {
      try {
        unexpectedLease = contender.acquireExecution("9".repeat(64));
      } catch (error) {
        contentionError = error;
      }
      return remove(target, options);
    }) as typeof fs.rmSync);

    expect(prepared?.cleanup()).toMatchObject({ ok: true });
    expect(contentionError).toEqual(
      expect.objectContaining({ message: expect.stringContaining("live process") }),
    );
    expect(unexpectedLease).toBeUndefined();
    expect(fs.existsSync(paths.stateDir)).toBe(false);
  });

  it("re-inspects after removal and retains authority when the container remains", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ removalLeavesContainer: true });
    createManagedState(homeDir, harness.engine);

    const result = cleanupLocalModelRuntimes({
      homeDir,
      engine: harness.engine,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not proven"),
    });
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["network", "rm", NETWORK_ID],
      expect.any(Number),
    );
  });

  it("stops the exact bridge before sandbox cleanup and leaves a different owner untouched (#9598)", () => {
    const homeDir = temporaryHome();
    const gatewayPort = 8091;
    const harness = engineHarness();
    const privateBridge = privateBridgeFixture();
    createManagedState(homeDir, harness.engine, { gatewayPort });

    const skipped = cleanupManagedLlamaCppRuntimeForSandbox("different-sandbox", {
      homeDir,
      gatewayPort,
      engine: harness.engine,
      privateBridge,
    });
    expect(skipped).toEqual({ ok: true, removed: [], preserved: [] });
    expect(harness.capture).not.toHaveBeenCalled();
    expect(privateBridge.stopTransaction).not.toHaveBeenCalled();
    expect(privateBridge.assertStopped).not.toHaveBeenCalled();

    const removed = cleanupManagedLlamaCppRuntimeForSandbox("spark-agent", {
      homeDir,
      gatewayPort,
      engine: harness.engine,
      privateBridge,
    });
    expect(removed).toMatchObject({ ok: true });
    expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(privateBridge.assertStopped).toHaveBeenCalledWith(TRANSACTION_ID);
    const containerRemovalCall = harness.capture.mock.calls.findIndex(
      ([argv]) => argv[0] === "rm" && argv[1] === "--force",
    );
    expect(containerRemovalCall).toBeGreaterThanOrEqual(0);
    expect(privateBridge.stopTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.capture.mock.invocationCallOrder[containerRemovalCall]!,
    );
    expect(privateBridge.stopTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      privateBridge.assertStopped.mock.invocationCallOrder[0]!,
    );
    expect(privateBridge.assertStopped.mock.invocationCallOrder[0]).toBeLessThan(
      harness.capture.mock.invocationCallOrder[containerRemovalCall]!,
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir, gatewayPort).stateDir)).toBe(false);
  });

  it("retains the qualified engine across delayed sandbox cleanup (#9888)", () => {
    const homeDir = temporaryHome();
    const qualified = engineHarness({ authorityId: "docker:qualified" });
    const drifted = engineHarness({ authorityId: "docker:drifted" });
    const privateBridge = privateBridgeFixture();
    createManagedState(homeDir, qualified.engine);
    let crossedDeleteBoundary = false;
    const createEngine = (createManagedLlamaCppEngineSpy = vi
      .spyOn(dockerLlamaCppOperation, "createManagedLlamaCppEngine")
      .mockImplementation(() => (crossedDeleteBoundary ? drifted.engine : qualified.engine)));

    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      privateBridge,
    });
    crossedDeleteBoundary = true;

    expect(prepared).not.toBeNull();
    expect(prepared!.cleanup()).toMatchObject({ ok: true });
    expect(createEngine).toHaveBeenCalledOnce();
    expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(qualified.capture).toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(qualified.capture).toHaveBeenCalledWith(
      ["network", "rm", NETWORK_ID],
      expect.any(Number),
    );
    expect(drifted.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("fails closed when the qualified engine becomes unavailable after preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const privateBridge = privateBridgeFixture();
    createManagedState(homeDir, harness.engine);

    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });
    harness.capture.mockClear();
    harness.capture.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "daemon unavailable",
    });

    expect(prepared).not.toBeNull();
    expect(prepared!.cleanup()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("engine availability check"),
    });
    expect(harness.capture).toHaveBeenCalledWith(["info"], expect.any(Number));
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("refuses an unavailable engine before preparing interrupted cleanup (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    harness.capture.mockClear();
    harness.capture.mockReturnValue({ status: 1, stdout: "", stderr: "daemon unavailable" });

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toThrow("engine availability check");
    expect(harness.capture).toHaveBeenCalledWith(["info"], expect.any(Number));
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("refuses a foreign container before preparing interrupted cleanup (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness({ containerForeign: true });
    createManagedState(homeDir, harness.engine, { phase: "started" });
    harness.capture.mockClear();

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toThrow("container does not match its exact journal");
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("refuses private owner drift after cleanup preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    const owner = fs.readFileSync(paths.ownerPath, "utf8");
    const parsedOwner = JSON.parse(owner) as Record<string, unknown>;
    fs.writeFileSync(
      paths.ownerPath,
      `${JSON.stringify({ ...parsedOwner, catalogDigest: `sha256:${"0".repeat(64)}` })}\n`,
      { mode: 0o600 },
    );
    harness.capture.mockClear();

    expect(prepared?.cleanup()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("private authority changed after cleanup preparation"),
    });
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(paths.stateDir)).toBe(true);
  });

  it("refuses API-key replacement after cleanup preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    fs.writeFileSync(paths.apiKeyPath, `${"f".repeat(64)}\n`, { mode: 0o600 });
    harness.capture.mockClear();

    expect(prepared?.cleanup()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("private authority changed after cleanup preparation"),
    });
    expect(fs.existsSync(paths.apiKeyPath)).toBe(true);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
  });

  it("refuses a new private-state entry after cleanup preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    const concurrentState = path.join(paths.stateDir, "concurrent-state.json");
    fs.writeFileSync(concurrentState, "{}\n", { mode: 0o600 });
    harness.capture.mockClear();

    expect(prepared?.cleanup()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("private authority changed after cleanup preparation"),
    });
    expect(fs.existsSync(concurrentState)).toBe(true);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
  });

  it("refuses missing private state after cleanup preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
    });
    fs.rmSync(paths.stateDir, { recursive: true });
    harness.capture.mockClear();

    expect(prepared?.cleanup()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("private authority changed after cleanup preparation"),
    });
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
  });

  it("rejects receipt and journal disagreement during pre-delete qualification (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    const receipt = loadManagedLlamaCppReceipt(paths)!;
    fs.writeFileSync(
      paths.receiptPath,
      serializeHostLocalInferenceReceipt({
        ...receipt,
        endpoint: { ...receipt.endpoint, networkName: "foreign-network" },
      }),
      { mode: 0o600 },
    );

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toThrow("receipt does not match gateway lifecycle authority");
    expect(harness.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.stateDir)).toBe(true);
  });

  it("refuses mixed lifecycle journals during cleanup preparation (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, { phase: "started" });
    const paths = managedLlamaCppStatePaths(homeDir);
    const journalStore = createHostLocalCreateJournalStore(paths.stateDir);
    const [journal] = journalStore.list();
    journalStore.create({
      ...journal!,
      transactionId: "8".repeat(64),
      phase: "prepared",
      service: "ollama",
      runtimeId: null,
      createIntentUnixMs: null,
    });
    harness.capture.mockClear();

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toThrow("more than one lifecycle journal");
    expect(harness.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.stateDir)).toBe(true);
  });

  it("reports an incompatible journal before a missing finalized receipt (#9888)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const paths = managedLlamaCppStatePaths(homeDir);
    fs.unlinkSync(paths.receiptPath);
    const journalDirectory = path.join(paths.stateDir, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY);
    const [entry] = fs.readdirSync(journalDirectory);
    const journalPath = path.join(journalDirectory, entry!);
    const record = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ ...record, containerName: "foreign-container" })}\n`,
      { mode: 0o600 },
    );

    expect(
      cleanupManagedLlamaCppRuntimeForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("lifecycle journal is incompatible"),
    });
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("retains the selected engine for an interrupted journal without a receipt (#9888)", () => {
    const homeDir = temporaryHome();
    const qualified = engineHarness({ authorityId: "docker:qualified" });
    const drifted = engineHarness({ authorityId: "docker:drifted" });
    createManagedState(homeDir, qualified.engine, { phase: "started" });
    let crossedDeleteBoundary = false;
    createManagedLlamaCppEngineSpy = vi
      .spyOn(dockerLlamaCppOperation, "createManagedLlamaCppEngine")
      .mockImplementation(() => (crossedDeleteBoundary ? drifted.engine : qualified.engine));

    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", { homeDir });
    crossedDeleteBoundary = true;

    expect(prepared?.cleanup()).toMatchObject({ ok: true });
    expect(qualified.capture).toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(drifted.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(false);
  });

  it("refuses a drifted engine before deleting an interrupted journal owner (#9888)", () => {
    const homeDir = temporaryHome();
    const qualified = engineHarness({ authorityId: "docker:qualified" });
    const drifted = engineHarness({ authorityId: "docker:drifted" });
    createManagedState(homeDir, qualified.engine, { phase: "started" });
    createManagedLlamaCppEngineSpy = vi
      .spyOn(dockerLlamaCppOperation, "createManagedLlamaCppEngine")
      .mockReturnValue(drifted.engine);

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", { homeDir }),
    ).toThrow("Qualified container endpoint does not match persisted authority.");
    expect(drifted.capture).not.toHaveBeenCalled();
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });

  it("does not create journal or authority directories during owner-only preflight (#9888)", () => {
    const homeDir = temporaryHome();
    const paths = managedLlamaCppStatePaths(homeDir);
    reserveManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: "spark-agent",
      catalogDigest: `sha256:${"5".repeat(64)}`,
      presetDigest: `sha256:${"6".repeat(64)}`,
      recipeDigest: `sha256:${"7".repeat(64)}`,
      recipeId: "llama-cpp.nemotron.spark.v1",
    });
    const harness = engineHarness();

    expect(() =>
      prepareManagedLlamaCppRuntimeCleanupForSandbox("spark-agent", {
        homeDir,
        engine: harness.engine,
      }),
    ).toThrow("authority directory is missing");
    expect(fs.existsSync(path.join(paths.stateDir, HOST_LOCAL_CREATE_JOURNAL_DIRECTORY))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(paths.stateDir, PERSISTED_ENGINE_AUTHORITY_DIRECTORY))).toBe(
      false,
    );
  });

  it("stops the managed llama.cpp bridge before removing the container it forwards to (#9598)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine);
    const privateBridge = privateBridgeFixture();

    const result = cleanupManagedLlamaCppRuntimeForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });

    expect(result).toMatchObject({ ok: true });
    expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(privateBridge.assertStopped).toHaveBeenCalledWith(TRANSACTION_ID);
    const removalCall = harness.capture.mock.calls.findIndex((call) => call[0]?.[0] === "rm");
    expect(removalCall).toBeGreaterThanOrEqual(0);
    expect(privateBridge.stopTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.capture.mock.invocationCallOrder[removalCall]!,
    );
  });

  it("preserves lifecycle authority when the sandbox bridge remains active (#9598)", () => {
    const homeDir = temporaryHome();
    const harness = engineHarness();
    const privateBridge = privateBridgeFixture();
    privateBridge.assertStopped.mockImplementationOnce(() => {
      throw new Error("bridge remains active");
    });
    createManagedState(homeDir, harness.engine);

    const result = cleanupManagedLlamaCppRuntimeForSandbox("spark-agent", {
      homeDir,
      engine: harness.engine,
      privateBridge,
    });

    expect(result).toMatchObject({ ok: false, reason: "bridge remains active" });
    expect(privateBridge.stopTransaction).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(privateBridge.assertStopped).toHaveBeenCalledWith(TRANSACTION_ID);
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["rm", "--force", RUNTIME_ID],
      expect.any(Number),
    );
    expect(harness.capture).not.toHaveBeenCalledWith(
      ["network", "rm", NETWORK_ID],
      expect.any(Number),
    );
    expect(fs.existsSync(managedLlamaCppStatePaths(homeDir).stateDir)).toBe(true);
  });
});
