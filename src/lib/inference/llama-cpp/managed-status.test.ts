// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import { dockerLlamaCppBindingSha256 as managedLlamaCppBindingSha256 } from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import { createHostLocalCreateJournalStore } from "../../onboard/runtime-provider/host-local-create-journal";
import { serializeHostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import {
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
} from "./managed-installer";
import {
  createManagedLlamaCppReceiptWriter,
  loadOrCreateManagedLlamaCppApiKey,
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "./managed-state";
import { inspectManagedLlamaCppStatus, type ManagedLlamaCppStatusOptions } from "./managed-status";

const TRANSACTION_ID = "1".repeat(64);
const RUNTIME_ID = "2".repeat(64);
const SPEC_SHA256 = "3".repeat(64);
const NETWORK_ID = "e".repeat(64);
const RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const GENERIC_PRESET_ID = "llama-cpp.linux-amd64-nvidia.single.nemotron-3-nano-30b-a3b";
const IMAGE = `ghcr.io/nvidia/llama-cpp@sha256:${"4".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-llama-status-")));
  temporaryDirectories.push(home);
  return home;
}

function engine(
  capture: ContainerEngine["capture"],
  authorityId = "docker:local",
): ContainerEngine {
  return {
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId,
    capture,
    captureHost: capture,
  };
}

function reserveState(homeDir: string, presetId?: string, presetDigest?: string): void {
  const paths = managedLlamaCppStatePaths(homeDir);
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(
    ({ metadata, spec }) =>
      spec.plan.backend === "install-llama-cpp" &&
      spec.plan.recipeRef === RECIPE_ID &&
      (presetId === undefined || metadata.id === presetId),
  )!;
  reserveManagedLlamaCppOwner(paths, {
    schemaVersion: 1,
    sandboxName: "spark-agent",
    catalogDigest: catalog.catalogDigest,
    presetDigest:
      presetDigest ??
      catalog.sources.find(({ kind, id }) => kind === "ServingPreset" && id === preset.metadata.id)!
        .digest,
    recipeDigest: catalog.sources.find(
      ({ kind, id }) => kind === "ServingRecipe" && id === RECIPE_ID,
    )!.digest,
    recipeId: RECIPE_ID,
  });
  loadOrCreateManagedLlamaCppApiKey(paths);
}

function publishState(homeDir: string, runtimeEngine: ContainerEngine): void {
  reserveState(homeDir);
  const paths = managedLlamaCppStatePaths(homeDir);
  const engineAuthority = {
    schemaVersion: 1 as const,
    providerId: "docker",
    operation: "host-local-inference" as const,
    engineId: "docker",
    authorityId: runtimeEngine.authorityId,
    bindingSha256: managedLlamaCppBindingSha256(runtimeEngine),
  };
  const serialized = serializeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: "docker",
    service: "llama-cpp",
    engineAuthority,
    endpoint: {
      host: "host.openshell.internal",
      port: 8081,
      networkName: MANAGED_LLAMA_CPP_NETWORK_NAME,
    },
    runtime: {
      kind: "container",
      runtimeId: RUNTIME_ID,
      name: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      imageRef: IMAGE,
      probeImageRef: `nvcr.io/nvidia/vllm@sha256:${"8".repeat(64)}`,
      specSha256: SPEC_SHA256,
      model: {
        planDigest: `sha256:${"9".repeat(64)}`,
        recipeId: RECIPE_ID,
        generation: TRANSACTION_ID,
        digest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 64,
      },
      gpu: { vendor: "nvidia", count: 1 },
    },
  });
  const writer = createManagedLlamaCppReceiptWriter(paths, TRANSACTION_ID);
  const journal = createHostLocalCreateJournalStore(paths.stateDir);
  journal.create({
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    phase: "prepared",
    providerId: "docker",
    service: "llama-cpp",
    containerName: MANAGED_LLAMA_CPP_CONTAINER_NAME,
    runtimeId: null,
    createIntentUnixMs: null,
    specSha256: SPEC_SHA256,
    networkId: NETWORK_ID,
    apiKeyIdentitySha256: "b".repeat(64),
    apiKeyRootIdentitySha256: "c".repeat(64),
    engineAuthority,
    receiptTargetSha256: writer.targetSha256,
    serializedReceipt: null,
    receiptSha256: null,
  });
  journal.recordCreating(TRANSACTION_ID, Date.now());
  journal.recordCreated(TRANSACTION_ID, RUNTIME_ID);
  journal.recordStarted(TRANSACTION_ID);
  journal.prepareReceipt(TRANSACTION_ID, serialized);
  writer.writeExact(serialized);
  journal.finalize(TRANSACTION_ID);
}

describe("managed llama.cpp status", () => {
  it("reports reserved ownership without a receipt as preparing", () => {
    const homeDir = temporaryHome();
    reserveState(homeDir);

    expect(inspectManagedLlamaCppStatus("spark-agent", { homeDir })).toEqual({
      recipeId: RECIPE_ID,
      modelDigest: null,
      imageReference: null,
      endpoint: "https://inference.local/v1",
      state: "preparing",
      detail: "ownership is reserved; no finalized runtime receipt is published",
    });
  });

  it("revalidates the selected preset when multiple presets share one recipe (#8144)", () => {
    const homeDir = temporaryHome();
    reserveState(homeDir, GENERIC_PRESET_ID);

    expect(inspectManagedLlamaCppStatus("spark-agent", { homeDir })).toEqual({
      recipeId: RECIPE_ID,
      modelDigest: null,
      imageReference: null,
      endpoint: "https://inference.local/v1",
      state: "preparing",
      detail: "ownership is reserved; no finalized runtime receipt is published",
    });
  });

  it("rejects an unrecognized preset digest before Docker inspection (#8144)", () => {
    const homeDir = temporaryHome();
    reserveState(homeDir, GENERIC_PRESET_ID, `sha256:${"f".repeat(64)}`);
    const capture = vi.fn();

    expect(
      inspectManagedLlamaCppStatus("spark-agent", { homeDir, engine: engine(capture) }),
    ).toMatchObject({
      state: "unknown",
      detail: "Managed llama.cpp recipe authority changed; rerun onboarding.",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports the exact receipt-bound container as absent without further inspection", () => {
    const inspectExact = vi.fn();
    const probe = vi.fn();
    const runtimeEngine = engine(
      vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: `Error response from daemon: No such container: ${RUNTIME_ID}`,
      })),
    );
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
        inspectExact,
        probe,
      }),
    ).toMatchObject({ state: "absent", detail: "the exact managed container is absent" });
    expect(inspectExact).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports an exact stopped runtime without probing readiness", () => {
    const inspectExact = vi.fn(() => ({ running: false, receipt: {} as never }));
    const probe = vi.fn();
    const runtimeEngine = engine(vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })));
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
        inspectExact,
        probe,
      }),
    ).toMatchObject({ state: "stopped", detail: "exact managed container is stopped" });
    expect(inspectExact).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not classify a different missing container as the receipt-bound absence", () => {
    const runtimeEngine = engine(
      vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: No such container: foreign-runtime",
      })),
    );
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", { homeDir, engine: runtimeEngine }),
    ).toMatchObject({
      state: "unknown",
      detail: "Docker inspection failed",
    });
  });

  it("reports exact secret-free runtime identity and running state", () => {
    const inspectExact = vi.fn<NonNullable<ManagedLlamaCppStatusOptions["inspectExact"]>>(() => ({
      running: true,
      receipt: {} as never,
    }));
    const capturedInspections = {
      network: {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            Driver: "bridge",
            Id: NETWORK_ID,
            Internal: true,
            Labels: { [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE },
            Name: MANAGED_LLAMA_CPP_NETWORK_NAME,
            Scope: "local",
          },
        ]),
      },
      container: {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            Id: RUNTIME_ID,
            Name: `/${MANAGED_LLAMA_CPP_CONTAINER_NAME}`,
            Config: {
              Image: IMAGE,
              Labels: {
                [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
                "io.nvidia.nemoclaw.host-local-inference.managed": "true",
                "io.nvidia.nemoclaw.host-local-inference.provider": "docker",
                "io.nvidia.nemoclaw.host-local-inference.service": "llama-cpp",
                "io.nvidia.nemoclaw.host-local-inference.spec-sha256": SPEC_SHA256,
                "io.nvidia.nemoclaw.host-local-inference.transaction-sha256": TRANSACTION_ID,
                "io.nvidia.nemoclaw.llama-cpp.recipe": RECIPE_ID,
              },
            },
            HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
            State: { Running: true },
          },
        ]),
      },
    } as const;
    const capture = vi.fn((args: readonly string[]) => {
      return capturedInspections[args[0] as keyof typeof capturedInspections];
    });
    const runtimeEngine = engine(capture);
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
        inspectExact,
        probe: vi.fn(() => ({ ok: true as const, model: "nvidia-nemotron" })),
      }),
    ).toEqual({
      recipeId: RECIPE_ID,
      modelDigest: `sha256:${"a".repeat(64)}`,
      imageReference: IMAGE,
      endpoint: "https://inference.local/v1",
      state: "running",
      detail: "exact managed container is running and ready",
    });
    expect(inspectExact).toHaveBeenCalledOnce();
    expect(inspectExact.mock.calls[0]?.[0]).toMatchObject({
      homeDir,
      operation: { engine: runtimeEngine },
      paths: managedLlamaCppStatePaths(homeDir),
    });
  });

  it("reports invalid Docker authority construction as a conflict", () => {
    const runtimeEngine = engine(vi.fn());
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        env: { DOCKER_CONTEXT: " invalid-context" },
      }),
    ).toMatchObject({
      state: "conflict",
      detail: "Managed llama.cpp DOCKER_CONTEXT is invalid.",
    });
  });

  it("reports a thrown Docker inspection as a conflict", () => {
    const runtimeEngine = engine(
      vi.fn(() => {
        throw new Error("qualified Docker endpoint changed");
      }),
    );
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
      }),
    ).toMatchObject({
      state: "conflict",
      detail: "qualified Docker endpoint changed",
    });
  });

  it("reports malformed API-key state as unknown", () => {
    const runtimeEngine = engine(vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })));
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);
    fs.writeFileSync(managedLlamaCppStatePaths(homeDir).apiKeyPath, "malformed\n", {
      mode: 0o600,
    });

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
        inspectExact: vi.fn(() => ({ running: true, receipt: {} as never })),
      }),
    ).toMatchObject({
      state: "unknown",
      detail: "Managed llama.cpp API-key state is malformed.",
    });
  });

  it("reports a thrown readiness probe as unknown without exposing its error", () => {
    const runtimeEngine = engine(vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })));
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);

    expect(
      inspectManagedLlamaCppStatus("spark-agent", {
        homeDir,
        engine: runtimeEngine,
        inspectExact: vi.fn(() => ({ running: true, receipt: {} as never })),
        probe: vi.fn(() => {
          throw new Error("secret-bearing transport detail");
        }),
      }),
    ).toMatchObject({
      state: "unknown",
      detail: "managed llama.cpp readiness probe failed unexpectedly",
    });
  });

  it("reports lifecycle inspection drift as a conflict before readiness probing", () => {
    const runtimeEngine = engine(
      vi.fn(() => ({ status: 0, stderr: "", stdout: "not trusted by status" })),
    );
    const homeDir = temporaryHome();
    publishState(homeDir, runtimeEngine);
    const probe = vi.fn();

    const status = inspectManagedLlamaCppStatus("spark-agent", {
      homeDir,
      engine: runtimeEngine,
      inspectExact: vi.fn(() => {
        throw new Error("Docker llama.cpp container does not match its exact journal authority.");
      }),
      probe,
    });

    expect(status).toMatchObject({ state: "conflict", detail: expect.stringContaining("exact") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses to inspect through a different Docker authority", () => {
    const original = engine(vi.fn());
    const homeDir = temporaryHome();
    publishState(homeDir, original);
    const foreignCapture = vi.fn();

    const status = inspectManagedLlamaCppStatus("spark-agent", {
      homeDir,
      engine: engine(foreignCapture, "docker:foreign"),
    });

    expect(status).toMatchObject({ state: "conflict" });
    expect(foreignCapture).not.toHaveBeenCalled();
  });
});
