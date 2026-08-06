// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_LLAMA_CPP_AUTH_LABEL,
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_GENERATION_LABEL,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
} from "../llama-cpp/managed-installer";
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
import { cleanupLocalModelRuntimes, type LocalModelRuntimeCleanupOptions } from "./cleanup";

const temporaryDirectories: string[] = [];

function result(status = 0) {
  return { status } as never;
}

function ownedContainer(
  name: string,
  id: string,
  labels: Record<string, string>,
  env: string[] = [],
) {
  return JSON.stringify([{ Id: id, Name: `/${name}`, Config: { Env: env, Labels: labels } }]);
}

function ownedNetwork(name: string, id: string, generation: string) {
  return JSON.stringify([
    {
      Driver: "bridge",
      Id: id,
      Internal: true,
      Name: name,
      Scope: "local",
      Labels: {
        [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
        [MANAGED_LLAMA_CPP_GENERATION_LABEL]: generation,
      },
    },
  ]);
}

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-cleanup-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("host-local model runtime cleanup", () => {
  it("removes exact llama.cpp container and network IDs while preserving the cache", () => {
    const homeDir = home();
    const runtimeState = path.join(homeDir, ".nemoclaw", "managed-llama-cpp");
    fs.mkdirSync(runtimeState, {
      mode: 0o700,
      recursive: true,
    });
    const generation = "9".repeat(32);
    const apiKey = "8".repeat(64);
    fs.writeFileSync(
      path.join(runtimeState, "owner.json"),
      `${JSON.stringify({ id: "nemoclaw-local-model-profile", generation })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(runtimeState, "api-key"), `${apiKey}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(runtimeState, "runtime.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        receiptRef: "llama-cpp.host-local.receipt/v1",
        owner: { id: "nemoclaw-local-model-profile", generation },
        authentication: {
          fingerprint: runtimeAuthFingerprint(apiKey),
        },
        container: { name: MANAGED_LLAMA_CPP_CONTAINER_NAME, id: "a".repeat(64) },
        network: { name: MANAGED_LLAMA_CPP_NETWORK_NAME, id: "b".repeat(64) },
        runtime: { image: `example.invalid/runtime@sha256:${"c".repeat(64)}` },
        model: { servedName: "catalog-model", digest: `sha256:${"d".repeat(64)}`, sizeBytes: 1 },
      })}\n`,
      { mode: 0o600 },
    );
    const cache = path.join(homeDir, ".cache", "nemoclaw", "llama-cpp");
    fs.mkdirSync(cache, { mode: 0o700, recursive: true });
    const forceRm = vi.fn(() => result());
    const run = vi.fn(() => result());
    const capture = vi.fn((argv: readonly string[]) => {
      const llamaResult =
        argv[0] === "container" && argv[2] === MANAGED_LLAMA_CPP_CONTAINER_NAME
          ? ownedContainer(MANAGED_LLAMA_CPP_CONTAINER_NAME, "a".repeat(64), {
              [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
              [MANAGED_LLAMA_CPP_GENERATION_LABEL]: generation,
              [MANAGED_LLAMA_CPP_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
            })
          : "";
      const networkResult =
        argv[0] === "network" && argv[2] === MANAGED_LLAMA_CPP_NETWORK_NAME
          ? ownedNetwork(MANAGED_LLAMA_CPP_NETWORK_NAME, "b".repeat(64), generation)
          : "";
      return llamaResult || networkResult;
    });

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: { capture: capture as never, forceRm: forceRm as never, run: run as never },
      }),
    ).toEqual({
      ok: true,
      removed: [`container:${"a".repeat(64)}`, `network:${"b".repeat(64)}`],
      preserved: [cache],
    });
    expect(forceRm).toHaveBeenCalledWith("a".repeat(64), expect.any(Object));
    expect(run).toHaveBeenCalledWith(["network", "rm", "b".repeat(64)], expect.any(Object));
  });

  it("removes authenticated host-local vLLM only when key and fingerprint match", () => {
    const homeDir = home();
    const stateDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
    const apiKey = "c".repeat(64);
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
      mode: 0o600,
    });
    const forceRm = vi.fn(() => result());
    const capture = vi.fn((argv: readonly string[]) => {
      return argv[0] === "container" && argv[2] === HOST_LOCAL_VLLM_CONTAINER_NAME
        ? ownedContainer(
            HOST_LOCAL_VLLM_CONTAINER_NAME,
            "d".repeat(64),
            {
              [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
              [HOST_LOCAL_VLLM_AUTH_LABEL]: runtimeAuthFingerprint(apiKey),
            },
            [`VLLM_API_KEY=${apiKey}`],
          )
        : "";
    });
    const options: LocalModelRuntimeCleanupOptions = {
      deleteModels: false,
      homeDir,
      deps: { capture: capture as never, forceRm: forceRm as never, run: vi.fn(() => result()) },
    };

    expect(cleanupLocalModelRuntimes(options)).toMatchObject({
      ok: true,
      removed: [`container:${"d".repeat(64)}`],
    });
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(false);
  });

  it("removes a profile-labeled vLLM and its exact ownership receipt", () => {
    const homeDir = home();
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
    const forceRm = vi.fn(() => result());
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
        deleteModels: false,
        homeDir,
        deps: { capture: capture as never, forceRm: forceRm as never, run: vi.fn(() => result()) },
      }),
    ).toMatchObject({ ok: true, removed: [`container:${containerId}`] });
    expect(fs.existsSync(path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE))).toBe(false);
  });

  it("refuses to remove a profile-labeled vLLM without its ownership receipt", () => {
    const homeDir = home();
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
    const forceRm = vi.fn(() => result());

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: vi.fn(() =>
            ownedContainer(HOST_LOCAL_VLLM_CONTAINER_NAME, "a".repeat(64), labels, [
              `VLLM_API_KEY=${apiKey}`,
            ]),
          ) as never,
          forceRm: forceRm as never,
          run: vi.fn(() => result()),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("ownership receipt") });
    expect(forceRm).not.toHaveBeenCalled();
  });

  it("fails closed when the vLLM container name is foreign while local key state remains", () => {
    const homeDir = home();
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
    const forceRm = vi.fn(() => result());

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: { capture: capture as never, forceRm: forceRm as never, run: vi.fn(() => result()) },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("container name is foreign") });
    expect(forceRm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "dual-station-vllm-api-key"))).toBe(true);
  });

  it("fails closed when Docker is unavailable and managed llama.cpp state remains", () => {
    const homeDir = home();
    fs.mkdirSync(path.join(homeDir, ".nemoclaw", "managed-llama-cpp"), {
      mode: 0o700,
      recursive: true,
    });
    const capture = vi.fn(() => "");
    const forceRm = vi.fn(() => result());
    expect(
      cleanupLocalModelRuntimes({
        deleteModels: false,
        homeDir,
        deps: {
          capture: capture as never,
          forceRm: forceRm as never,
          run: vi.fn(() => result(1)),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Docker is unavailable") });
    expect(capture).not.toHaveBeenCalled();
    expect(forceRm).not.toHaveBeenCalled();
  });

  it("deletes only a receipt-bound managed llama.cpp cache", () => {
    const homeDir = home();
    const cacheRoot = path.join(homeDir, ".cache", "nemoclaw", "llama-cpp");
    const entryName = `sha256-${"a".repeat(64)}`;
    const entryDir = path.join(cacheRoot, entryName);
    const owner = { id: "nemoclaw-local-model-profile", generation: "b".repeat(32) };
    fs.mkdirSync(entryDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "owner.json"), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(entryDir, "receipt.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
        cache: { ref: "llama-cpp.gguf-content-addressed/v1", key: entryName },
        owner,
      })}\n`,
      { mode: 0o600 },
    );

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: true,
        homeDir,
        deps: {
          capture: vi.fn(() => ""),
          forceRm: vi.fn() as never,
          run: vi.fn(() => result()),
        },
      }),
    ).toMatchObject({ ok: true, removed: [`cache:${cacheRoot}`] });
    expect(fs.existsSync(cacheRoot)).toBe(false);
  });

  it("preserves the cache when a receipt does not match its owner", () => {
    const homeDir = home();
    const cacheRoot = path.join(homeDir, ".cache", "nemoclaw", "llama-cpp");
    const entryName = `sha256-${"c".repeat(64)}`;
    const entryDir = path.join(cacheRoot, entryName);
    fs.mkdirSync(entryDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "owner.json"),
      `${JSON.stringify({ id: "nemoclaw-local-model-profile", generation: "d".repeat(32) })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(entryDir, "receipt.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
        cache: { ref: "llama-cpp.gguf-content-addressed/v1", key: entryName },
        owner: { id: "nemoclaw-local-model-profile", generation: "e".repeat(32) },
      })}\n`,
      { mode: 0o600 },
    );

    expect(
      cleanupLocalModelRuntimes({
        deleteModels: true,
        homeDir,
        deps: {
          capture: vi.fn(() => ""),
          forceRm: vi.fn() as never,
          run: vi.fn(() => result()),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
    expect(fs.existsSync(cacheRoot)).toBe(true);
  });
});
