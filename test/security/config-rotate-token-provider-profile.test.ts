// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_CONFIG } from "../../src/lib/sandbox/agent-config";
import {
  rotateSandboxToken,
  type RotateTokenDeps,
} from "../../src/lib/sandbox/config-rotate-token";

type CaptureResult = ReturnType<RotateTokenDeps["captureOpenshellCommand"]>;
type RunResult = ReturnType<RotateTokenDeps["runOpenshellCommand"]>;
const EXACT_OPENAI_PROFILE = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

function loadRotateTokenFixture(input: {
  providerType: string;
  captureResults: CaptureResult[];
}) {
  const queuedCaptureResults = [...input.captureResults];
  const captureOpenshellCommand = vi.fn(
    (_binary: string, _args: string[], _options?: unknown): CaptureResult =>
      queuedCaptureResults.shift() ?? { status: 1, output: "" },
  );
  const runOpenshellCommand = vi.fn(
    (): RunResult =>
      ({
        status: 0,
      }) as RunResult,
  );
  const appendAuditEntry = vi.fn();
  const saveCredential = vi.fn();
  const fail = vi.fn((lines: string | readonly string[]): never => {
    throw new Error(typeof lines === "string" ? lines : lines.join("\n"));
  });

  const deps = {
    appendAuditEntry,
    captureOpenshellCommand,
    fail,
    loadSession: () => ({
      sandboxName: "rotate-profile-test",
      credentialEnv: "OPENAI_API_KEY",
      provider: "inference",
      providerType: input.providerType,
    }),
    promptSecret: vi.fn().mockResolvedValue("rotation-secret"),
    resolveAgentConfig: () => DEFAULT_AGENT_CONFIG,
    runOpenshellCommand,
    saveCredential,
    validateName: vi.fn((name: string) => name),
  } satisfies RotateTokenDeps;

  return {
    appendAuditEntry,
    captureOpenshellCommand,
    deps,
    runOpenshellCommand,
    saveCredential,
  };
}

describe("config rotate-token OpenAI provider profile", () => {
  it("imports a missing OpenAI profile before rotating the provider token (#10155)", async () => {
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        {
          status: 1,
          output: "",
          stdout: "",
          stderr: "provider profile not found",
        },
        { status: 0, output: "Imported", stdout: "Imported", stderr: "" },
        {
          status: 0,
          output: EXACT_OPENAI_PROFILE,
          stdout: EXACT_OPENAI_PROFILE,
          stderr: "",
        },
      ],
    });

    await rotateSandboxToken("rotate-profile-test", {}, fixture.deps);

    expect(
      fixture.captureOpenshellCommand.mock.calls.map(([, args]) => args),
    ).toEqual([
      ["provider", "profile", "export", "openai", "--output", "json"],
      [
        "provider",
        "profile",
        "import",
        "--file",
        expect.stringMatching(/openai\.yaml$/u),
      ],
      ["provider", "profile", "export", "openai", "--output", "json"],
    ]);
    expect(fixture.captureOpenshellCommand.mock.calls[0]?.[2]).toMatchObject({
      ignoreError: true,
      includeStreams: true,
      timeout: 30_000,
    });
    expect(
      fixture.captureOpenshellCommand.mock.invocationCallOrder[2],
    ).toBeLessThan(fixture.saveCredential.mock.invocationCallOrder[0]!);
    expect(fixture.saveCredential.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.runOpenshellCommand.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects an incompatible OpenAI profile before staging or rotating the token (#10155)", async () => {
    const incompatibleProfile = JSON.stringify({
      id: "openai",
      credentials: [{ env: "OPENAI_API_KEY" }],
      endpoints: [],
      binaries: [],
      inference_capable: true,
    });
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        {
          status: 0,
          output: incompatibleProfile,
          stdout: incompatibleProfile,
          stderr: "",
        },
      ],
    });

    await expect(
      rotateSandboxToken("rotate-profile-test", {}, fixture.deps),
    ).rejects.toThrow(
      "does not match NemoClaw's endpointless inference contract",
    );
    expect(fixture.saveCredential).not.toHaveBeenCalled();
    expect(fixture.runOpenshellCommand).not.toHaveBeenCalled();
  });

  it("suppresses failed profile import output before rotating the token (#10155)", async () => {
    const profileSecret = "profile-import-secret";
    const fixture = loadRotateTokenFixture({
      providerType: "openai",
      captureResults: [
        {
          status: 1,
          output: "",
          stdout: "",
          stderr: "provider profile not found",
        },
        {
          status: 1,
          output: `import rejected: ${profileSecret}`,
          stdout: "",
          stderr: `import rejected: ${profileSecret}`,
        },
      ],
    });

    let thrown = "";
    try {
      await rotateSandboxToken("rotate-profile-test", {}, fixture.deps);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toContain("could not import the checked-in 'openai'");
    expect(thrown).not.toContain(profileSecret);
    expect(thrown).not.toContain("rotation-secret");
    expect(fixture.saveCredential).not.toHaveBeenCalled();
    expect(fixture.runOpenshellCommand).not.toHaveBeenCalled();
  });

  it("does not inspect the OpenAI profile for another provider type (#10155)", async () => {
    const fixture = loadRotateTokenFixture({
      providerType: "nvidia",
      captureResults: [],
    });

    await rotateSandboxToken("rotate-profile-test", {}, fixture.deps);

    expect(fixture.captureOpenshellCommand).not.toHaveBeenCalled();
    expect(fixture.saveCredential).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      "rotation-secret",
    );
    expect(fixture.runOpenshellCommand).toHaveBeenCalledOnce();
    expect(fixture.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rotate_token",
        sandbox: "rotate-profile-test",
        reason: "rotate-token openclaw:OPENAI_API_KEY",
      }),
    );
    expect(JSON.stringify(fixture.appendAuditEntry.mock.calls)).not.toContain(
      "rotation-secret",
    );
  });
});
