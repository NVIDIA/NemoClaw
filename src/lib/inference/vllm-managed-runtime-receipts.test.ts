// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { nemoclawStateRoot } from "../state/state-root";
import { createProductionManagedClusterDiscoveryDeps } from "./serving/managed-cluster-discovery-production";
import { managedClusterVllmRuntimeReceiptPath } from "./serving/managed-cluster-runtime-receipt";
import {
  assertNoManagedDistributedVllmRuntimeReceipts,
  findManagedDistributedVllmRuntimeReceipts,
} from "./serving/managed-runtime-receipts";
import { dualStationVllmRuntimeReceiptPath } from "./vllm-station-runtime-receipt";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-receipts-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "stale\n", { mode: 0o600 });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const homeDir of temporaryHomes.splice(0)) fs.rmSync(homeDir, { recursive: true });
});

describe("managed distributed vLLM receipt preflight", () => {
  it("allows installation when no durable distributed receipt exists", () => {
    expect(() =>
      assertNoManagedDistributedVllmRuntimeReceipts({ homeDir: temporaryHome() }),
    ).not.toThrow();
  });

  it("blocks a host-global managed cluster receipt without parsing stale contents", () => {
    const homeDir = temporaryHome();
    const receiptPath = managedClusterVllmRuntimeReceiptPath(
      nemoclawStateRoot(homeDir, DEFAULT_GATEWAY_PORT),
    );
    touch(receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir })).toEqual({
      managedClusterBindingPaths: [],
      managedClusterDiscoveryBindingPaths: [],
      managedClusterPath: receiptPath,
      stationBindingPaths: [],
      stationPaths: [],
    });
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(
      "recover it through Local vLLM",
    );
  });

  it("blocks Station receipts across safely enumerated gateway roots", () => {
    const homeDir = temporaryHome();
    const receiptPath = dualStationVllmRuntimeReceiptPath(nemoclawStateRoot(homeDir, 18080));
    touch(receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir }).stationPaths).toEqual([
      receiptPath,
    ]);
  });

  it.each([
    { topology: "Spark", gatewayPort: DEFAULT_GATEWAY_PORT },
    { topology: "Station", gatewayPort: 18080 },
  ])("blocks an orphaned $topology SSH binding tree", ({ topology, gatewayPort }) => {
    const homeDir = temporaryHome();
    const stateRoot = nemoclawStateRoot(homeDir, gatewayPort);
    const receiptPath =
      topology === "Spark"
        ? managedClusterVllmRuntimeReceiptPath(stateRoot)
        : dualStationVllmRuntimeReceiptPath(stateRoot);
    const bindingPath =
      topology === "Spark" ? `${receiptPath}.rank-1.ssh-binding` : `${receiptPath}.ssh-binding`;
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });

    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(bindingPath);
  });

  it("blocks an orphaned managed cluster discovery binding claim", () => {
    const homeDir = temporaryHome();
    const bindingPath = path.join(
      nemoclawStateRoot(homeDir),
      "managed-cluster-managed-serving.json.spark-worker.ssh-binding",
    );
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });

    expect(
      findManagedDistributedVllmRuntimeReceipts({ homeDir }).managedClusterDiscoveryBindingPaths,
    ).toEqual([bindingPath]);
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(bindingPath);
  });

  it("enumerates every ranked runtime binding and per-node discovery claim", () => {
    const homeDir = temporaryHome();
    const stateRoot = nemoclawStateRoot(homeDir);
    const runtimeBindings = [
      "managed-cluster-vllm-runtime.json.rank-1.ssh-binding",
      "managed-cluster-vllm-runtime.json.rank-2.ssh-binding",
    ].map((entry) => path.join(stateRoot, entry));
    const discoveryBindings = [
      "managed-cluster-managed-serving.json.node-a.ssh-binding",
      "managed-cluster-managed-serving.json.node-b.ssh-binding",
    ].map((entry) => path.join(stateRoot, entry));
    [...runtimeBindings, ...discoveryBindings].forEach((bindingPath) => {
      fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });
    });

    const receipts = findManagedDistributedVllmRuntimeReceipts({ homeDir });
    expect(receipts.managedClusterBindingPaths).toEqual(runtimeBindings);
    expect(receipts.managedClusterDiscoveryBindingPaths).toEqual(discoveryBindings);
  });

  it("places each production cluster discovery claim in the scanner-visible gateway root", () => {
    const homeDir = temporaryHome();
    vi.stubEnv("HOME", homeDir);
    const deps = createProductionManagedClusterDiscoveryDeps(() => {
      throw new Error("unexpected host probe");
    });

    expect(deps.resolveBindingStatePath("spark-worker")).toBe(
      path.join(nemoclawStateRoot(homeDir), "managed-cluster-managed-serving.json.spark-worker"),
    );
  });

  it("treats a receipt symlink as existing without following it", () => {
    const homeDir = temporaryHome();
    const receiptPath = managedClusterVllmRuntimeReceiptPath(nemoclawStateRoot(homeDir));
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.symlinkSync(path.join(homeDir, "missing-target"), receiptPath);

    expect(findManagedDistributedVllmRuntimeReceipts({ homeDir }).managedClusterPath).toBe(
      receiptPath,
    );
    expect(() => assertNoManagedDistributedVllmRuntimeReceipts({ homeDir })).toThrow(
      "Managed vLLM runtime state already exists",
    );
  });
});
