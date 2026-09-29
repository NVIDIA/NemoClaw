// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandRequest,
} from "../../adapters/openshell/sandbox-command";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { NEMOCLAW_HERMES_LIGHT_SKIN_NAME } from "../../domain/sandbox/connect-env";
import type { ConfigObject } from "../../security/credential-filter";

function bufferedRequest(call: unknown[]): OpenShellSandboxBufferedCommandRequest | undefined {
  return call[0] as OpenShellSandboxBufferedCommandRequest | undefined;
}

function removalCalls(harness: ReturnType<typeof createConnectHarness>) {
  return harness.sandboxRunBufferedSpy.mock.calls.filter((call) =>
    String(bufferedRequest(call)?.input ?? "").includes('rm -f "$skin_dir/nemoclaw-light.yaml"'),
  );
}

function failedCommand(message: string): OpenShellSandboxBufferedCommandCompletion {
  return {
    outcome: { kind: "failed", error: { kind: "invocation", message } },
    stdout: "",
    stderr: "",
  };
}

describe("Hermes retired light terminal skin cleanup", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  function hermesHarness(hermesConfig: ConfigObject) {
    return createConnectHarness({
      agentName: "hermes",
      hermesConfig,
      sessionAgent: {
        name: "hermes",
        runtime: { kind: "terminal", interactive_command: "hermes" },
      },
    });
  }

  it("removes the retired NemoClaw skin before connecting to Hermes (#6380)", async () => {
    const harness = hermesHarness({
      display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME, width: 100 },
      model: "test",
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agentName: "hermes" }),
      { display: { width: 100 }, model: "test" },
    );
    const calls = removalCalls(harness);
    expect(calls).toHaveLength(1);
    const request = bufferedRequest(calls[0] ?? []);
    expect(request).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["sh", "-s"],
      timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(request?.input).toContain('set -eu\nhermes_home="${HERMES_HOME:-/sandbox/.hermes}"');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("leaves an operator-selected Hermes skin unchanged (#6380)", async () => {
    const harness = hermesHarness({ display: { skin: "solarized-light" } });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(removalCalls(harness)).toHaveLength(0);
  });

  it("does not inspect non-Hermes sandbox configuration (#6380)", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.readSandboxConfigSpy).not.toHaveBeenCalled();
    expect(removalCalls(harness)).toHaveLength(0);
  });

  it("continues connecting when retired-skin cleanup cannot read config (#6380)", async () => {
    const harness = hermesHarness({});
    harness.readSandboxConfigSpy.mockImplementation(() => {
      throw new Error("https://user:secret@example.test/hermes");
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.errorSpy.mock.calls.flat().join(" ")).toContain(
      "Could not read retired Hermes light terminal skin",
    );
    expect(harness.errorSpy.mock.calls.flat().join(" ")).not.toContain("secret");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("warns and continues when the retired skin file cannot be removed (#6380)", async () => {
    const harness = hermesHarness({ display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME } });
    const runBuffered = harness.sandboxRunBufferedSpy.getMockImplementation();
    harness.sandboxRunBufferedSpy.mockImplementation(async (request) =>
      String(request.input ?? "").includes('rm -f "$skin_dir/nemoclaw-light.yaml"')
        ? failedCommand("https://user:secret@example.test/hermes")
        : await runBuffered?.(request),
    );

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.writeSandboxConfigSpy).toHaveBeenCalledOnce();
    expect(removalCalls(harness)).toHaveLength(1);
    expect(harness.errorSpy.mock.calls.flat().join(" ")).toContain(
      "Could not remove retired Hermes light terminal skin",
    );
    expect(harness.errorSpy.mock.calls.flat().join(" ")).not.toContain("secret");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("preserves the retired skin file when its config update fails (#6380)", async () => {
    const harness = hermesHarness({ display: { skin: NEMOCLAW_HERMES_LIGHT_SKIN_NAME } });
    harness.writeSandboxConfigSpy.mockImplementation(() => {
      throw new Error("https://user:secret@example.test/hermes");
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(removalCalls(harness)).toHaveLength(0);
    expect(harness.errorSpy.mock.calls.flat().join(" ")).toContain(
      "Could not update retired Hermes light terminal skin",
    );
    expect(harness.errorSpy.mock.calls.flat().join(" ")).not.toContain("secret");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
