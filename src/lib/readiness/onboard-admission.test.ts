// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateOnboardGatewayReadinessAdmission,
  evaluateOnboardReadinessAdmission,
  hasExplicitDeferredN1xOnboardingIntent,
  ONBOARD_READINESS_ADMISSION_REASON_IDS,
  ONBOARD_READINESS_FINDING_IDS,
  ONBOARD_REQUIRED_CAPABILITY_IDS,
  type OnboardReadinessAdmissionOptions,
} from "./onboard-admission";
import type {
  ReadinessCapability,
  ReadinessFinding,
  ReadinessObservation,
  SystemReadinessReport,
} from "./types";

const DEFAULT_OPTIONS: OnboardReadinessAdmissionOptions = {
  explicitlyOptedOutGpuPassthrough: false,
  allowUnsupportedRuntime: false,
  allowStorageRemediation: true,
};

describe("Deferred N1x onboarding intent", () => {
  it.each([
    ["managed-vLLM", { NEMOCLAW_PROVIDER: "install-vllm" }, true],
    ["ordinary onboarding", { NEMOCLAW_NO_EXPRESS: "1" }, true],
    ["a standard provider", { NEMOCLAW_PROVIDER: "ollama" }, true],
    ["a normalized provider alias", { NEMOCLAW_PROVIDER: " Open-Router " }, true],
    ["an unknown provider", { NEMOCLAW_PROVIDER: "unknown-provider" }, false],
    ["the excluded NIM provider", { NEMOCLAW_PROVIDER: "nim-local" }, false],
    ["the excluded NIM alias", { NEMOCLAW_PROVIDER: "nim" }, false],
    [
      "the excluded NIM provider with Express disabled",
      { NEMOCLAW_PROVIDER: "nim-local", NEMOCLAW_NO_EXPRESS: "1" },
      false,
    ],
    ["an unsupported opt-out value", { NEMOCLAW_NO_EXPRESS: "true" }, false],
    ["no intent", {}, false],
  ] as const)("recognizes %s (#11041)", (_scenario, env, expected) => {
    expect(hasExplicitDeferredN1xOnboardingIntent(env)).toBe(expected);
  });
});

function capability(id: string, state: ReadinessCapability["state"]): ReadinessCapability {
  return { id, state };
}

function finding(
  id: string,
  severity: ReadinessFinding["severity"] = "blocking",
): ReadinessFinding {
  return { id, severity, summary: id };
}

function requiredCapabilities(): ReadinessCapability[] {
  return [
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable, "absent"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaGpuAvailable, "absent"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaContainerToolkitAvailable, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaCdiHealthy, "present"),
    capability(ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported, "present"),
  ];
}

function gatewayCapabilities(
  overrides: Partial<Record<string, ReadinessCapability["state"]>> = {},
): ReadinessCapability[] {
  return [
    ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAuthorityResolved,
    ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAttachmentValid,
    ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayReuseReady,
    ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayVersionCompatible,
    ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayPortUncontested,
  ].map((id) => capability(id, overrides[id] ?? "present"));
}

function report(
  overrides: {
    capabilities?: ReadinessCapability[];
    findings?: ReadinessFinding[];
    observations?: ReadinessObservation[];
    status?: SystemReadinessReport["status"];
  } = {},
): SystemReadinessReport {
  const status = overrides.status ?? "supported";
  const outcome =
    status === "supported"
      ? ({ status, exitCode: 0 } as const)
      : status === "incompatible"
        ? ({ status, exitCode: 2 } as const)
        : ({ status, exitCode: 3 } as const);
  return {
    schemaVersion: "1.1.0",
    ...outcome,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: "2026-08-07T12:00:00.000Z",
    },
    observations: overrides.observations ?? [],
    capabilities: overrides.capabilities ?? requiredCapabilities(),
    qualifications: [],
    findings: overrides.findings ?? [],
    evidence: [],
  };
}

function withCapabilityState(
  capabilities: ReadinessCapability[],
  id: string,
  state: ReadinessCapability["state"],
): ReadinessCapability[] {
  return capabilities.map((entry) => (entry.id === id ? { ...entry, state } : entry));
}

