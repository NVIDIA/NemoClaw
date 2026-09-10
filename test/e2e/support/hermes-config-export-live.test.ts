// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  load: vi.fn(),
  readSandboxPolicy: vi.fn(),
  save: vi.fn(),
  validateNemoClawConfig: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("../../../src/lib/state/registry/persistence.ts", () => ({
  load: mocks.load,
  save: mocks.save,
}));

vi.mock("../../../src/lib/adapters/openshell/sandbox-policy-cli.ts", () => ({
  namedOpenShellGateway: (name: string) => ({ kind: "named", name }),
  syncCliOpenShellSandboxPolicyReader: { readSandboxPolicy: mocks.readSandboxPolicy },
}));

vi.mock("../../../src/lib/config/schema.ts", () => ({
  validateNemoClawConfig: mocks.validateNemoClawConfig,
}));

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
  verifyHermesConfigExportLive,
} from "../fixtures/hermes-config-export-live.ts";

const IMAGE_REF = "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({
    sandboxes: {
      hermes: {
        credentialEnv: "NVIDIA_API_KEY",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        gatewayName: "nemoclaw",
        workload: { kind: "managed-image", reference: IMAGE_REF },
      },
    },
  });
  mocks.readSandboxPolicy.mockReturnValue({ ok: false });
  mocks.validateNemoClawConfig.mockReturnValue({
    spec: {
      inferenceProviders: [
        {
          credential: { env: "NVIDIA_API_KEY" },
          endpoint: "https://integrate.api.nvidia.com/v1",
        },
      ],
      sandboxes: [
        {
          agents: [{ type: "hermes" }],
          name: "hermes",
          network: { policy: { explicit: null } },
          runtime: { image: { ref: IMAGE_REF } },
        },
      ],
    },
  });
});

function passingEvidence(): HermesConfigExportLiveEvidence {
  return {
    agent: "hermes",
    aliasesEquivalent: true,
    checked: true,
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    immutableManagedImageMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    sandboxNameMatches: true,
  };
}

async function runEnabledFixture(redactionValues: readonly string[] = []) {
  let dispose: (() => void) | undefined;
  try {
    return await verifyHermesConfigExportLive({
      artifacts: { writeJson: mocks.writeJson },
      cleanup: {
        trackDisposable: (_description: string, cleanup: () => void) => {
          dispose = cleanup;
        },
      },
      enabled: true,
      env: {},
      host: { command: mocks.command },
      redactionValues,
      sandboxName: "hermes",
    } as unknown as Parameters<typeof verifyHermesConfigExportLive>[0]);
  } finally {
    dispose?.();
  }
}

describe("Hermes config export live evidence", () => {
  it("accepts the complete redacted export contract", () => {
    expect(passesHermesConfigExportLiveEvidence(passingEvidence())).toBe(true);
  });

  it.each([
    "aliasesEquivalent",
    "credentialReferenceMatches",
    "credentialValuesOmitted",
    "identityDriftPreventedPublication",
    "identityDriftReported",
    "immutableManagedImageMatches",
    "inferenceEndpointMatches",
    "launchersSucceeded",
    "policyMatches",
    "sandboxNameMatches",
  ] as const)("rejects evidence when %s is false", (field) => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), [field]: false })).toBe(
      false,
    );
  });

  it("rejects evidence for a different agent", () => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), agent: "openclaw" })).toBe(
      false,
    );
  });

  it("records failed evidence before parsing when a launcher fails", async () => {
    mocks.command
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        fs.writeFileSync(outputPath, "secret-value");
        return { exitCode: 0, stderr: "", stdout: "" };
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "failed", stdout: "" });
    const result = await runEnabledFixture(["secret-value"]);

    expect(result).toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        checked: true,
        credentialValuesOmitted: false,
        launchersSucceeded: false,
      }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.validateNemoClawConfig).not.toHaveBeenCalled();
  });

  it("rejects drift evidence when only one launcher reports identity drift (#11286)", async () => {
    const writeExport = async (_command: string, args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, "{}");
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValueOnce({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "launcher failed", stdout: "" });

    const result = await runEnabledFixture();

    expect(result).toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        identityDriftPreventedPublication: true,
        identityDriftReported: false,
      }),
    );
  });
});
