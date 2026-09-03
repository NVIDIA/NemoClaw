// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import {
  assertHermesContainerImageAuthority,
  assertHermesGpuStartupOutputContract,
  assertHermesManagedWorkloadAuthority,
  HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
} from "../live/hermes-gpu-startup-proof.ts";

const HEALTHY_NEW_GATEWAY = [
  "Starting OpenShell Docker-driver gateway...",
  "Docker-driver gateway is healthy",
].join("\n");
const NON_FALLBACK_DISCLOSURE_CASES = [
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
] as const;
const MANAGED_IMAGE_REFERENCE = `ghcr.io/nvidia/test@sha256:${"a".repeat(64)}`;
const OTHER_MANAGED_IMAGE_REFERENCE = `ghcr.io/nvidia/test@sha256:${"b".repeat(64)}`;
const VALID_MANAGED_AUTHORITY = {
  agent: "hermes",
  contract: { agent: "hermes", reference: MANAGED_IMAGE_REFERENCE },
  profile: { agent: "hermes" },
  receipt: { kind: "managed-image", reference: MANAGED_IMAGE_REFERENCE },
} as unknown as ManagedWorkloadAuthority;

describe("Hermes GPU startup output contract", () => {
  it.each(["native-success", "compatibility-only"] as const)(
    "accepts %s output without legacy Docker container progress text (#9362)",
    (route) => {
      expect(() => assertHermesGpuStartupOutputContract(route, HEALTHY_NEW_GATEWAY)).not.toThrow();
    },
  );

  it("accepts fallback output only with the complete operator disclosure (#9362)", () => {
    const output = [
      HEALTHY_NEW_GATEWAY,
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
      ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
    ].join("\n");

    expect(() =>
      assertHermesGpuStartupOutputContract("compatibility-fallback", output),
    ).not.toThrow();
  });

  it.each(HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS)(
    "rejects fallback output that omits %s (#9362)",
    (missingFragment) => {
      const output = [
        HEALTHY_NEW_GATEWAY,
        "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
        ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS.filter(
          (fragment) => fragment !== missingFragment,
        ),
      ].join("\n");

      expect(() =>
        assertHermesGpuStartupOutputContract("compatibility-fallback", output),
      ).toThrow();
    },
  );

  it.each(NON_FALLBACK_DISCLOSURE_CASES)(
    "rejects fallback disclosure in %s output: %s (#9362)",
    (route, fragment) => {
      expect(() =>
        assertHermesGpuStartupOutputContract(route, `${HEALTHY_NEW_GATEWAY}\n${fragment}`),
      ).toThrow();
    },
  );
});

describe("Hermes GPU managed-image authority proof", () => {
  it("accepts one immutable authority shared by the registry, contract, and receipt (#9362)", () => {
    expect(
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        MANAGED_IMAGE_REFERENCE,
        VALID_MANAGED_AUTHORITY,
      ),
    ).toBe(MANAGED_IMAGE_REFERENCE);
  });

  it("rejects a missing managed workload authority (#9362)", () => {
    expect(() =>
      assertHermesManagedWorkloadAuthority("hermes-gpu", MANAGED_IMAGE_REFERENCE, null),
    ).toThrow("has no managed workload authority");
  });

  it.each([
    ["agent", { ...VALID_MANAGED_AUTHORITY, agent: "openclaw" }],
    [
      "contract agent",
      {
        ...VALID_MANAGED_AUTHORITY,
        contract: { ...VALID_MANAGED_AUTHORITY.contract, agent: "pi" },
      },
    ],
    [
      "contract reference",
      {
        ...VALID_MANAGED_AUTHORITY,
        contract: {
          ...VALID_MANAGED_AUTHORITY.contract,
          reference: "different-reference",
        },
      },
    ],
    ["profile agent", { ...VALID_MANAGED_AUTHORITY, profile: { agent: "openclaw" } }],
    [
      "receipt kind",
      {
        ...VALID_MANAGED_AUTHORITY,
        receipt: { ...VALID_MANAGED_AUTHORITY.receipt, kind: "custom" },
      },
    ],
  ] as const)("rejects managed authority drift in %s (#9362)", (_label, authority) => {
    expect(() =>
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        MANAGED_IMAGE_REFERENCE,
        authority as unknown as ManagedWorkloadAuthority,
      ),
    ).toThrow();
  });

  it("rejects registry-to-receipt image drift (#9362)", () => {
    expect(() =>
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        OTHER_MANAGED_IMAGE_REFERENCE,
        VALID_MANAGED_AUTHORITY,
      ),
    ).toThrow();
  });

  it.each([
    "ghcr.io/nvidia/test:latest",
    "ghcr.io/nvidia/test@sha256:different",
    `ghcr.io/nvidia/test@sha256:${"A".repeat(64)}`,
  ])("rejects matching mutable or malformed image authority: %s (#9362)", (reference) => {
    const authority = {
      ...VALID_MANAGED_AUTHORITY,
      contract: { ...VALID_MANAGED_AUTHORITY.contract, reference },
      receipt: { ...VALID_MANAGED_AUTHORITY.receipt, reference },
    } as unknown as ManagedWorkloadAuthority;

    expect(() => assertHermesManagedWorkloadAuthority("hermes-gpu", reference, authority)).toThrow(
      "has no immutable image reference",
    );
  });

  it("accepts the running container's exact digest-backed authority (#9362)", () => {
    expect(() =>
      assertHermesContainerImageAuthority(MANAGED_IMAGE_REFERENCE, MANAGED_IMAGE_REFERENCE),
    ).not.toThrow();
  });

  it("rejects a running container outside the recorded authority (#9362)", () => {
    expect(() =>
      assertHermesContainerImageAuthority("ghcr.io/nvidia/test:latest", MANAGED_IMAGE_REFERENCE),
    ).toThrow();
  });
});
