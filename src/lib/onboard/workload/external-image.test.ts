// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDockerRuntimeProviderBundle } from "../runtime-provider/docker";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import {
  inspectExternalImageMetadata,
  prepareExternalImage,
  requireExternalImageReference,
  verifyExternalOpenClawModel,
} from "./external-image";

const reference = `ghcr.io/example/harness@sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
function metadata() {
  return {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "sandbox",
      WorkingDir: "/sandbox",
      Entrypoint: ["/usr/local/bin/start"],
      Cmd: [],
      Env: ["NEMOCLAW_TOOL_DISCLOSURE=direct"],
      Labels: { "io.nvidia.nemoclaw.agent": "openclaw" },
    },
  };
}
const input = { reference, agent: "openclaw", platform: "linux/amd64" };

describe("external image admission", () => {
  it("accepts a matching live OpenClaw model through the named gateway", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: JSON.stringify({
        agents: { defaults: { model: { primary: "inference/selected" } } },
        models: { providers: { inference: { models: [{ id: "selected" }] } } },
      }),
      stderr: "",
    }));
    await verifyExternalOpenClawModel({
      sandboxName: "external",
      gatewayName: "selected-gateway",
      model: "selected",
      commandExecutor: { runBuffered },
    });
    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "external",
        target: { kind: "named", gatewayName: "selected-gateway" },
      }),
    );
  });

  it.each([
    [
      "model mismatch",
      0,
      '{"agents":{"defaults":{"model":{"primary":"inference/stale"}}}}',
      "does not match",
    ],
    ["unreadable configuration", 1, "publisher-secret", "Cannot verify"],
    ["invalid configuration", 0, "publisher-secret", "invalid model configuration"],
  ])("refuses registration after %s", async (_name, exitCode, stdout, error) => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode },
      stdout,
      stderr: "publisher-secret",
    }));
    await expect(
      verifyExternalOpenClawModel({
        sandboxName: "external",
        gatewayName: "selected-gateway",
        model: "selected",
        commandExecutor: { runBuffered },
      }),
    ).rejects.toThrow(error);
  });

  it("records the requested digest and inspected content identity and adopts baked disclosure", () => {
    const receipt = inspectExternalImageMetadata({ ...input, metadata: metadata() });
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "external-image",
      reference,
      imageId,
      platform: "linux/amd64",
      agent: "openclaw",
      toolDisclosure: "direct",
      shared: true,
    });
    expect(cloneSandboxWorkloadReceipt(receipt)).toEqual(receipt);
    expect(cloneSandboxWorkloadReceipt({ ...receipt, imageId: "mutable" })).toBeUndefined();
  });

  it.each([
    "ubuntu:latest",
    "ubuntu",
    `https://${reference}`,
    `-x@sha256:${"a".repeat(64)}`,
    `${reference};echo unsafe`,
  ])("rejects an unpinned or unsafe image reference %s", (value) => {
    expect(() => requireExternalImageReference(value)).toThrow("requires a repository");
  });

  it.each([
    ["root", { User: "root" }, "non-root"],
    ["numeric root", { User: "00:1000" }, "non-root"],
    ["unset user", { User: "" }, "non-root"],
    ["wrong workdir", { WorkingDir: "/" }, "WORKDIR"],
    ["missing command", { Entrypoint: [], Cmd: [] }, "ENTRYPOINT"],
    ["missing disclosure", { Env: [] }, "NEMOCLAW_TOOL_DISCLOSURE"],
    [
      "invalid disclosure",
      { Env: ["NEMOCLAW_TOOL_DISCLOSURE=invalid"] },
      "NEMOCLAW_TOOL_DISCLOSURE",
    ],
    [
      "ambiguous disclosure",
      { Env: ["NEMOCLAW_TOOL_DISCLOSURE=direct", "NEMOCLAW_TOOL_DISCLOSURE=progressive"] },
      "NEMOCLAW_TOOL_DISCLOSURE",
    ],
    ["contradictory agent", { Labels: { "io.nvidia.nemoclaw.agent": "hermes" } }, "agent metadata"],
  ])("rejects %s before sandbox creation", (_name, patch, message) => {
    const image = metadata();
    expect(() =>
      inspectExternalImageMetadata({
        ...input,
        metadata: { ...image, Config: { ...image.Config, ...patch } },
      }),
    ).toThrow(message);
  });

  it("rejects an unsupported agent, wrong platform, and explicit disclosure mismatch", () => {
    expect(() =>
      inspectExternalImageMetadata({
        ...input,
        agent: "langchain-deepagents-code",
        metadata: metadata(),
      }),
    ).toThrow("OpenClaw and Hermes only");
    expect(() =>
      inspectExternalImageMetadata({ ...input, platform: "linux/arm64", metadata: metadata() }),
    ).toThrow("platform");
    expect(() =>
      inspectExternalImageMetadata({
        ...input,
        requestedToolDisclosure: "progressive",
        metadata: metadata(),
      }),
    ).toThrow("conflicts");
  });

  it("pulls and inspects through the selected engine and retains publisher-owned images", () => {
    const captureHostCommand = vi.fn((_command, args) => ({
      status: 0,
      stdout: args[0] === "image" ? JSON.stringify([metadata()]) : "",
      stderr: "",
    }));
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const receipt = prepareExternalImage({
      reference,
      agent: "openclaw",
      provider,
      architecture: "x64",
    });
    expect(captureHostCommand.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["docker", ["pull", reference]],
      ["docker", ["image", "inspect", reference]],
    ]);
    expect(provider.workload.acceptsReceipt(receipt)).toBe(true);
    const sandbox = { name: "external", imageTag: reference, workload: receipt };
    expect(provider.cleanup.supported).toBe(true);
    expect(
      (
        provider.cleanup as Extract<typeof provider.cleanup, { supported: true }>
      ).planOwnedWorkloadCleanup({ sandbox } as never),
    ).toEqual({
      action: "retain",
      reason: "shared-image",
    });
  });

  it("stops on pull failure without a build or metadata inspection", () => {
    const captureHostCommand = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "secret registry detail",
    }));
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    expect(() => prepareExternalImage({ reference, agent: "openclaw", provider })).toThrow(
      "Check its digest, registry visibility",
    );
    expect(captureHostCommand).toHaveBeenCalledOnce();
  });
});
