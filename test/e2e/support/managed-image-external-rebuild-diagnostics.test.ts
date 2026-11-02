// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import * as failureDiagnostics from "../fixtures/sandbox-failure-diagnostics.ts";
import { qualifyExternalImage } from "../live/managed-image-activation-e2e-helpers.ts";

it.each([
  { exitCode: 1, timedOut: false },
  { exitCode: null, timedOut: true },
])("retains external rebuild diagnostics before cleanup for %j (#12603)", async (failure) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-external-rebuild-diagnostics-"),
  );
  vi.spyOn(os, "homedir").mockReturnValue(directory);
  vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
  const events: string[] = [];
  const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  const rebuild = { ...ok, ...failure, stderr: "Hermes post-restore verification failed" };
  const imageId = `sha256:${"a".repeat(64)}`;
  const reference = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@${imageId}`;
  const receipt = {
    schemaVersion: 1,
    kind: "external-image",
    reference,
    platform: "linux/amd64",
    runtimeImageContentId: imageId,
    shared: true,
  };
  fs.mkdirSync(path.join(directory, ".nemoclaw"));
  fs.writeFileSync(
    path.join(directory, ".nemoclaw/sandboxes.json"),
    JSON.stringify({
      sandboxes: { "ext-img-hermes": { toolDisclosure: "progressive", workload: receipt } },
    }),
  );
  const capture = vi
    .spyOn(failureDiagnostics, "captureSandboxFailureDiagnostics")
    .mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("diagnostics");
    });
  const ready = vi.fn(async () => undefined);
  const host = {
    nemoclaw: vi.fn(async (args: string[]) => {
      const operation = args[0] === "onboard" ? "onboard" : args[1];
      events.push(operation!);
      return operation === "rebuild" ? rebuild : ok;
    }),
    command: vi.fn(async (_command: string, args: string[]) => ({
      ...ok,
      stdout: args[0] === "image" ? imageId : "",
    })),
    bestEffortCleanupSandbox: vi.fn(async () => ok),
    cleanupGatewayRegistration: vi.fn(async () => ok),
    destroySandbox: vi.fn(async () => {
      events.push("destroy");
      return ok;
    }),
  };
  try {
    const result = await qualifyExternalImage(
      {
        artifacts: new ArtifactSink(directory),
        cleanup: { trackDisposable: vi.fn(), trackSandbox: vi.fn() },
        host,
        lifecycle: { stopGatewayRuntime: vi.fn(), waitForSandboxReadyAfterGatewayRestart: ready },
        sandbox: {
          cleanupSandbox: vi.fn(async () => ok),
          exec: vi.fn(async () => ({ ...ok, stdout: "PONG" })),
          list: vi.fn(async () => ok),
        },
      } as never,
      { env: {} } as never,
      "docker",
      "/unused-catalog.json",
      "http://10.20.30.40:43123/v1",
      "hermes",
      { reference, platform: "linux/amd64" } as never,
    );
    expect({
      events,
      rebuilt: result.rebuilt,
      verified: result.verified,
      readinessCalls: ready.mock.calls.length,
    }).toEqual({
      events: ["onboard", "rebuild", "diagnostics", "destroy"],
      rebuilt: false,
      verified: false,
      readinessCalls: 1,
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(host, rebuild, {
      sandboxName: "ext-img-hermes",
      artifactPrefix: "external-image-hermes-rebuild-failure",
      redactionValues: ["nemoclaw-managed-activation-e2e-key"],
      captureGatewayLog: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
