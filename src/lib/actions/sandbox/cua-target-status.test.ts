// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
} from "../../cua/contract";
import type { SandboxEntry } from "../../state/registry";
import { buildCuaSecurityDoctorCheck, buildCuaTargetDoctorCheck } from "./doctor";
import { getSandboxStatusReport } from "./status";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  target: {
    identityDigest: digest("1"),
    platform: "fixture-linux-amd64",
    image: { name: "fixture-image", version: "1", digest: digest("2"), owner: "fixture" },
    serviceBundle: {
      name: "fixture-services",
      version: "1",
      digest: digest("3"),
      owner: "fixture",
    },
    capabilities: [
      { id: "browser", protocolVersion: "1", health: "healthy" },
      { id: "computer", protocolVersion: "1", health: "healthy" },
      { id: "terminal", protocolVersion: "1", health: "healthy" },
    ],
  },
  activeTask: null,
};

const readiness = { kind: "runtime-readiness" } as CuaRuntimeReadiness;
const security: CuaSecurityAttestation = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
    targetIdentityDigest: attachment.target!.identityDigest,
    components: {
      runtime: { name: "runtime", version: "1", digest: digest("4"), owner: "fixture" },
      sandboxImage: { name: "sandbox", version: "1", digest: digest("5"), owner: "fixture" },
      targetImage: attachment.target!.image,
      serviceBundle: attachment.target!.serviceBundle,
      policy: { name: "policy", version: "1", digest: digest("6"), owner: "fixture" },
      taskProtocol: { name: "protocol", version: "1", digest: digest("7"), owner: "fixture" },
    },
    inference: { provider: "managed-provider", model: "managed-model" },
    capabilities: attachment.target!.capabilities.map(({ id, protocolVersion }) => ({
      id,
      protocolVersion,
    })),
  },
  network: {
    defaultAction: "deny",
    managedInference: "only",
    targetServices: ["browser", "computer", "terminal"],
    deniedDestinations: CUA_DENIED_DESTINATIONS,
  },
  materialBoundary: {
    delivery: "host-side-secret-boundary",
    sandboxMaterial: "absent",
    excludedFrom: CUA_MATERIAL_EXCLUSIONS,
  },
  isolation: {
    runAs: "non-root",
    privileged: false,
    hostDockerSocket: false,
    hostDesktop: false,
    broadWritableHostMounts: false,
  },
  artifacts: {
    materials: CUA_PRIVATE_MATERIALS,
    classification: "private",
    contentIdentity: "sha256",
    access: "owner-only",
    metadata: "bounded",
    retention: "until-target-reset-or-destroy",
    cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
    backup: "excluded",
  },
  authority: {
    fixtureScope: "synthetic-local",
    externalSideEffects: "denied",
    untrustedInputs: CUA_UNTRUSTED_INPUTS,
    mayExpand: false,
  },
  verifier: { name: "verifier", version: "1", digest: digest("8"), owner: "fixture" },
};

const securityReadiness = {
  ...readiness,
  status: "available",
  components: {
    runtime: security.bindings.components.runtime,
    sandboxImage: security.bindings.components.sandboxImage,
    policy: security.bindings.components.policy,
    taskProtocol: security.bindings.components.taskProtocol,
  },
  inference: security.bindings.inference,
} as CuaRuntimeReadiness;

describe("CUA target status and doctor projection (#7751)", () => {
  it("adds only the secret-free target projection to sandbox status JSON", async () => {
    const sandbox = {
      name: "alpha",
      agent: "openclaw",
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    } as SandboxEntry;

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report.cuaTarget).toEqual(attachment);
    expect(report.cuaSecurity).toEqual(security);
    expect(JSON.stringify(report.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostname|ssh|vnc/i,
    );
  });

  it("reports only an identity-bound, content-free security projection", () => {
    const check = buildCuaSecurityDoctorCheck("alpha", {
      name: "alpha",
      cuaRuntimeReadiness: securityReadiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    });

    expect(check).toMatchObject({
      group: "Sandbox",
      label: "CUA security",
      status: "ok",
      detail: expect.stringContaining("enforced"),
    });
    expect(check?.detail).not.toMatch(/endpoint|hostname|credential|cookie|ssh|vnc/i);

    expect(
      buildCuaSecurityDoctorCheck("alpha", {
        name: "alpha",
        cuaRuntimeReadiness: securityReadiness,
        cuaTarget: attachment,
      }),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("not verified") });
  });

  it("reports an attached target and its three capability health states", () => {
    const check = buildCuaTargetDoctorCheck("alpha", {
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });

    expect(check).toMatchObject({
      group: "Sandbox",
      label: "CUA target",
      status: "ok",
      detail: expect.stringContaining("browser=healthy"),
    });
    expect(check?.detail).toContain("computer=healthy");
    expect(check?.detail).toContain("terminal=healthy");
    expect(check?.detail).not.toMatch(/endpoint|hostname|credential/i);
  });

  it("fails doctor for replaced target state and reports detached state as informational", () => {
    expect(
      buildCuaTargetDoctorCheck("alpha", {
        name: "alpha",
        cuaRuntimeReadiness: readiness,
        cuaTarget: { ...attachment, status: "replaced" },
      }),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("replaced") });

    expect(
      buildCuaTargetDoctorCheck("alpha", {
        name: "alpha",
        cuaRuntimeReadiness: readiness,
      }),
    ).toMatchObject({ status: "info", detail: "no target attached" });
  });
});
