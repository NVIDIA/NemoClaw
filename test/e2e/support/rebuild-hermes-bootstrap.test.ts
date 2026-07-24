// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { findAvailableDashboardPort } from "../../../src/lib/onboard/dashboard-port";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  buildRebuildHermesCurrentBaseEnv,
  buildRebuildHermesCurrentBaseScript,
  buildRebuildHermesGatewayBootstrapScript,
  GATEWAY_BOOTSTRAP_MARKER,
  parseRebuildHermesCurrentBaseResult,
  requirePublishedRebuildHermesCurrentBase,
  requireRebuildHermesDashboardPort,
  requireRebuildHermesHostedInferenceRoute,
  resolveRebuildHermesCurrentBase,
  resolveRebuildHermesDashboardPort,
} from "../live/rebuild-hermes-bootstrap.ts";

const RESOLUTION = {
  schema: 1,
  key: "resolution-key",
  imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
  ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  source: "pinned",
  pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
  imageId: `sha256:${"b".repeat(64)}`,
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.39",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
} as const;

function encodedResult(overrides: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      imageTag: RESOLUTION.ref,
      built: false,
      resolutionMetadata: RESOLUTION,
      ...overrides,
    }),
    "utf8",
  ).toString("base64url");
  return `resolver noise\n__NEMOCLAW_REBUILD_HERMES_CURRENT_BASE__${payload}\n`;
}

function probe(stdout: string, exitCode = 0, stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

function fakeHost(results: ShellProbeResult[]) {
  const command = vi.fn(async (..._args: unknown[]) => results.shift() ?? probe(""));
  return {
    command,
    host: {
      command,
      openshellCommandPath: "/opt/openshell",
    } as unknown as HostCliClient,
  };
}

const envFactory = (_apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  ...extra,
});

const deterministicDashboardPort = (
  sandboxName: string,
  preferredPort: number,
  forwardListOutput: string | null,
) =>
  findAvailableDashboardPort(sandboxName, preferredPort, forwardListOutput, () => false, new Map());

