// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRoots: vi.fn(),
  readRegistry: vi.fn(),
  createReader: vi.fn(),
}));

vi.mock("../../state/gateway-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/gateway-registry")>()),
  listGatewayStateRoots: mocks.listRoots,
  readGatewayRegistryFile: mocks.readRegistry,
}));
vi.mock("./native-reader", () => ({
  createSupervisedSandboxCommandReader: mocks.createReader,
}));
vi.mock("../sandbox/mcp-bridge-provider-inspection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/mcp-bridge-provider-inspection")>()),
  getMcpProviderInspectionRuntimeSelection: (entry: { name: string }) => ({
    gatewayName: "nemoclaw",
    workspace: entry.name,
  }),
}));

import { collectOperationSnapshot } from "./snapshot";

beforeEach(() => {
  mocks.listRoots.mockReset();
  mocks.readRegistry.mockReset();
  mocks.createReader.mockReset();
  mocks.listRoots.mockReturnValue([{ root: "/unused", gatewayPort: 8080 }]);
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `sandbox${index}`,
        { name: `sandbox${index}`, agent: "unsupported" },
      ]),
    ),
  });
});

function holdObservations() {
  const pending: Array<() => void> = [];
  let active = 0;
  let started = 0;
  let maximumActive = 0;
  mocks.createReader.mockReturnValue({
    read: vi.fn(async () => {
      throw new Error("no sandbox command in this test");
    }),
    observeInferenceRoute: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          pending.push(() => {
            active -= 1;
            reject(new Error("no gateway in this test"));
          });
        }),
    ),
    dispose: vi.fn(),
  });
  return {
    pending,
    get started() {
      return started;
    },
    get maximumActive() {
      return maximumActive;
    },
  };
}

it("bounds concurrent runtime observations across a large inventory (#12859)", async () => {
  const observed = holdObservations();
  const result = collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
  await vi.waitFor(() => expect(observed.started).toBe(4));
  expect(observed.maximumActive).toBe(4);

  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  await vi.waitFor(() => expect(observed.started).toBe(8));
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  await vi.waitFor(() => expect(observed.started).toBe(9));
  observed.pending.shift()?.();
  const snapshot = await result;
  expect(snapshot.configurations).toHaveLength(9);
  expect(observed.started).toBe(9);
  expect(observed.maximumActive).toBe(4);
});

it("marks observations that never start before cancellation (#12859)", async () => {
  const observed = holdObservations();
  const controller = new AbortController();
  const result = collectOperationSnapshot({
    signal: controller.signal,
    deadlineAt: Date.now() + 10_000,
  });
  await vi.waitFor(() => expect(observed.started).toBe(4));
  controller.abort();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();

  const snapshot = await result;
  expect(observed.started).toBe(4);
  expect(snapshot.configurations.slice(4).map((row) => row.agentsStatus)).toEqual(
    Array(5).fill("not_observed"),
  );
  expect(snapshot.collectionStatus).toBe("partial");
});
