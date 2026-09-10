// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import type { SandboxEntry } from "../../state/registry/types";
import { createExternalComponentActivationProof, ExternalComponentProofError } from "./proof";

const sandboxId = "sandbox-123";
const policyHash = `sha256:${"a".repeat(64)}`;
const requiredPolicy =
  "version: 1\nnetwork_policies:\n  inference:\n    endpoints:\n      - host: example.test\n";

function fixture() {
  const entry: SandboxEntry = {
    name: "assistant",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId(sandboxId)!,
  };
  const row = {
    id: sandboxId,
    name: "assistant",
    labels: {},
    resource_version: 4,
    created_at: "2026-09-09T00:00:00Z",
    phase: "Ready",
    current_policy_version: 3,
  };
  const inspection = {
    policySource: "sandbox" as "sandbox" | "global",
    effectivePolicy: {
      version: 1,
      network_policies: {
        inference: { endpoints: [{ host: "example.test", port: 443 }] },
      },
    },
    policyIdentity: { hash: policyHash, activeVersion: 3 },
  };
  const deps = {
    getSandbox: vi.fn(() => entry as SandboxEntry | null),
    listSandboxes: vi.fn(() => JSON.stringify([row])),
    inspectPolicy: vi.fn(() => ({
      basePolicyDocument: requiredPolicy,
      gatewayName: "nemoclaw",
      inspection,
    })),
  };
  return { deps, entry, inspection, row };
}

describe("external component activation proof", () => {
  it("binds the durable OpenShell identity to the effective policy (#11340)", () => {
    const { deps } = fixture();

    const proof = createExternalComponentActivationProof("assistant", "nemoclaw", deps);

    expect(proof).toMatchObject({
      gatewayName: "nemoclaw",
      sandboxId,
      sandboxIdentityFingerprint: `sha256:${fingerprintOpenShellSandboxId(sandboxId)}`,
      lifecycleGeneration: "generation-1",
      policySource: "sandbox",
      policyHash,
      policyActiveVersion: 3,
    });
    expect(deps.inspectPolicy).toHaveBeenCalledWith(
      "assistant",
      "verify external component activation policy",
      "nemoclaw",
    );
  });

  it("rejects a mutable-name match with a different durable identity (#11340)", () => {
    const { deps, row } = fixture();
    deps.listSandboxes.mockReturnValue(JSON.stringify([{ ...row, id: "replacement-456" }]));

    expect(() => createExternalComponentActivationProof("assistant", "nemoclaw", deps)).toThrow(
      ExternalComponentProofError,
    );
    expect(deps.inspectPolicy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing registry authority",
      (value: ReturnType<typeof fixture>) => value.deps.getSandbox.mockReturnValue(null),
    ],
    [
      "a different recorded gateway",
      (value: ReturnType<typeof fixture>) => {
        value.entry.gatewayName = "other";
      },
    ],
    [
      "an unsafe lifecycle generation",
      (value: ReturnType<typeof fixture>) => {
        value.entry.lifecycleGeneration = "generation with spaces";
      },
    ],
    [
      "ambiguous list rows",
      (value: ReturnType<typeof fixture>) =>
        value.deps.listSandboxes.mockReturnValue(JSON.stringify([value.row, value.row])),
    ],
    [
      "a policy version mismatch",
      (value: ReturnType<typeof fixture>) => {
        value.inspection.policyIdentity.activeVersion = 4;
      },
    ],
    [
      "global policy authority",
      (value: ReturnType<typeof fixture>) => {
        value.inspection.policySource = "global";
      },
    ],
    [
      "an invalid policy hash",
      (value: ReturnType<typeof fixture>) => {
        value.inspection.policyIdentity.hash = "opaque";
      },
    ],
    [
      "missing required policy",
      (value: ReturnType<typeof fixture>) => {
        value.inspection.effectivePolicy.network_policies.inference.endpoints = [];
      },
    ],
  ])("rejects %s before handoff (#11340)", (_title, mutate) => {
    const value = fixture();
    mutate(value);

    expect(() =>
      createExternalComponentActivationProof("assistant", "nemoclaw", value.deps),
    ).toThrow(ExternalComponentProofError);
  });

  it("rejects identity or policy changes during revalidation (#11340)", () => {
    const { deps, entry } = fixture();
    const proof = createExternalComponentActivationProof("assistant", "nemoclaw", deps);
    entry.lifecycleGeneration = "generation-2";

    expect(() => proof.revalidate("after_activation")).toThrow(ExternalComponentProofError);
  });

  it("replaces inspection details with the bounded proof reason class (#11340)", () => {
    const { deps } = fixture();
    deps.inspectPolicy.mockImplementation(() => {
      throw new Error("component text and /private/activation.sock");
    });

    expect(() => createExternalComponentActivationProof("assistant", "nemoclaw", deps)).toThrow(
      "External component activation proof is unavailable. Reason class: evidence_mismatch.",
    );
  });
});
