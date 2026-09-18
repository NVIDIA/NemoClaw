// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";
import YAML from "yaml";
import { runConfigExport } from "../../src/lib/actions/config/export";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../src/lib/config/model";
import type { SandboxEntry } from "../../src/lib/state/registry/types";
import { load as loadRegistry } from "../../src/lib/state/registry/persistence";
import { getSandboxEntryInference } from "../../src/lib/state/registry-entry-view";
import { connectManagedOpenShellSdk } from "../../src/lib/adapters/openshell/sdk";
import { captureSanitizedResolvedOpenshell } from "../../src/lib/adapters/openshell/sanitized-capture";
import { observeStableExportSource } from "../../src/lib/actions/config/observe-export-source";
import { createLiveExportSnapshotReader } from "../../src/lib/adapters/config/live-export-source";
import {
  entry,
  provider,
  inventory,
  configuration,
} from "../../src/lib/adapters/config/live-export-source-test-fixture";

vi.mock("../../src/lib/inference/serving/vllm-export-runtime", () => ({
  observeManagedVllmForExport: vi.fn(),
}));
vi.mock("../../src/lib/inference/ollama/proxy", () => ({ createOllamaExportProbe: vi.fn() }));
vi.mock("../../src/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/platform")>()),
  isWsl: vi.fn(() => false),
}));
vi.mock("../../src/lib/state/registry/persistence", () => ({ load: vi.fn() }));
vi.mock("../../src/lib/state/registry-entry-view", () => ({ getSandboxEntryInference: vi.fn() }));
vi.mock("../../src/lib/adapters/openshell/sdk", () => ({ connectManagedOpenShellSdk: vi.fn() }));
vi.mock("../../src/lib/adapters/openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshell: vi.fn(),
}));
vi.mock("../../src/lib/adapters/openshell/sandbox-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/adapters/openshell/sandbox-config")>();
  return {
    ...actual,
    createSandboxConfig: () =>
      actual.createSandboxConfig(undefined, async (policy) => YAML.stringify(policy)),
  };
});
vi.mock("../../src/lib/onboard/gateway/state-dir", () => ({
  managedGatewayStateRootOwnershipFailure: vi.fn(() => null),
  resolveGatewayStateDirForPort: vi.fn(() => "/managed/gateway"),
}));

export const raw = {
  getProvider: vi.fn(),
  getProviderProfile: vi.fn(),
  getSandbox: vi.fn(),
  getSandboxConfig: vi.fn(),
};
export function mockSupportedLiveSource(
  policyVersion = 3,
  appliedRevision = 3,
  sourceEntry: SandboxEntry = entry,
): void {
  vi.mocked(loadRegistry).mockReturnValue({
    sandboxes: { alpha: sourceEntry },
    defaultSandbox: null,
  });
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "nvidia-prod",
    model: "model-a",
  });
  vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
    status: 0,
    output: "Gateway inference:\n  Provider: nvidia-prod\n  Model: model-a\n",
  });
  vi.mocked(connectManagedOpenShellSdk).mockResolvedValue({ raw });
  raw.getProvider.mockResolvedValue(provider());
  raw.getSandbox.mockResolvedValue(inventory(7, policyVersion));
  raw.getSandboxConfig.mockResolvedValue(configuration(appliedRevision));
}

export async function exportLiveSource() {
  const writeStdout = vi.fn(async (_yaml: string) => {});
  const publish = vi.fn();
  const result = await runConfigExport(
    {
      sandboxName: "alpha",
      documentName: parseNemoClawConfigDocumentName("alpha"),
      target: { kind: "stdout" },
    },
    {
      observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
      createDocumentUid: () =>
        parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
      writeStdout,
      publish,
    },
  );
  return { result, writeStdout, publish };
}

export function expectExportRefusal(
  exported: Awaited<ReturnType<typeof exportLiveSource>>,
  finding: Readonly<{ field?: string; category: string }>,
) {
  expect(exported.result).toMatchObject({
    ok: false,
    failure: {
      kind: "observation",
      findings: expect.arrayContaining([expect.objectContaining(finding)]),
    },
  });
  expect(exported.writeStdout).not.toHaveBeenCalled();
  expect(exported.publish).not.toHaveBeenCalled();
}
