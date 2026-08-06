// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CUA_LIFECYCLE_SCHEMA_VERSION } from "./contract";
import {
  parseCuaLifecycleRecord,
  parseCuaSecurityAttestation,
  parseCuaTargetManifest,
} from "./schema";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function targetManifest(): Record<string, unknown> {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-manifest",
    identityDigest: digest("1"),
    platform: "fixture-linux-amd64",
    image: {
      name: "fixture-image",
      version: "1.0.0",
      digest: digest("2"),
      owner: "fixture",
    },
    serviceBundle: {
      name: "fixture-services",
      version: "1.0.0",
      digest: digest("3"),
      owner: "fixture",
    },
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
  };
}

function securityAttestation(): Record<string, unknown> {
  const component = (name: string, value: string) => ({
    name,
    version: "1.0.0",
    digest: digest(value),
    owner: "fixture",
  });
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      runtimeReadinessDigest: digest("9"),
      targetIdentityDigest: digest("5"),
      components: {
        openshell: component("openshell", "0"),
        runtime: component("runtime", "1"),
        sandboxImage: component("sandbox", "2"),
        targetImage: component("target", "6"),
        serviceBundle: component("services", "7"),
        policy: component("policy", "3"),
        taskProtocol: component("protocol", "4"),
      },
      inference: {
        provider: "managed-provider",
        model: "managed-model",
        routeDigest: digest("a"),
      },
      appliedPolicy: { revision: 17, digest: digest("b") },
      capabilities: [
        { id: "browser", protocolVersion: "1.0.0" },
        { id: "computer", protocolVersion: "1.0.0" },
        { id: "terminal", protocolVersion: "1.0.0" },
      ],
    },
    network: {
      defaultAction: "deny",
      managedInference: "only",
      targetServices: ["browser", "computer", "terminal"],
      deniedDestinations: [
        "unrelated-internet",
        "cloud-metadata",
        "undeclared-loopback",
        "host-administration",
        "host-desktop",
        "docker-socket",
      ],
    },
    materialBoundary: {
      delivery: "host-side-secret-boundary",
      sandboxMaterial: "absent",
      excludedFrom: [
        "prompt",
        "sandbox-filesystem",
        "arguments",
        "logs",
        "state",
        "diagnostics",
        "backups",
        "public-json",
        "build-logs",
      ],
    },
    isolation: {
      runAs: "non-root",
      privileged: false,
      hostDockerSocket: false,
      hostDesktop: false,
      broadWritableHostMounts: false,
    },
    artifacts: {
      materials: [
        "screenshots",
        "page-content",
        "screen-content",
        "downloads",
        "browser-profiles",
        "cookies",
        "mutable-target-state",
        "task-content",
        "results",
        "logs",
        "documents",
      ],
      classification: "private",
      contentIdentity: "sha256",
      access: "owner-only",
      metadata: "bounded",
      retention: "until-target-detach-or-destroy",
      cleanupOperations: ["target.detach", "target.destroy"],
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: [
        "page-content",
        "screen-content",
        "downloads",
        "task-input",
        "runtime-output",
      ],
      mayExpand: false,
    },
    verifier: component("security-verifier", "8"),
  };
}

describe("CUA target manifest schema (#7751)", () => {
  it("accepts only immutable target and capability identities", () => {
    expect(parseCuaTargetManifest(targetManifest())).toEqual(targetManifest());
  });

  it("rejects credential-shaped or transport fields", () => {
    expect(() =>
      parseCuaTargetManifest({ ...targetManifest(), serviceToken: "not-public" }),
    ).toThrow("does not match its schema");
    expect(() =>
      parseCuaTargetManifest({ ...targetManifest(), endpoint: "https://target.invalid" }),
    ).toThrow("does not match its schema");

    const unsafePlatform = targetManifest();
    unsafePlatform.platform = "target.invalid";
    expect(() => parseCuaTargetManifest(unsafePlatform)).toThrow(/coordinate- and credential-free/);

    const unsafeComponent = targetManifest();
    (unsafeComponent.serviceBundle as Record<string, unknown>).owner = "operator@target.invalid";
    expect(() => parseCuaTargetManifest(unsafeComponent)).toThrow(
      /coordinate- and credential-free/,
    );
  });

  it("requires browser, computer, and terminal exactly once", () => {
    const duplicate = targetManifest();
    duplicate.capabilities = [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ];
    expect(() => parseCuaTargetManifest(duplicate)).toThrow(
      "must declare browser, computer, and terminal once",
    );
  });
});

describe("CUA security attestation schema (#7754)", () => {
  it("accepts the exact content-free deny-default boundary", () => {
    expect(parseCuaSecurityAttestation(securityAttestation())).toEqual(securityAttestation());
  });

  it("rejects missing denials and authority-bearing fields", () => {
    const missingDenial = securityAttestation();
    const network = missingDenial.network as { deniedDestinations: string[] };
    network.deniedDestinations = network.deniedDestinations.slice(1);
    expect(() => parseCuaSecurityAttestation(missingDenial)).toThrow("does not match its schema");
    expect(() =>
      parseCuaSecurityAttestation({
        ...securityAttestation(),
        accessToken: "not-public",
      }),
    ).toThrow("does not match its schema");
  });
});
