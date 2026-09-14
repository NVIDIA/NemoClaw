// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { loadAgent } from "../../../src/lib/agent/defs";
import { parseGatewayInference } from "../../../src/lib/inference/config";
import {
  type CreateSandboxDashboardPortInput,
  type CreateSandboxDashboardPortResult,
  findDashboardForwardOwner,
  resolveCreateSandboxDashboardPort,
} from "../../../src/lib/onboard/dashboard-port";
import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { assertExitZero, type HostCliClient, resultText } from "../fixtures/clients/index.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeOutputEvent, ShellProbeResult } from "../fixtures/shell-probe.ts";
import { requireRebuildHermesCurrentBaseIdentity } from "./rebuild-hermes-base-identity.ts";

const CURRENT_BASE_MARKER = "__NEMOCLAW_REBUILD_HERMES_CURRENT_BASE__";
export const GATEWAY_BOOTSTRAP_MARKER = "__NEMOCLAW_REBUILD_HERMES_GATEWAY_READY__";

export interface RebuildHermesCurrentBaseResult {
  imageTag: string;
  built: boolean;
  resolutionMetadata: SandboxBaseImageResolutionMetadata;
}

export type RebuildHermesChildEnvFactory = (
  apiKey?: string,
  extra?: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;

export interface ResolvedRebuildHermesCurrentBase {
  currentBase: RebuildHermesCurrentBaseResult;
  baseResolution: ReturnType<typeof requireRebuildHermesCurrentBaseIdentity>;
  sourceInspect: ShellProbeResult;
}

interface RebuildHermesBootstrapOptions {
  host: HostCliClient;
  envFactory: RebuildHermesChildEnvFactory;
  redactionValues: string[];
  onOutput: (event: ShellProbeOutputEvent) => void;
}

interface RebuildHermesGatewayBootstrapOptions extends RebuildHermesBootstrapOptions {
  activeOpenshellBin: string;
  apiKey: string;
  artifacts: Pick<ArtifactSink, "writeJson">;
  endpointUrl: string;
  expectedModel: string;
  sandboxName: string;
}

interface RebuildHermesDashboardPortOptions {
  sandboxName: string;
  forwardListOutput: string;
  findAvailablePort?: CreateSandboxDashboardPortInput["findAvailablePort"];
  registryOccupiedPorts?: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`current Hermes base result has invalid ${key}`);
  }
  return value;
}

function requireResolutionMetadata(value: unknown): SandboxBaseImageResolutionMetadata {
  if (!isRecord(value)) {
    throw new Error("current Hermes base result is missing resolutionMetadata");
  }
  requireString(value, "key");
  requireString(value, "imageName");
  requireString(value, "ref");
  requireString(value, "source");
  requireString(value, "imageId");
  requireString(value, "os");
  requireString(value, "architecture");
  requireString(value, "minGlibcVersion");
  if (typeof value.schema !== "number" || !Number.isInteger(value.schema)) {
    throw new Error("current Hermes base result has invalid resolutionMetadata.schema");
  }
  if (value.digest !== null && typeof value.digest !== "string") {
    throw new Error("current Hermes base result has invalid resolutionMetadata.digest");
  }
  if (value.glibcVersion !== null && typeof value.glibcVersion !== "string") {
    throw new Error("current Hermes base result has invalid resolutionMetadata.glibcVersion");
  }
  if (typeof value.requireOpenshellSandboxAbi !== "boolean") {
    throw new Error(
      "current Hermes base result has invalid resolutionMetadata.requireOpenshellSandboxAbi",
    );
  }
  return value as SandboxBaseImageResolutionMetadata;
}

export function buildRebuildHermesCurrentBaseScript(): string {
  return [
    '"use strict";',
    'const { loadAgent } = require("./dist/lib/agent/defs");',
    'const { ensureAgentBaseImage } = require("./dist/lib/agent/onboard");',
    "try {",
    '  const result = ensureAgentBaseImage(loadAgent("hermes"));',
    "  const evidence = {",
    "    imageTag: result.imageTag,",
    "    built: result.built,",
    "    resolutionMetadata: result.resolutionMetadata || null,",
    "  };",
    '  const payload = Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url");',
    `  console.log(${JSON.stringify(CURRENT_BASE_MARKER)} + payload);`,
    "} catch (error) {",
    "  console.error(error && error.stack ? error.stack : String(error));",
    "  process.exit(3);",
    "}",
  ].join("\n");
}

