// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// readSandboxConfig's stopped-sandbox contract (#10251, a regression of
// #6997): when `sandbox exec` fails because the sandbox itself is not ready,
// the actionable "Is the sandbox running?" guidance must survive — not just
// for a completely empty `cat` read, but also when OpenShell's CLI reports a
// non-empty "not ready (phase: ...)" detail on stderr.

import { afterEach, describe, expect, it } from "vitest";

const clientModulePath = require.resolve("../adapters/openshell/client");
const configModulePath = require.resolve("./config");

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

function loadReadSandboxConfig(): (
  name: string,
  target: { agentName: string; configPath: string; format: string },
) => unknown {
  delete require.cache[configModulePath];
  const mod = require(configModulePath) as {
    readSandboxConfig: (name: string, target: unknown) => unknown;
  };
  return mod.readSandboxConfig as never;
}

const OPENCLAW_TARGET = {
  agentName: "OpenClaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  format: "json",
};

describe("readSandboxConfig stopped-sandbox detail (#10251)", () => {
  afterEach(() => {
    client.captureOpenshellCommand = realCapture;
    delete require.cache[configModulePath];
  });

  it("surfaces the stopped-sandbox recovery hint for a wrapped OpenShell not-ready detail", () => {
    stubFailedExec(
      "Error:   x sandbox 'sandbox-a' is not ready (phase: Error); wait for it to\n  reach Ready state",
    );
    const readSandboxConfig = loadReadSandboxConfig();

    let error: unknown;
    try {
      readSandboxConfig("sandbox-a", OPENCLAW_TARGET);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    const lines = (error as { lines?: readonly string[] }).lines ?? [];
    expect(lines.some((line) => /is the sandbox running/i.test(line))).toBe(true);
    // The raw OpenShell detail must not leak into the user-facing message —
    // the generic stopped-sandbox message replaces it, matching the
    // already-empty-read case.
    expect((error as Error).message).not.toContain("phase: Error");
  });

  it("still surfaces the raw detail for an unrelated exec failure", () => {
    stubFailedExec("Error: connection refused");
    const readSandboxConfig = loadReadSandboxConfig();

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