describe("onboarding readiness admission (#7411)", () => {
  it("admits known required capabilities without relying on the report status", () => {
    expect(
      evaluateOnboardReadinessAdmission(report({ status: "inconclusive" }), DEFAULT_OPTIONS),
    ).toEqual({ admitted: true, waivedFindingIds: [] });
  });

  it("fails on every unwaived blocking or fatal finding and retains report order", () => {
    const decision = evaluateOnboardReadinessAdmission(
      report({
        status: "incompatible",
        findings: [
          finding("host.example.warning", "warning"),
          finding("host.example.blocked"),
          finding("host.example.fatal", "fatal"),
        ],
      }),
      DEFAULT_OPTIONS,
    );

    expect(decision).toEqual({
      admitted: false,
      reasonIds: [ONBOARD_READINESS_ADMISSION_REASON_IDS.blockingFindings],
      findingIds: ["host.example.blocked", "host.example.fatal"],
      capabilityIds: [],
      waivedFindingIds: [],
    });
  });

  it("waives only the known NVIDIA blockers for explicit CPU-only intent", () => {
    const capabilities = withCapabilityState(
      withCapabilityState(
        withCapabilityState(
          requiredCapabilities(),
          ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaGpuAvailable,
          "unknown",
        ),
        ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaContainerToolkitAvailable,
        "unknown",
      ),
      ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaCdiHealthy,
      "unknown",
    );
    const gpuFindings = [
      finding(ONBOARD_READINESS_FINDING_IDS.containerToolkitMissing),
      finding(ONBOARD_READINESS_FINDING_IDS.cdiMissing),
      finding(ONBOARD_READINESS_FINDING_IDS.cdiStale),
      finding(ONBOARD_READINESS_FINDING_IDS.nvidiaRuntimeMissing),
    ];

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: gpuFindings, status: "incompatible" }),
        { ...DEFAULT_OPTIONS, explicitlyOptedOutGpuPassthrough: true },
      ),
    ).toEqual({
      admitted: true,
      waivedFindingIds: gpuFindings.map(({ id }) => id),
    });

    expect(
      evaluateOnboardReadinessAdmission(
        report({
          capabilities,
          findings: [...gpuFindings, finding("host.example.blocked")],
          status: "incompatible",
        }),
        { ...DEFAULT_OPTIONS, explicitlyOptedOutGpuPassthrough: true },
      ),
    ).toMatchObject({ admitted: false, findingIds: ["host.example.blocked"] });

    expect(
      evaluateOnboardReadinessAdmission(
        report({
          capabilities,
          findings: [finding(ONBOARD_READINESS_FINDING_IDS.nvidiaRuntimeMissing)],
          status: "incompatible",
        }),
        DEFAULT_OPTIONS,
      ),
    ).toMatchObject({
      admitted: false,
      findingIds: [ONBOARD_READINESS_FINDING_IDS.nvidiaRuntimeMissing],
    });
  });

  it("waives a known unsupported runtime only for the explicit portable profile", () => {
    const capabilities = withCapabilityState(
      requiredCapabilities(),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
      "absent",
    );
    const runtimeFinding = finding(ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported);

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [runtimeFinding], status: "incompatible" }),
        { ...DEFAULT_OPTIONS, allowUnsupportedRuntime: true },
      ),
    ).toEqual({
      admitted: true,
      waivedFindingIds: [ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported],
    });
    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [runtimeFinding], status: "incompatible" }),
        DEFAULT_OPTIONS,
      ),
    ).toMatchObject({
      admitted: false,
      findingIds: [ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported],
    });
  });

  it("does not let the portable exception hide an unknown runtime", () => {
    const capabilities = withCapabilityState(
      requiredCapabilities(),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
      "unknown",
    );

    expect(
      evaluateOnboardReadinessAdmission(report({ capabilities }), {
        ...DEFAULT_OPTIONS,
        allowUnsupportedRuntime: true,
      }),
    ).toEqual({
      admitted: false,
      reasonIds: [ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown],
      findingIds: [],
      capabilityIds: [ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported],
      waivedFindingIds: [],
    });
  });

  it("defers standard Docker readiness only to a selected provider-owned host route", () => {
    const capabilities = [
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
    ].reduce((current, id) => withCapabilityState(current, id, "unknown"), requiredCapabilities());
    const dockerFindings = [
      finding(ONBOARD_READINESS_FINDING_IDS.dockerUnavailable),
      finding(ONBOARD_READINESS_FINDING_IDS.dockerHostInvalid),
      finding(ONBOARD_READINESS_FINDING_IDS.dockerDaemonUnreachable),
      finding(ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported),
      finding(ONBOARD_READINESS_FINDING_IDS.storageIncompatible),
    ];

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: dockerFindings, status: "incompatible" }),
        { ...DEFAULT_OPTIONS, providerOwnsHostReadiness: true },
      ),
    ).toEqual({
      admitted: true,
      waivedFindingIds: dockerFindings.map(({ id }) => id),
    });

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: dockerFindings, status: "incompatible" }),
        DEFAULT_OPTIONS,
      ),
    ).toMatchObject({
      admitted: false,
      findingIds: dockerFindings.map(({ id }) => id),
    });

    expect(
      evaluateOnboardReadinessAdmission(
        report({
          capabilities,
          findings: [...dockerFindings, finding("host.example.blocked")],
          status: "incompatible",
        }),
        { ...DEFAULT_OPTIONS, providerOwnsHostReadiness: true },
      ),
    ).toMatchObject({ admitted: false, findingIds: ["host.example.blocked"] });
  });

  it.each([
    ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
    ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
    ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
  ])(
    "admits only the pre-mutation facts that portable host preparation can replace [case %#]",
    (id) => {
      let capabilities = withCapabilityState(
        requiredCapabilities(),
        ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
        "absent",
      );

      capabilities = withCapabilityState(capabilities, id, "unknown");

      expect(
        evaluateOnboardReadinessAdmission(
          report({
            capabilities,
            findings: [finding(ONBOARD_READINESS_FINDING_IDS.dockerDaemonUnreachable)],
            status: "incompatible",
          }),
          { ...DEFAULT_OPTIONS, allowPortableHostPreparation: true },
        ),
      ).toEqual({
        admitted: true,
        waivedFindingIds: [ONBOARD_READINESS_FINDING_IDS.dockerDaemonUnreachable],
      });

      expect(
        evaluateOnboardReadinessAdmission(
          report({
            capabilities: withCapabilityState(
              capabilities,
              ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
              "absent",
            ),
            findings: [finding("host.docker.unavailable")],
            status: "incompatible",
          }),
          { ...DEFAULT_OPTIONS, allowPortableHostPreparation: true },
        ),
      ).toMatchObject({ admitted: false, findingIds: ["host.docker.unavailable"] });
    },
  );

  it("admits the documented storage exception only when remediation is present", () => {
    let capabilities = withCapabilityState(
      requiredCapabilities(),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
      "absent",
    );
    capabilities = withCapabilityState(
      capabilities,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
      "present",
    );
    const storageFinding = finding(ONBOARD_READINESS_FINDING_IDS.storageIncompatible);

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [storageFinding], status: "incompatible" }),
        DEFAULT_OPTIONS,
      ),
    ).toEqual({
      admitted: true,
      waivedFindingIds: [ONBOARD_READINESS_FINDING_IDS.storageIncompatible],
    });
    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [storageFinding], status: "incompatible" }),
        { ...DEFAULT_OPTIONS, allowStorageRemediation: false },
      ),
    ).toMatchObject({
      admitted: false,
      findingIds: [ONBOARD_READINESS_FINDING_IDS.storageIncompatible],
    });
  });

  it("accepts present storage remediation when direct compatibility is unknown", () => {
    let capabilities = withCapabilityState(
      requiredCapabilities(),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
      "unknown",
    );
    capabilities = withCapabilityState(
      capabilities,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
      "present",
    );

    expect(evaluateOnboardReadinessAdmission(report({ capabilities }), DEFAULT_OPTIONS)).toEqual({
      admitted: true,
      waivedFindingIds: [],
    });
  });

  it("admits only explicit managed-vLLM intent through the Deferred N1x validation gate (#8574)", () => {
    const capabilities = [
      ...withCapabilityState(
        requiredCapabilities(),
        ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported,
        "absent",
      ),
      capability("host.platform.n1x", "present"),
    ];
    const pending = finding(ONBOARD_READINESS_FINDING_IDS.n1xValidationPending);

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [pending], status: "incompatible" }),
        DEFAULT_OPTIONS,
      ),
    ).toMatchObject({ admitted: false, findingIds: [pending.id] });
    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [pending], status: "incompatible" }),
        { ...DEFAULT_OPTIONS, allowDeferredN1xManagedVllm: true },
      ),
    ).toEqual({ admitted: true, waivedFindingIds: [pending.id] });
    expect(
      evaluateOnboardReadinessAdmission(report({ findings: [pending], status: "incompatible" }), {
        ...DEFAULT_OPTIONS,
        allowDeferredN1xManagedVllm: true,
      }),
    ).toMatchObject({ admitted: false, findingIds: [pending.id] });
  });

  it("fails closed when a required capability is unknown or missing", () => {
    const capabilities = withCapabilityState(
      requiredCapabilities().filter(
        ({ id }) => id !== ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported,
      ),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
      "unknown",
    );

    expect(evaluateOnboardReadinessAdmission(report({ capabilities }), DEFAULT_OPTIONS)).toEqual({
      admitted: false,
      reasonIds: [ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown],
      findingIds: [],
      capabilityIds: [
        ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
        ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported,
      ],
      waivedFindingIds: [],
    });
  });

  it("reports both stable failure reasons when blockers and unknown requirements coexist", () => {
    const capabilities = withCapabilityState(
      requiredCapabilities(),
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
      "unknown",
    );

    expect(
      evaluateOnboardReadinessAdmission(
        report({ capabilities, findings: [finding("host.example.blocked")] }),
        DEFAULT_OPTIONS,
      ),
    ).toEqual({
      admitted: false,
      reasonIds: [
        ONBOARD_READINESS_ADMISSION_REASON_IDS.blockingFindings,
        ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown,
      ],
      findingIds: ["host.example.blocked"],
      capabilityIds: [ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable],
      waivedFindingIds: [],
    });
  });

  it("fails the gateway-only boundary on blockers and inconclusive required facts", () => {
    expect(
      evaluateOnboardGatewayReadinessAdmission({
        observations: [],
        capabilities: gatewayCapabilities({
          [ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayPortUncontested]: "unknown",
        }),
        findings: [finding("gateway.ownership.multiple")],
      }),
    ).toEqual({
      admitted: false,
      reasonIds: [
        ONBOARD_READINESS_ADMISSION_REASON_IDS.blockingFindings,
        ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown,
      ],
      findingIds: ["gateway.ownership.multiple"],
      capabilityIds: [ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayPortUncontested],
      waivedFindingIds: [],
    });
  });

  it("waives version drift only for the managed gateway reconciliation path", () => {
    const versionDrift = finding(ONBOARD_READINESS_FINDING_IDS.gatewayVersionDrift);
    const managed = {
      observations: [
        {
          id: "gateway.management.mode",
          state: "present" as const,
          value: "nemoclaw-managed",
        },
      ],
      capabilities: gatewayCapabilities(),
      findings: [versionDrift],
    };

    expect(evaluateOnboardGatewayReadinessAdmission(managed)).toEqual({
      admitted: true,
      waivedFindingIds: [ONBOARD_READINESS_FINDING_IDS.gatewayVersionDrift],
    });
    expect(
      evaluateOnboardGatewayReadinessAdmission({
        ...managed,
        observations: [
          {
            id: "gateway.management.mode",
            state: "present",
            value: "externally-supervised",
          },
        ],
      }),
    ).toMatchObject({
      admitted: false,
      findingIds: [ONBOARD_READINESS_FINDING_IDS.gatewayVersionDrift],
    });
  });

  it("requires every gateway capability once the public projection is present", () => {
    const capabilities = [
      ...requiredCapabilities(),
      ...gatewayCapabilities({
        [ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAttachmentValid]: "unknown",
      }),
    ];

    expect(evaluateOnboardReadinessAdmission(report({ capabilities }), DEFAULT_OPTIONS)).toEqual({
      admitted: false,
      reasonIds: [ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown],
      findingIds: [],
      capabilityIds: [ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAttachmentValid],
      waivedFindingIds: [],
    });
  });
});