export function parseRebuildHermesCurrentBaseResult(
  output: string,
): RebuildHermesCurrentBaseResult {
  const markerPattern = new RegExp(`^${CURRENT_BASE_MARKER}([A-Za-z0-9_-]+)$`, "gm");
  const matches = [...output.matchAll(markerPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `current Hermes base resolver must emit exactly one evidence marker; received ${matches.length}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("current Hermes base resolver emitted malformed evidence", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("current Hermes base resolver emitted a non-object result");
  }
  const imageTag = requireString(parsed, "imageTag");
  if (typeof parsed.built !== "boolean") {
    throw new Error("current Hermes base result has invalid built");
  }
  return {
    imageTag,
    built: parsed.built,
    resolutionMetadata: requireResolutionMetadata(parsed.resolutionMetadata),
  };
}

export function requirePublishedRebuildHermesCurrentBase(
  currentBase: RebuildHermesCurrentBaseResult,
): ReturnType<typeof requireRebuildHermesCurrentBaseIdentity> {
  if (currentBase.built) {
    throw new Error(
      "rebuild-Hermes requires the published current base; it must not build a replacement",
    );
  }
  if (currentBase.imageTag !== currentBase.resolutionMetadata.ref) {
    throw new Error(
      "current-base resolver imageTag does not match its immutable resolution metadata",
    );
  }
  const baseResolution = requireRebuildHermesCurrentBaseIdentity(currentBase.resolutionMetadata);
  if (
    baseResolution.source !== "pinned" ||
    !baseResolution.digest ||
    !baseResolution.pinnedRemoteRef
  ) {
    throw new Error(
      "rebuild-Hermes hosted coverage requires the published Dockerfile-pinned current base",
    );
  }
  return baseResolution;
}

export function buildRebuildHermesGatewayBootstrapScript(): string {
  return [
    '"use strict";',
    'const { setupInference, startGatewayForRecovery } = require("./dist/lib/onboard");',
    "const model = process.env.NEMOCLAW_MODEL;",
    "const endpoint = process.env.NEMOCLAW_ENDPOINT_URL;",
    "if (!model || !endpoint || !process.env.COMPATIBLE_API_KEY) {",
    '  throw new Error("Hermes gateway bootstrap is missing model, endpoint, or credential");',
    "}",
    "Promise.resolve()",
    '  .then(() => startGatewayForRecovery({ gatewayName: "nemoclaw" }))',
    "  .then(() =>",
    "    setupInference(",
    "      null,",
    "      model,",
    '      "compatible-endpoint",',
    "      endpoint,",
    '      "COMPATIBLE_API_KEY",',
    "      null,",
    "      [],",
    '      { gatewayName: "nemoclaw", preferredInferenceApi: "openai-completions" },',
    "    ),",
    "  )",
    "  .then((result) => {",
    "    if (!result || result.ok !== true) {",
    '      throw new Error("Hermes gateway inference setup did not complete");',
    "    }",
    `    console.log(${JSON.stringify(GATEWAY_BOOTSTRAP_MARKER)});`,
    "  })",
    "  .catch((error) => {",
    "    console.error(error && error.stack ? error.stack : String(error));",
    "    process.exit(3);",
    "  });",
  ].join("\n");
}

export function requireRebuildHermesOpenshellBin(host: HostCliClient): string {
  const openshellBin = process.env.OPENSHELL_BIN?.trim() ?? "";
  if (!path.isAbsolute(openshellBin)) {
    throw new Error("rebuild-Hermes requires absolute OPENSHELL_BIN");
  }
  if (path.resolve(host.openshellCommandPath) !== openshellBin) {
    throw new Error(
      "fixture and product children must use the same workflow-selected OpenShell binary",
    );
  }
  try {
    fs.accessSync(openshellBin, fs.constants.X_OK);
  } catch (error) {
    throw new Error(`workflow-selected OpenShell binary is not executable: ${openshellBin}`, {
      cause: error,
    });
  }
  return openshellBin;
}

export function buildRebuildHermesCurrentBaseEnv(
  envFactory: RebuildHermesChildEnvFactory,
  activeOpenshellBin: string,
): NodeJS.ProcessEnv {
  const env = envFactory(undefined, {
    NEMOCLAW_OPENSHELL_BIN: activeOpenshellBin,
    NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
  });
  if (env.NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF !== undefined) {
    throw new Error("current-base resolver inherited an ambient Hermes base override");
  }
  if (env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD !== "0") {
    throw new Error("current-base resolver must disable local base construction");
  }
  return env;
}

export async function cleanupRebuildHermesForward(
  host: HostCliClient,
  envFactory: RebuildHermesChildEnvFactory,
  apiKey: string | undefined,
  sandboxName: string,
  port: number,
  redactionValues: string[],
): Promise<"stopped" | "owned-other" | "no-entry"> {
  const list = await host.command(host.openshellCommandPath, ["forward", "list"], {
    artifactName: `cleanup-hermes-rebuild-resources-forward-list-${port}`,
    env: envFactory(apiKey),
    redactionValues,
    timeoutMs: 2 * 60_000,
  });
  assertExitZero(list, `inspect Hermes forward ${port} ownership before cleanup`);
  const owner = findDashboardForwardOwner(resultText(list), String(port));
  if (owner !== null && owner !== sandboxName) {
    return "owned-other";
  }
  const result = await host.command(
    host.openshellCommandPath,
    ["forward", "stop", String(port), sandboxName],
    {
      artifactName: `cleanup-hermes-rebuild-resources-forward-stop-${port}`,
      env: envFactory(apiKey),
      redactionValues,
      timeoutMs: 3 * 60_000,
    },
  );
  assertCleanupSucceededOrAbsent(
    result,
    /no (?:active )?forward|forward[^\n]*(?:not found|not running)|forward stop[^\n]*not running/iu,
    `cleanup Hermes forward ${port}`,
  );
  return owner === sandboxName ? "stopped" : "no-entry";
}

export async function resolveRebuildHermesCurrentBase(
  options: RebuildHermesBootstrapOptions & { activeOpenshellBin: string },
): Promise<ResolvedRebuildHermesCurrentBase> {
  const currentBaseEnv = buildRebuildHermesCurrentBaseEnv(
    options.envFactory,
    options.activeOpenshellBin,
  );
  const currentBaseResult = await options.host.command(
    process.execPath,
    ["-e", buildRebuildHermesCurrentBaseScript()],
    {
      artifactName: "phase-1-resolve-current-hermes-base",
      cwd: REPO_ROOT,
      env: currentBaseEnv,
      redactionValues: options.redactionValues,
      timeoutMs: 20 * 60_000,
      captureLimitBytes: 4 * 1024 * 1024,
      onOutput: options.onOutput,
    },
  );
  assertExitZero(currentBaseResult, "resolve current Hermes base without creating a sandbox");
  const currentBase = parseRebuildHermesCurrentBaseResult(resultText(currentBaseResult));
  const baseResolution = requirePublishedRebuildHermesCurrentBase(currentBase);
  const sourceInspect = await options.host.command(
    "docker",
    ["image", "inspect", "--format", "{{json .}}", baseResolution.ref],
    {
      artifactName: "phase-1-inspect-current-hermes-base-source",
      env: buildAvailabilityProbeEnv(),
      redactionValues: options.redactionValues,
      timeoutMs: 2 * 60_000,
    },
  );
  assertExitZero(sourceInspect, "inspect phase 1 current Hermes base source");
  return { currentBase, baseResolution, sourceInspect };
}

export async function requireRebuildHermesHostedInferenceRoute(
  host: HostCliClient,
  envFactory: RebuildHermesChildEnvFactory,
  apiKey: string,
  expectedModel: string,
  artifactName: string,
  redactionValues: string[],
): Promise<{ provider: string; model: string }> {
  const routeProbe = await host.command(
    host.openshellCommandPath,
    ["inference", "get", "-g", "nemoclaw"],
    {
      artifactName,
      env: envFactory(apiKey),
      redactionValues,
      timeoutMs: 2 * 60_000,
    },
  );
  assertExitZero(routeProbe, "inspect NemoClaw hosted inference route");
  const route = parseGatewayInference(resultText(routeProbe));
  const normalizedExpectedModel = expectedModel.trim();
  if (
    !normalizedExpectedModel ||
    route?.provider !== "compatible-endpoint" ||
    route.model !== normalizedExpectedModel
  ) {
    throw new Error(
      `NemoClaw gateway route drifted from compatible-endpoint/${normalizedExpectedModel || "<missing model>"}: ${JSON.stringify(route)}`,
    );
  }
  return { provider: route.provider, model: route.model };
}

export function requireRebuildHermesDashboardPort(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 65_535 ||
    value === 8642
  ) {
    throw new Error(`${label} must be a valid non-API dashboard port; received ${String(value)}`);
  }
  return value;
}

export interface RebuildHermesRejectedDashboardPort {
  source: "cleanup registry dashboardPort";
  received: string;
  error: string;
}

export function trackRebuildHermesCleanupPort(
  ports: Set<number>,
  value: unknown,
): RebuildHermesRejectedDashboardPort | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    ports.add(requireRebuildHermesDashboardPort(value, "cleanup registry dashboardPort"));
    return null;
  } catch (error) {
    return {
      source: "cleanup registry dashboardPort",
      received: String(value),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupRebuildHermesTrackedForwards(
  ports: Set<number>,
  recordedDashboardPort: unknown,
  cleanupForward: (port: number) => Promise<unknown>,
  writeEvidence: (evidence: {
    rejectedPort: RebuildHermesRejectedDashboardPort | null;
  }) => Promise<unknown>,
): Promise<void> {
  const rejectedPort = trackRebuildHermesCleanupPort(ports, recordedDashboardPort);
  const failures: unknown[] = [];
  try {
    for (const port of ports) {
      try {
        await cleanupForward(port);
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    try {
      await writeEvidence({ rejectedPort });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Hermes tracked forward cleanup failed");
  }
}

export function resolveRebuildHermesDashboardPort(
  options: RebuildHermesDashboardPortOptions,
): CreateSandboxDashboardPortResult {
  const hermesAgent = loadAgent("hermes");
  if (hermesAgent.forwardPort !== 18789) {
    throw new Error(
      `Hermes manifest dashboard port must be 18789; received ${hermesAgent.forwardPort}`,
    );
  }
  const dashboard = resolveCreateSandboxDashboardPort({
    sandboxName: options.sandboxName,
    controlUiPort: null,
    chatUiUrlEnv: null,
    persistedPort: null,
    agentForwardPort: hermesAgent.forwardPort,
    forwardListOutput: options.forwardListOutput,
    ...(options.findAvailablePort ? { findAvailablePort: options.findAvailablePort } : {}),
    ...(options.registryOccupiedPorts
      ? { registryOccupiedPorts: options.registryOccupiedPorts }
      : {}),
  });
  requireRebuildHermesDashboardPort(dashboard.effectivePort, "allocated Hermes dashboard port");
  return dashboard;
}

export async function bootstrapRebuildHermesGateway(
  options: RebuildHermesGatewayBootstrapOptions,
): Promise<{ dashboardPort: number; route: { provider: string; model: string } }> {
  const gatewayBootstrap = await options.host.command(
    process.execPath,
    ["-e", buildRebuildHermesGatewayBootstrapScript()],
    {
      artifactName: "phase-1-bootstrap-hermes-gateway-inference",
      cwd: REPO_ROOT,
      env: options.envFactory(options.apiKey, {
        NEMOCLAW_OPENSHELL_BIN: options.activeOpenshellBin,
      }),
      redactionValues: options.redactionValues,
      timeoutMs: 10 * 60_000,
      captureLimitBytes: 4 * 1024 * 1024,
      onOutput: options.onOutput,
    },
  );
  assertExitZero(gatewayBootstrap, "bootstrap NemoClaw gateway and hosted inference route");
  if (!resultText(gatewayBootstrap).includes(GATEWAY_BOOTSTRAP_MARKER)) {
    throw new Error("Hermes gateway bootstrap did not emit its completion marker");
  }

  const gatewayProbe = await options.host.command(
    options.activeOpenshellBin,
    ["gateway", "info", "-g", "nemoclaw"],
    {
      artifactName: "phase-1-gateway-probe",
      env: options.envFactory(options.apiKey),
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(gatewayProbe, "product bootstrap must leave a reusable 'nemoclaw' gateway");
  const route = await requireRebuildHermesHostedInferenceRoute(
    options.host,
    options.envFactory,
    options.apiKey,
    options.expectedModel,
    "phase-1-inference-route",
    options.redactionValues,
  );

  const forwardList = await options.host.command(options.activeOpenshellBin, ["forward", "list"], {
    artifactName: "phase-1-forward-list-before-historical-sandbox",
    env: options.envFactory(options.apiKey),
    redactionValues: options.redactionValues,
    timeoutMs: 2 * 60_000,
  });
  assertExitZero(
    forwardList,
    "inspect occupied forwards before historical Hermes sandbox creation",
  );
  const dashboard = resolveRebuildHermesDashboardPort({
    sandboxName: options.sandboxName,
    forwardListOutput: resultText(forwardList),
  });
  await options.artifacts.writeJson("phase-1-gateway-inference-bootstrap.json", {
    gateway: "nemoclaw",
    route,
    requestedRoute: {
      provider: "compatible-endpoint",
      model: options.expectedModel,
      endpointUrl: options.endpointUrl,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    },
    dashboard,
    apiPort: 8642,
  });
  return { dashboardPort: dashboard.effectivePort, route };
}
