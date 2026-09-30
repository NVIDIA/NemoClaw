// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxWorkloadRuntimeCapabilities } from "../../../onboard/workload/source";
import type { SandboxWorkloadReceipt } from "../../../state/registry/types";
import { preflightExternalImageRebuild } from "./rebuild-external-image-preflight";

const REFERENCE = `ghcr.io/example/openclaw@sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const RECEIPT = {
  schemaVersion: 1,
  kind: "external-image",
  reference: REFERENCE,
  platform: "linux/amd64",
  runtimeImageContentId: IMAGE_ID,
  shared: true,
} as const satisfies SandboxWorkloadReceipt;
const RUNTIME = {
  driverName: "docker",
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: true,
  managedImages: null,
  portableAgentRuntime: null,
  externalImages: {
    exactDigestReferences: true,
    platforms: ["linux/amd64"],
    agents: ["openclaw", "hermes"],
  },
} as const satisfies SandboxWorkloadRuntimeCapabilities;

function provider(
  options: {
    readonly imageId?: string;
    readonly disclosure?: "progressive" | "direct";
    readonly acceptsReceipt?: boolean;
  } = {},
): RuntimeProviderBundle {
  const capture = vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify([
      {
        Id: options.imageId ?? IMAGE_ID,
        Os: "linux",
        Architecture: "amd64",
        Config: {
          User: "1000:1000",
          WorkingDir: "/sandbox",
          Entrypoint: ["node"],
          Cmd: ["server.js"],
          Env: [`NEMOCLAW_TOOL_DISCLOSURE=${options.disclosure ?? "progressive"}`],
          Labels: { "io.nvidia.nemoclaw.agent": "openclaw" },
        },
      },
    ]),
    stderr: "",
  }));
  return {
    identity: { id: "docker" },
    workload: { acceptsReceipt: () => options.acceptsReceipt !== false },
    containerEngine: {
      supported: true,
      identities: [
        {
          operation: "external-image-preparation",
          engineId: "docker",
          displayName: "Docker",
        },
      ],
      capture,
    },
  } as unknown as RuntimeProviderBundle;
}

describe("external image rebuild preflight", () => {
  it("reuses the exact receipt reference without catalog replacement", () => {
    const runtimeProvider = provider();

    expect(() =>
      preflightExternalImageRebuild({
        agentName: "openclaw",
        expectedToolDisclosure: "progressive",
        receipt: RECEIPT,
        runtime: RUNTIME,
        provider: runtimeProvider,
      }),
    ).not.toThrow();
    expect(runtimeProvider.containerEngine.supported).toBe(true);
    const capture = runtimeProvider.containerEngine.supported
      ? runtimeProvider.containerEngine.capture
      : undefined;
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      "external-image-preparation",
      ["image", "inspect", REFERENCE],
      expect.any(Number),
    );
  });

  it("fails closed when the local immutable image identity changed", () => {
    expect(() =>
      preflightExternalImageRebuild({
        agentName: "openclaw",
        expectedToolDisclosure: "progressive",
        receipt: RECEIPT,
        runtime: RUNTIME,
        provider: provider({ imageId: `sha256:${"c".repeat(64)}` }),
      }),
    ).toThrow("does not match the durable external-image receipt");
  });

  it("fails closed when a rebuild override conflicts with baked disclosure", () => {
    expect(() =>
      preflightExternalImageRebuild({
        agentName: "openclaw",
        expectedToolDisclosure: "direct",
        receipt: RECEIPT,
        runtime: RUNTIME,
        provider: provider(),
      }),
    ).toThrow("does not match the recorded image");
  });

  it("fails closed when the selected provider rejects external-image receipts", () => {
    expect(() =>
      preflightExternalImageRebuild({
        agentName: "openclaw",
        expectedToolDisclosure: "progressive",
        receipt: RECEIPT,
        runtime: RUNTIME,
        provider: provider({ acceptsReceipt: false }),
      }),
    ).toThrow("rejected the durable external-image receipt");
  });
});
