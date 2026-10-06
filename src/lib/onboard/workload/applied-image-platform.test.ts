// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { projectCommittedTelemetryConfiguration } from "../../actions/telemetry/configuration";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import type {
  RuntimeProviderBundle,
  RuntimeProviderCommandCapture,
} from "../runtime-provider/contract";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import { resolveOnboardSandboxWorkloadReceipt } from "../managed-workload/onboard-orchestration";
import { observeAppliedDockerfileImagePlatform } from "./applied-image-platform";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const REFERENCE = "nemoclaw-sandbox-local:alpha-build-1";
const SANDBOX_ID = "sandbox-id-1";
const FINGERPRINT = fingerprintOpenShellSandboxId(SANDBOX_ID)!;
const UAT_ENV = {
  NEMOCLAW_TELEMETRY_ENV: "uat",
  NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:os:attempt-1",
};
const IDENTITY_ROW = `${CONTAINER_ID}\topenshell\t/sandbox\t${SANDBOX_ID}\n`;

function observed(stdout: string): RuntimeProviderCommandCapture {
  return { status: 0, stdout, stderr: "" };
}

function harness(
  overrides: {
    identities?: string;
    confirmedIdentities?: string;
    image?: string;
    container?: string;
  } = {},
) {
  let identitiesRead = 0;
  const responses = {
    ps: () => {
      identitiesRead++;
      return observed(
        identitiesRead === 1
          ? (overrides.identities ?? IDENTITY_ROW)
          : (overrides.confirmedIdentities ?? overrides.identities ?? IDENTITY_ROW),
      );
    },
    inspect: () => observed(overrides.container ?? `${IMAGE_ID}\n`),
    image: () => observed(overrides.image ?? `${IMAGE_ID} linux/arm64\n`),
  };
  const capture = vi.fn((_operation: string, args: readonly string[]) =>
    responses[args[0] as keyof typeof responses](),
  );
  const provider = {
    identity: { id: "docker" },
    containerEngine: {
      providerId: "docker",
      supported: true,
      identities: [{ operation: "sandbox-lifecycle", engineId: "docker", displayName: "Docker" }],
      capture,
    },
  } as unknown as RuntimeProviderBundle;
  const input = {
    sandboxName: "alpha",
    sandboxIdentityFingerprint: FINGERPRINT,
    reference: REFERENCE,
    provider,
    environment: UAT_ENV,
  };
  return { input, capture, provider };
}

