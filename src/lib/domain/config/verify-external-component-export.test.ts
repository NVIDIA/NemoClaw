// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entry, snapshot, verify } from "./export-source-test-fixture";

describe("external component export (#11453)", () => {
  const base = snapshot();
  const selection = {
    schemaVersion: 1 as const,
    componentId: "policy-governance",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    sandboxIdentityFingerprint: base.sandbox.fingerprint,
  };
  const gateway = {
    ...base.gateway,
    externalComponent: {
      componentId: "policy-governance",
      schemaVersion: 1 as const,
      registrationMatches: true,
      configurationDigest: "a".repeat(64),
      registrationDigest: "b".repeat(64),
    },
  };
  const value = snapshot({ registry: entry({ externalComponentSelection: selection }), gateway });
  const findings = (source: typeof value) => {
    const result = verify(source);
    return result.kind === "rejected" ? result.findings : [];
  };
  const expectComponentFinding = (source: typeof value, category: string) =>
    expect(findings(source)).toContainEqual(
      expect.objectContaining({
        field: "spec.gateway.externalComponentRef",
        category,
      }),
    );

  it("exports the ID after completed activation for this sandbox", () => {
    const result = verify(value);
    expect(result.kind).toBe("verified");
    expect(result).toMatchObject({
      kind: "verified",
      source: { gateway: { externalComponentRef: "policy-governance" } },
    });
  });

  it("rejects live component configuration without activation evidence", () => {
    expectComponentFinding({ ...value, registry: entry() }, "missing-provenance");
  });

  it("rejects missing and changed gateway configuration", () => {
    expectComponentFinding(
      { ...value, gateway: { ...gateway, externalComponent: null } },
      "drifted",
    );
    expectComponentFinding(
      {
        ...value,
        gateway: {
          ...gateway,
          externalComponent: { ...gateway.externalComponent, registrationMatches: false },
        },
      },
      "drifted",
    );
  });

  it("rejects a different live sandbox identity", () => {
    expectComponentFinding(
      {
        ...value,
        sandbox: {
          ...value.sandbox,
          fingerprint: "0".repeat(64),
        },
      },
      "drifted",
    );
  });

  it("rejects a different lifecycle generation", () => {
    expectComponentFinding(
      {
        ...value,
        registry: entry({
          externalComponentSelection: { ...selection, lifecycleGeneration: "old-generation" },
        }),
      },
      "drifted",
    );
  });

  it("accepts a verified live policy revision after activation", () => {
    const updated = {
      ...value,
      policy: {
        ...value.policy,
        revision: "4",
        document: value.policy.document,
      },
      sandbox: { ...value.sandbox, policyVersion: 4 },
      configuration: {
        ...value.configuration,
        revision: 4,
      },
    };
    expect(verify(updated)).toMatchObject({
      kind: "verified",
      source: { gateway: { externalComponentRef: "policy-governance" } },
    });
  });

  it("refuses version 2 export without requiring a version 1 activation record", () => {
    expectComponentFinding(
      {
        ...value,
        registry: entry(),
        gateway: {
          ...gateway,
          externalComponent: { ...gateway.externalComponent, schemaVersion: 2 },
        },
      },
      "unsupported",
    );
  });
});
