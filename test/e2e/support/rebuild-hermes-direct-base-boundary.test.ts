// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { resolveCreateSandboxDashboardPort } from "../../../src/lib/onboard/dashboard-port";
import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  buildRebuildHermesCompatibleProviderArgs,
  buildRebuildHermesInferenceRouteArgs,
  prepareRebuildHermesCurrentFixture,
} from "../live/rebuild-hermes-current-fixture.ts";

const LIVE_FIXTURE = path.resolve(import.meta.dirname, "../live/rebuild-hermes.test.ts");
const CURRENT_FIXTURE = path.resolve(
  import.meta.dirname,
  "../live/rebuild-hermes-current-fixture.ts",
);
const ENDPOINT = "https://inference.example.test/v1";
const MODEL = "test/current-model";
const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base";

function probeResult(args: string[], exitCode = 0, stdout = ""): ShellProbeResult {
  return {
    command: ["openshell", ...args],
    durationMs: 1,
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: {
      stdout: "stdout.txt",
      stderr: "stderr.txt",
      result: "result.json",
    },
  };
}

describe("rebuild-Hermes direct-base boundary", () => {
  it("prepares the current base directly and omits the disposable phase-1 sandbox (#7144)", () => {
    const source = fs.readFileSync(LIVE_FIXTURE, "utf8");
    const currentFixtureSource = fs.readFileSync(CURRENT_FIXTURE, "utf8");

    expect(source).toContain('host.nemoclaw(["--help"]');
    expect(source).toContain("prepareRebuildHermesCurrentFixture({");
    expect(source).toContain('host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"]');
    expect(currentFixtureSource).toContain('const agent = loadAgent("hermes")');
    expect(currentFixtureSource).toContain("input.deps?.ensureBaseImage ?? ensureAgentBaseImage");
    expect(currentFixtureSource).toContain('["gateway", "start", "--name", "nemoclaw"]');
    expect(currentFixtureSource).toContain(
      "input.deps?.resolveDashboardPort ?? resolveCreateSandboxDashboardPort",
    );
    expect(currentFixtureSource).toContain("ownerSandbox: input.sandboxName");

    expect(source).not.toContain('host.nemoclaw(["onboard", "--non-interactive"]');
    expect(source).not.toContain("phase-1-onboard-current-hermes");
    expect(source).not.toContain("phase-1-delete-current-sandbox");
    expect(source).not.toContain("phase-1-remove-initial-hermes-image");
    expect(source).not.toContain("phase-1-stop-hermes-forward");
  });

  it.each([
    [
      "create",
      [
        "provider",
        "create",
        "-g",
        "nemoclaw",
        "--name",
        "compatible-endpoint",
        "--type",
        "openai",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${ENDPOINT}`,
      ],
    ],
    [
      "update",
      [
        "provider",
        "update",
        "-g",
        "nemoclaw",
        "compatible-endpoint",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${ENDPOINT}`,
      ],
    ],
  ] as const)("keeps the exact gateway-scoped compatible provider %s route (#7144)", (action, args) => {
    expect(buildRebuildHermesCompatibleProviderArgs(action, ENDPOINT)).toEqual(args);
  });

  it("keeps inference on the named gateway and compatible provider (#7144)", () => {
    expect(buildRebuildHermesInferenceRouteArgs(MODEL)).toEqual([
      "inference",
      "set",
      "-g",
      "nemoclaw",
      "--no-verify",
      "--provider",
      "compatible-endpoint",
      "--model",
      MODEL,
      "--timeout",
      expect.stringMatching(/^\d+$/u),
    ]);
  });

  it.each([
    ["create", 1],
    ["update", 0],
  ] as const)("executes the exact gateway, provider %s, inference, and port-selection sequence (#7144)", async (action, providerGetExitCode) => {
    const digest = `sha256:${"a".repeat(64)}`;
    const metadata: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: "current-key",
      imageName: IMAGE_NAME,
      ref: `${IMAGE_NAME}@${digest}`,
      digest,
      source: "pinned",
      pinnedRemoteRef: `${IMAGE_NAME}@sha256:${"b".repeat(64)}`,
      imageId: `sha256:${"c".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    };
    const calls: string[][] = [];
    let dashboardInput: Parameters<typeof resolveCreateSandboxDashboardPort>[0] | undefined;
    const host = {
      command: async (command: string, args: string[] = []) => {
        expect(command).toBe("openshell");
        calls.push(args);
        if (args[0] === "provider" && args[1] === "get") {
          return probeResult(args, providerGetExitCode);
        }
        if (args[0] === "forward" && args[1] === "list") {
          return probeResult(args, 0, "FORWARD SNAPSHOT");
        }
        return probeResult(args);
      },
    };

    const result = await prepareRebuildHermesCurrentFixture({
      host,
      sandboxName: "e2e-rebuild-hermes",
      endpointUrl: ENDPOINT,
      model: MODEL,
      env: { CHAT_UI_URL: "" },
      redactionValues: ["secret"],
      deps: {
        ensureBaseImage: () => ({
          imageTag: metadata.ref,
          built: false,
          resolutionMetadata: metadata,
        }),
        resolveDashboardPort: (input) => {
          dashboardInput = input;
          return {
            preferredPort: 18789,
            effectivePort: 18789,
            chatUiUrl: "http://127.0.0.1:18789",
          };
        },
      },
    });

    expect(calls).toEqual([
      ["gateway", "start", "--name", "nemoclaw"],
      ["gateway", "info", "-g", "nemoclaw"],
      ["provider", "get", "-g", "nemoclaw", "compatible-endpoint"],
      buildRebuildHermesCompatibleProviderArgs(action, ENDPOINT),
      buildRebuildHermesInferenceRouteArgs(MODEL),
      ["forward", "list"],
    ]);
    expect(dashboardInput).toMatchObject({
      sandboxName: "e2e-rebuild-hermes",
      controlUiPort: null,
      chatUiUrlEnv: "",
      persistedPort: null,
      agentForwardPort: 18789,
      defaultPort: 18789,
      forwardListOutput: "FORWARD SNAPSHOT",
    });
    expect(result).toMatchObject({
      baseResolution: metadata,
      dashboardPortSelection: {
        ownerSandbox: "e2e-rebuild-hermes",
        preferredPort: 18789,
        effectivePort: 18789,
      },
      inferenceProviderAction: action,
    });
  });
});
