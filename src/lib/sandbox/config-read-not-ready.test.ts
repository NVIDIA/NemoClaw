// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// The inference-set stopped-sandbox contract (#10251, a regression of #6997):
// when `sandbox exec` fails because the sandbox itself is not ready, the
// actionable recovery guidance must survive non-empty OpenShell not-ready
// details on stderr, including the phase and structured diagnostic forms.

import { afterEach, describe, expect, it } from "vitest";

const clientModulePath = require.resolve("../adapters/openshell/client");
const configModulePath = require.resolve("./config");
const inferenceSetModulePath = require.resolve("../actions/inference-set");

type CaptureResult = {
  status: number;
  signal: null;
  error?: undefined;
  stdout: string;
  output: string;
  stderr: string;
};

const client = require(clientModulePath) as {
  captureOpenshellCommand: (...args: unknown[]) => CaptureResult;
};
const realCapture = client.captureOpenshellCommand;

function stubFailedExec(stderr: string, status = 1): void {
  client.captureOpenshellCommand = () => ({
    status,
    signal: null,
    stdout: "",
    output: "",
    stderr,
  });
}

function loadConfigReaders(): Pick<typeof import("./config"), "readSandboxConfig"> &
  Pick<typeof import("../actions/inference-set"), "readInSandboxConfigOrFail"> {
  delete require.cache[configModulePath];
  delete require.cache[inferenceSetModulePath];
  const config = require(configModulePath) as typeof import("./config");
  const inferenceSet = require(inferenceSetModulePath) as typeof import("../actions/inference-set");
  return {
    readSandboxConfig: config.readSandboxConfig,
    readInSandboxConfigOrFail: inferenceSet.readInSandboxConfigOrFail,
  };
}

const OPENCLAW_TARGET: import("./config").AgentConfigTarget = {
  agentName: "OpenClaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  format: "json",
  stateLockPlanInImage: true,
};

describe("readSandboxConfig stopped-sandbox detail (#10251)", () => {
  afterEach(() => {
    client.captureOpenshellCommand = realCapture;
    delete require.cache[configModulePath];
    delete require.cache[inferenceSetModulePath];
  });

  it.each([
    {
      label: "a wrapped phase detail",
      stderr:
        "Error:   x sandbox 'sandbox-a' is not ready (phase: Error); wait for it to\n  reach Ready state",
      rawFragment: "phase: Error",
    },
    {
      label: "the structured not-ready detail",
      stderr:
        "Error: code: 'The system is not in a state required for the operation's execution', message: \"sandbox is not ready\"",
      rawFragment: "The system is not in a state required",
    },
  ])(
    "surfaces stopped-sandbox recovery guidance for $label (#10251)",
    ({ rawFragment, stderr }) => {
      stubFailedExec(stderr);
      const { readInSandboxConfigOrFail, readSandboxConfig } = loadConfigReaders();

      let error: unknown;
      try {
        readInSandboxConfigOrFail({ readSandboxConfig }, "sandbox-a", OPENCLAW_TARGET);
      } catch (thrown) {
        error = thrown;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Is the sandbox running?");
      expect((error as Error).message).toContain("Start the sandbox and retry.");
      // The raw OpenShell detail must not leak into the user-facing message —
      // the generic stopped-sandbox message replaces it, matching the
      // already-empty-read case.
      expect((error as Error).message).not.toContain(rawFragment);
    },
  );

  it("still surfaces the raw detail for an unrelated exec failure", () => {
    stubFailedExec("Error: connection refused");
    const { readSandboxConfig } = loadConfigReaders();

    let error: unknown;
    try {
      readSandboxConfig("sandbox-a", OPENCLAW_TARGET);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("connection refused");
  });
});
