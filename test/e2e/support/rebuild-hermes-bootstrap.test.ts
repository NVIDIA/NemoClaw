// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findAvailableDashboardPort } from "../../../src/lib/onboard/dashboard-port";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  bootstrapRebuildHermesGateway,
  buildRebuildHermesCurrentBaseEnv,
  buildRebuildHermesCurrentBaseScript,
  buildRebuildHermesGatewayBootstrapScript,
  cleanupRebuildHermesForward,
  cleanupRebuildHermesTrackedForwards,
  GATEWAY_BOOTSTRAP_MARKER,
  parseRebuildHermesCurrentBaseResult,
  requirePublishedRebuildHermesCurrentBase,
  requireRebuildHermesDashboardPort,
  requireRebuildHermesHostedInferenceRoute,
  requireRebuildHermesOpenshellBin,
  resolveRebuildHermesCurrentBase,
  resolveRebuildHermesDashboardPort,
  trackRebuildHermesCleanupPort,
} from "../live/rebuild-hermes-bootstrap.ts";
import { REBUILD_HERMES_PHASES } from "../live/rebuild-hermes-phases.ts";

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

  it("accepts only the workflow-selected executable OpenShell binary (#7144)", () => {
    const host = fakeHost([]).host;
    const access = vi.spyOn(fs, "accessSync");
    try {
      vi.stubEnv("OPENSHELL_BIN", "");
      expect(() => requireRebuildHermesOpenshellBin(host)).toThrow(/requires absolute/);

      vi.stubEnv("OPENSHELL_BIN", "relative/openshell");
      expect(() => requireRebuildHermesOpenshellBin(host)).toThrow(/requires absolute/);

      vi.stubEnv("OPENSHELL_BIN", "/opt/other-openshell");
      expect(() => requireRebuildHermesOpenshellBin(host)).toThrow(/must use the same/);

      vi.stubEnv("OPENSHELL_BIN", "/opt/openshell");
      access.mockImplementationOnce(() => {
        throw new Error("permission denied");
      });
      expect(() => requireRebuildHermesOpenshellBin(host)).toThrow(/not executable/);

      access.mockImplementation(() => undefined);
      expect(requireRebuildHermesOpenshellBin(host)).toBe("/opt/openshell");
      expect(access).toHaveBeenLastCalledWith("/opt/openshell", fs.constants.X_OK);
    } finally {
      vi.unstubAllEnvs();
      access.mockRestore();
    }
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

  it("stops before gateway probes when bootstrap omits completion evidence (#7144)", async () => {
    const markerlessHost = fakeHost([probe("gateway setup returned without completion evidence")]);
    const writeJson = vi.fn(async (_name: string, _value: unknown) => "unused-artifact.json");

    await expect(
      bootstrapRebuildHermesGateway({
        host: markerlessHost.host,
        envFactory,
        redactionValues: ["secret"],
        onOutput: () => {},
        activeOpenshellBin: "/opt/openshell",
        apiKey: "secret",
        artifacts: { writeJson },
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        expectedModel: "nvidia/example-model",
        sandboxName: "e2e-rebuild-hermes-markerless",
      }),
    ).rejects.toThrow(/completion marker/);

    expect(markerlessHost.command).toHaveBeenCalledTimes(1);
    expect(markerlessHost.command.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(writeJson).not.toHaveBeenCalled();
  });

  it.each([{ scenario: "wrong provider" }, { scenario: "wrong model" }])(
    "requires the exact compatible-endpoint provider and model [$scenario] (#7144)",
    async ({ scenario }) => {
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

      const output = (
        {
          "wrong provider": routeOutput.replace("compatible-endpoint", "nvidia-prod"),
          "wrong model": routeOutput.replace(expectedModel, "wrong/model"),
        } as const
      )[scenario]!;
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
    },
  );

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
    const cleanupPorts = new Set<number>();
    expect(trackRebuildHermesCleanupPort(cleanupPorts, 18791)).toBeNull();
    expect(trackRebuildHermesCleanupPort(cleanupPorts, undefined)).toBeNull();
    expect(trackRebuildHermesCleanupPort(cleanupPorts, "not-a-port")).toEqual({
      source: "cleanup registry dashboardPort",
      received: "not-a-port",
      error: expect.stringMatching(/valid non-API dashboard port/),
    });
    expect([...cleanupPorts]).toEqual([18791]);
  });

  it("stops only sandbox-owned Hermes forwards and fails closed on list errors (#7144)", async () => {
    const own = fakeHost([
      probe("SANDBOX BIND PORT PID STATUS\nhermes-box 127.0.0.1 18789 42 running"),
      probe(""),
    ]);
    await expect(
      cleanupRebuildHermesForward(own.host, envFactory, "secret", "hermes-box", 18789, ["secret"]),
    ).resolves.toBe("stopped");
    expect(own.command.mock.calls[1]?.[1]).toEqual(["forward", "stop", "18789", "hermes-box"]);

    const other = fakeHost([
      probe("SANDBOX BIND PORT PID STATUS\nother-box 127.0.0.1 18789 43 running"),
    ]);
    await expect(
      cleanupRebuildHermesForward(other.host, envFactory, "secret", "hermes-box", 18789, [
        "secret",
      ]),
    ).resolves.toBe("owned-other");
    expect(other.command).toHaveBeenCalledTimes(1);

    const absent = fakeHost([probe(""), probe("", 1, "forward not running")]);
    await expect(
      cleanupRebuildHermesForward(absent.host, envFactory, "secret", "hermes-box", 18789, [
        "secret",
      ]),
    ).resolves.toBe("no-entry");
    expect(absent.command.mock.calls[1]?.[1]).toEqual(["forward", "stop", "18789", "hermes-box"]);

    const unavailable = fakeHost([probe("", 1, "gateway unavailable")]);
    await expect(
      cleanupRebuildHermesForward(unavailable.host, envFactory, "secret", "hermes-box", 18789, [
        "secret",
      ]),
    ).rejects.toThrow(/gateway unavailable/);
    expect(unavailable.command).toHaveBeenCalledTimes(1);
  });

  it("records malformed captured ports without stopping foreign forwards (#7144)", async () => {
    const foreign = fakeHost([
      probe("SANDBOX BIND PORT PID STATUS\nother-box 127.0.0.1 18789 43 running"),
    ]);
    const writeEvidence = vi.fn(async (_evidence: unknown) => undefined);

    await cleanupRebuildHermesTrackedForwards(
      new Set([18789]),
      "not-a-port",
      (port) =>
        cleanupRebuildHermesForward(foreign.host, envFactory, "secret", "hermes-box", port, [
          "secret",
        ]),
      writeEvidence,
    );

    expect(foreign.command).toHaveBeenCalledTimes(1);
    expect(writeEvidence).toHaveBeenCalledWith({
      rejectedPort: {
        source: "cleanup registry dashboardPort",
        received: "not-a-port",
        error: expect.stringMatching(/valid non-API dashboard port/),
      },
    });
  });

  it("releases tracked forwards before propagating cleanup artifact failures (#7144)", async () => {
    const cleanupForward = vi.fn(async (_port: number) => undefined);
    const writeEvidence = vi.fn(async (_evidence: unknown) => {
      throw new Error("artifact disk full");
    });

    await expect(
      cleanupRebuildHermesTrackedForwards(
        new Set([18789]),
        undefined,
        cleanupForward,
        writeEvidence,
      ),
    ).rejects.toThrow(/artifact disk full/);
    expect(cleanupForward).toHaveBeenCalledWith(18789);
  });

  it("attempts every tracked forward before propagating cleanup failures (#7144)", async () => {
    const cleanupForward = vi.fn(async (port: number) => {
      throw new Error(`${port} cleanup failed`);
    });
    const writeEvidence = vi.fn(async (_evidence: unknown) => undefined);

    const failure = await cleanupRebuildHermesTrackedForwards(
      new Set([18789, 8642]),
      undefined,
      cleanupForward,
      writeEvidence,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      new Error("18789 cleanup failed"),
      new Error("8642 cleanup failed"),
    ]);
    expect(cleanupForward.mock.calls.map(([port]) => port)).toEqual([18789, 8642]);
    expect(writeEvidence).toHaveBeenCalledWith({ rejectedPort: null });
  });

  it("keeps superseded live rebuild paths unreachable (#7144)", () => {
    const liveSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../live/rebuild-hermes.test.ts"),
      "utf8",
    );

    expect(liveSource).not.toContain('host.nemoclaw(["onboard"');
    expect(liveSource).not.toContain("phase-1-delete-current-sandbox");
    expect(liveSource).not.toContain("phase-1-remove-initial-hermes-image");
    expect(liveSource).not.toContain("phase-1-stop-hermes-forward");
    expect(liveSource).not.toContain('"--cleanup-gateway"');
    expect(liveSource).not.toMatch(/host\.command\(\s*["']openshell["']/u);
    expect(liveSource).not.toMatch(/^\s*['"`]openshell\s/mu);
    expect(liveSource.indexOf("const sessionSummary = seedRegistryAndSession(")).toBeLessThan(
      liveSource.indexOf("await cronRestore.seed();"),
    );
  });

  it("retains the eight-phase rebuild contract with truthful bootstrap coverage (#7144)", () => {
    expect(REBUILD_HERMES_PHASES).toEqual([
      "confirm Docker and prepare Hermes rebuild resources",
      "prepare trusted gateway inference and the current Hermes base",
      "pull and verify the historical Hermes base fixture",
      "create the historical Hermes sandbox",
      "seed persistent Hermes state and registry metadata",
      "prepare the current-base rebuild condition",
      "rebuild the Hermes sandbox",
      "validate upgraded state inference and backup hygiene",
    ]);
  });
});
