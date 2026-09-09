// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  load: vi.fn(),
  readSandboxPolicy: vi.fn(),
  save: vi.fn(),
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

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
  verifyHermesConfigExportLive,
} from "../fixtures/hermes-config-export-live.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({
    sandboxes: { hermes: { credentialEnv: "NVIDIA_API_KEY", gatewayName: "nemoclaw" } },
  });
  mocks.readSandboxPolicy.mockReturnValue({ ok: false });
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
    let dispose: (() => void) | undefined;
    mocks.command
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        fs.writeFileSync(outputPath, "secret-value");
        return { exitCode: 0, stderr: "", stdout: "" };
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "failed", stdout: "" });
    const result = await verifyHermesConfigExportLive({
      artifacts: { writeJson: mocks.writeJson },
      cleanup: {
        trackDisposable: (_description: string, cleanup: () => void) => {
          dispose = cleanup;
        },
      },
      enabled: true,
      env: {},
      host: { command: mocks.command },
      redactionValues: ["secret-value"],
      sandboxName: "hermes",
    } as unknown as Parameters<typeof verifyHermesConfigExportLive>[0]);
    dispose?.();

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
  });
});
