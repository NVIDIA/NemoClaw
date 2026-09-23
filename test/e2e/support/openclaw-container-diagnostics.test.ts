// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { captureOpenClawContainerFailure } from "../fixtures/openclaw-container-diagnostics.ts";
import {
  buildOpenClawOnboardDiagnosticsCommand,
  captureOpenClawOnboardFailure,
} from "../fixtures/openclaw-onboard-diagnostics.ts";

const ID = "a".repeat(64);
const options = {
  env: { OPENSHELL_GATEWAY: "recorded" },
  timeoutMs: 15000,
  killGraceMs: 1000,
  captureLimitBytes: 65536,
  redactionValues: ["fixture-secret"],
};

function runtime(id = ID) {
  return {
    resolveSandboxResourceHandle: vi.fn().mockResolvedValue(id),
    command: vi.fn().mockResolvedValue({}),
  };
}

it("pins bounded read-only container probes to the full discovered identity", async () => {
  const client = runtime();
  const reader = buildOpenClawOnboardDiagnosticsCommand();
  await captureOpenClawContainerFailure(client, "sandbox", "resume", options, reader);
  expect(client.command.mock.calls.map(([args]) => args)).toEqual([
    [
      "container",
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
      ID,
    ],
    ["logs", "--tail", "120", ID],
    ["container", "exec", "--user", "sandbox", ID, ...reader],
  ]);
  expect(client.command.mock.calls.map((call) => call[1])).toEqual([
    { ...options, artifactName: "resume-failure-container-state" },
    { ...options, artifactName: "resume-failure-container-logs" },
    { ...options, artifactName: "resume-failure-container-startup-logs" },
  ]);
});

it.each(["short-id", `${ID}\n${ID}`, "", `--name=${ID}`])(
  "refuses ambiguous or malformed container identity %s",
  async (id) => {
    const client = runtime(id);
    await captureOpenClawContainerFailure(client, "sandbox", "resume", options, []);
    expect(client.command).not.toHaveBeenCalled();
  },
);

it("captures only failed onboarding and ignores diagnostic transport failures", async () => {
  const client = runtime();
  const sandbox = {
    exec: vi.fn().mockRejectedValue(new Error("phase Error")),
    openshell: vi.fn().mockResolvedValue({}),
  };
  const input = { sandboxName: "sandbox", artifactPrefix: "resume", ...options, runtime: client };
  await captureOpenClawOnboardFailure({ exitCode: 0 }, sandbox, input);
  expect(client.resolveSandboxResourceHandle).not.toHaveBeenCalled();
  client.command.mockRejectedValue(new Error("container stopped"));
  await expect(
    captureOpenClawOnboardFailure({ exitCode: 1 }, sandbox, input),
  ).resolves.toBeUndefined();
  expect(client.command).toHaveBeenCalledTimes(3);
});

it("protects raw and JSON-escaped secrets on direct runtime probes", async () => {
  const client = runtime();
  const sandbox = { exec: vi.fn().mockResolvedValue({}), openshell: vi.fn().mockResolvedValue({}) };
  const secret = 'fixture-"secret\nvalue';
  await captureOpenClawOnboardFailure({ exitCode: 1 }, sandbox, {
    sandboxName: "sandbox",
    artifactPrefix: "resume",
    env: options.env,
    redactionValues: [secret],
    runtime: client,
  });
  expect(client.command.mock.calls[2]![1]).toMatchObject({
    timeoutMs: 15000,
    killGraceMs: 1000,
    captureLimitBytes: 65536,
    redactionValues: [secret, JSON.stringify(secret).slice(1, -1)],
  });
});