describe("rebuild-Hermes direct bootstrap", () => {
  it("resolves the current base without onboarding or constructing a sandbox (#7144)", () => {
    const script = buildRebuildHermesCurrentBaseScript();

    expect(script).toContain('ensureAgentBaseImage(loadAgent("hermes"))');
    expect(script).not.toContain("forceBaseImageRebuild");
    expect(script).not.toContain("createAgentSandbox");
    expect(script).not.toContain("onboard(");
  });

  it("parses one bounded current-base evidence marker (#7144)", () => {
    expect(parseRebuildHermesCurrentBaseResult(encodedResult())).toEqual({
      imageTag: RESOLUTION.ref,
      built: false,
      resolutionMetadata: RESOLUTION,
    });
  });

  it("rejects missing, duplicate, and malformed current-base evidence (#7144)", () => {
    expect(() => parseRebuildHermesCurrentBaseResult("no marker")).toThrow(
      /exactly one evidence marker/,
    );
    expect(() =>
      parseRebuildHermesCurrentBaseResult(`${encodedResult()}${encodedResult()}`),
    ).toThrow(/received 2/);
    expect(() =>
      parseRebuildHermesCurrentBaseResult("__NEMOCLAW_REBUILD_HERMES_CURRENT_BASE__bm90LWpzb24\n"),
    ).toThrow(/malformed evidence/);
    expect(() => parseRebuildHermesCurrentBaseResult(encodedResult({ built: "false" }))).toThrow(
      /invalid built/,
    );
    expect(() =>
      parseRebuildHermesCurrentBaseResult(encodedResult({ resolutionMetadata: null })),
    ).toThrow(/missing resolutionMetadata/);
  });

  it("accepts only the published Dockerfile-pinned current base (#7144)", () => {
    const published = parseRebuildHermesCurrentBaseResult(encodedResult());
    expect(requirePublishedRebuildHermesCurrentBase(published)).toEqual(RESOLUTION);

    expect(() => requirePublishedRebuildHermesCurrentBase({ ...published, built: true })).toThrow(
      /must not build a replacement/,
    );
    expect(() =>
      requirePublishedRebuildHermesCurrentBase({ ...published, imageTag: "wrong:tag" }),
    ).toThrow(/imageTag does not match/);
    expect(() =>
      requirePublishedRebuildHermesCurrentBase({
        ...published,
        imageTag: "nemoclaw-hermes-sandbox-base-local:cached",
        resolutionMetadata: {
          ...RESOLUTION,
          ref: "nemoclaw-hermes-sandbox-base-local:cached",
          digest: null,
          source: "local",
          pinnedRemoteRef: undefined,
        },
      }),
    ).toThrow(/requires the published Dockerfile-pinned current base/);
  });

  it("fails before Docker inspect for built or overridden current bases (#7144)", async () => {
    const builtHost = fakeHost([probe(encodedResult({ built: true }))]);
    await expect(
      resolveRebuildHermesCurrentBase({
        host: builtHost.host,
        activeOpenshellBin: "/opt/openshell",
        envFactory,
        redactionValues: [],
        onOutput: () => {},
      }),
    ).rejects.toThrow(/must not build a replacement/);
    expect(builtHost.command).toHaveBeenCalledTimes(1);

    const overriddenHost = fakeHost([]);
    await expect(
      resolveRebuildHermesCurrentBase({
        host: overriddenHost.host,
        activeOpenshellBin: "/opt/openshell",
        envFactory: (_apiKey, extra = {}) => ({
          ...extra,
          NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: "untrusted:latest",
        }),
        redactionValues: [],
        onOutput: () => {},
      }),
    ).rejects.toThrow(/ambient Hermes base override/);
    expect(overriddenHost.command).not.toHaveBeenCalled();
  });

  it("locks current-base resolution to no-local-build mode (#7144)", () => {
    expect(buildRebuildHermesCurrentBaseEnv(envFactory, "/opt/openshell")).toMatchObject({
      NEMOCLAW_OPENSHELL_BIN: "/opt/openshell",
      NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
    });
    expect(() =>
      buildRebuildHermesCurrentBaseEnv((_apiKey, extra = {}) => {
        return { ...extra, NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1" };
      }, "/opt/openshell"),
    ).toThrow(/must disable local base construction/);
  });

  it("starts the product gateway and configures its exact hosted route (#7144)", () => {
    const script = buildRebuildHermesGatewayBootstrapScript();

    expect(script).toContain('startGatewayForRecovery({ gatewayName: "nemoclaw" })');
    expect(script).toContain("setupInference(");
    expect(script).toContain('"compatible-endpoint"');
    expect(script).toContain('gatewayName: "nemoclaw"');
    expect(script).toContain('preferredInferenceApi: "openai-completions"');
    expect(script).toContain(GATEWAY_BOOTSTRAP_MARKER);
    expect(script).not.toContain("startGateway(null)");
    expect(script).not.toContain('["gateway", "start"');
    expect(script).not.toContain("onboard(");
    expect(script).not.toContain("sandbox create");
  });

  it("requires the exact compatible-endpoint provider and model (#7144)", async () => {
    const expectedModel = "nvidia/example-model";
    const routeOutput = [
      "Gateway inference:",
      "",
      "  Provider: compatible-endpoint",
      `  Model: ${expectedModel}`,
    ].join("\n");
    const exactHost = fakeHost([probe(routeOutput)]);
    await expect(
      requireRebuildHermesHostedInferenceRoute(
        exactHost.host,
        envFactory,
        "secret",
        expectedModel,
        "route",
        ["secret"],
      ),
    ).resolves.toEqual({ provider: "compatible-endpoint", model: expectedModel });

    for (const output of [
      routeOutput.replace("compatible-endpoint", "nvidia-prod"),
      routeOutput.replace(expectedModel, "wrong/model"),
    ]) {
      const driftedHost = fakeHost([probe(output)]);
      await expect(
        requireRebuildHermesHostedInferenceRoute(
          driftedHost.host,
          envFactory,
          "secret",
          expectedModel,
          "route",
          ["secret"],
        ),
      ).rejects.toThrow(/gateway route drifted/);
    }

    const failedHost = fakeHost([probe("", 1, "gateway unavailable")]);
    await expect(
      requireRebuildHermesHostedInferenceRoute(
        failedHost.host,
        envFactory,
        "secret",
        expectedModel,
        "route",
        ["secret"],
      ),
    ).rejects.toThrow(/gateway unavailable/);
  });

  it("uses Hermes dashboard port 18789 or a safe alternate, never API port 8642 (#7144)", () => {
    expect(
      resolveRebuildHermesDashboardPort({
        sandboxName: "e2e-rebuild-hermes-port",
        forwardListOutput: "",
        findAvailablePort: deterministicDashboardPort,
        registryOccupiedPorts: new Map(),
      }).effectivePort,
    ).toBe(18789);
    expect(
      resolveRebuildHermesDashboardPort({
        sandboxName: "e2e-rebuild-hermes-port",
        forwardListOutput: "other 127.0.0.1 18789 99 running",
        findAvailablePort: deterministicDashboardPort,
        registryOccupiedPorts: new Map(),
      }).effectivePort,
    ).toBe(18790);
    expect(() =>
      resolveRebuildHermesDashboardPort({
        sandboxName: "e2e-rebuild-hermes-port",
        forwardListOutput: "",
        findAvailablePort: () => 8642,
        registryOccupiedPorts: new Map(),
      }),
    ).toThrow(/valid non-API dashboard port/);
    expect(() => requireRebuildHermesDashboardPort(undefined, "registry dashboardPort")).toThrow(
      /valid non-API dashboard port/,
    );
  });
});