describe("applied Dockerfile image platform", () => {
  it("persists Linux from the completed Hermes custom image and projects it after reload (#10435)", () => {
    const { input, capture, provider } = harness();
    const resolved = resolveOnboardSandboxWorkloadReceipt({
      runtime: {
        runtimeProvider: provider,
        ensurePreparedWorkload: vi.fn(),
        ensurePreparedProfile: vi.fn(),
      },
      workload: {
        source: {
          kind: "legacy-dockerfile",
          dockerfilePath: "/old-install/agents/hermes/Dockerfile",
          reason: "custom-dockerfile",
        },
        release: null,
        fallbackDiagnostic: null,
      },
      appliedImageTarget: input,
      registryImageRef: REFERENCE,
      prebuildImageRef: null,
      firstCreateOutput: "",
      createOutput: "success",
      buildId: "build-1",
      extractBuiltImageRef: vi.fn(),
      resolveSandboxImageTagFromCreateOutput: vi.fn(),
    });
    const persisted = cloneSandboxWorkloadReceipt(
      JSON.parse(JSON.stringify(resolved.workloadReceipt)),
    );
    expect(persisted).toMatchObject({
      kind: "legacy-dockerfile",
      platformProof: {
        source: "applied-image-inspect",
        sandboxName: "alpha",
        sandboxIdentityFingerprint: FINGERPRINT,
        reference: REFERENCE,
        runtimeImageContentId: IMAGE_ID,
        platform: "linux/arm64",
      },
    });
    const projection = projectCommittedTelemetryConfiguration("alpha", {
      name: "alpha",
      agent: "hermes",
      openshellDriver: "docker",
      imageTag: resolved.resolvedImageTag,
      fromDockerfile: "/old-install/agents/hermes/Dockerfile",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      workload: persisted,
    });
    expect(projection).toMatchObject({
      sandboxOS: "linux",
      sandboxOSStatus: "reported",
      imageOwnership: "custom",
    });
    expect(JSON.stringify(projection)).not.toContain(IMAGE_ID);
    expect(JSON.stringify(projection)).not.toContain(REFERENCE);
    expect(capture).toHaveBeenCalledTimes(4);
    expect(capture.mock.calls[1]?.[1]).toEqual([
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Image}}",
      CONTAINER_ID,
    ]);
    expect(capture.mock.calls[2]?.[1]).toEqual([
      "image",
      "inspect",
      "--format",
      "{{.Id}} {{.Os}}/{{.Architecture}}",
      REFERENCE,
    ]);
  });

  it.each([
    ["production off", {}],
    ["operator opt-out", { ...UAT_ENV, NEMOCLAW_DISABLE_TELEMETRY: "1" }],
    ["test suppression", { ...UAT_ENV, VITEST: "true" }],
    ["CI suppression", { ...UAT_ENV, CI: "true" }],
    ["missing UAT campaign", { NEMOCLAW_TELEMETRY_ENV: "uat" }],
  ])("does not inspect runtime or image when %s (#10435)", (_case, environment) => {
    const { input, capture } = harness();
    expect(observeAppliedDockerfileImagePlatform({ ...input, environment })).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["absent container", { identities: "" }],
    ["ambiguous containers", { identities: `${IDENTITY_ROW}${IDENTITY_ROW}` }],
    ["foreign owner", { identities: IDENTITY_ROW.replace("openshell", "foreign") }],
    ["different sandbox identity", { identities: IDENTITY_ROW.replace(SANDBOX_ID, "another-id") }],
    ["malformed container row", { identities: `${CONTAINER_ID}\tmissing-fields\n` }],
    [
      "short container identity",
      { identities: IDENTITY_ROW.replace(CONTAINER_ID, "b".repeat(12)) },
    ],
    ["mutable image identity", { container: "private-image:latest\n" }],
    ["different applied image", { image: `sha256:${"c".repeat(64)} linux/arm64\n` }],
    ["Windows image", { image: `${IMAGE_ID} windows/amd64\n` }],
    ["missing platform", { image: `${IMAGE_ID}\n` }],
    ["multiple image records", { image: `${IMAGE_ID} linux/amd64\n${IMAGE_ID} linux/arm64\n` }],
    ["oversized output", { image: "x".repeat(4097) }],
    [
      "container replacement",
      { confirmedIdentities: IDENTITY_ROW.replace(CONTAINER_ID, "d".repeat(64)) },
    ],
    ["container disappeared", { confirmedIdentities: "" }],
  ])("does not report a platform from %s (#10435)", (_case, overrides) => {
    const { input } = harness(overrides);
    expect(observeAppliedDockerfileImagePlatform(input)).toBeUndefined();
  });

  it.each(["podman", "mxc"])("does not inspect a %s native provider (#10435)", (id) => {
    const { input, capture } = harness();
    input.provider = { ...input.provider, identity: { ...input.provider.identity, id } };
    expect(observeAppliedDockerfileImagePlatform(input)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a container engine bound to another provider (#10435)", () => {
    const { input, capture } = harness();
    input.provider = {
      ...input.provider,
      containerEngine: { ...input.provider.containerEngine, providerId: "podman" },
    };
    expect(observeAppliedDockerfileImagePlatform(input)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps all probes inside one observation deadline (#10435)", () => {
    const { input, capture } = harness();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(3001);
    expect(observeAppliedDockerfileImagePlatform(input, { monotonicNow: now })).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("sandbox-lifecycle", expect.any(Array), 2999);
  });

  it("omits proof when the final confirmation exceeds the observation deadline (#10435)", () => {
    const { input, capture } = harness();
    const realCapture = capture.getMockImplementation()!;
    let observationTime = 0;
    let calls = 0;
    capture.mockImplementation((operation, args) => {
      observationTime = [0, 0, 0, 3001][calls++] ?? 3001;
      return realCapture(operation, args);
    });
    expect(
      observeAppliedDockerfileImagePlatform(input, { monotonicNow: () => observationTime }),
    ).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it.each(["--format=private", "image with spaces", "x".repeat(513)])(
    "rejects an unsafe image reference before inspection (#10435)",
    (reference) => {
      const { input, capture } = harness();
      expect(observeAppliedDockerfileImagePlatform({ ...input, reference })).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 3, 4])("omits evidence when observation %s fails (#10435)", (failure) => {
    const { input, capture } = harness();
    const realCapture = capture.getMockImplementation()!;
    let calls = 0;
    capture.mockImplementation((operation, args) =>
      ++calls === failure
        ? { status: 1, stdout: "private diagnostic", stderr: "private error" }
        : realCapture(operation, args),
    );
    expect(observeAppliedDockerfileImagePlatform(input)).toBeUndefined();
  });
});
