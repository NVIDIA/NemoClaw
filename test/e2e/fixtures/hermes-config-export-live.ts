// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { HERMES_INTERFACE_DEFAULTS } from "../../../src/lib/config/model.ts";
import { fingerprintOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import {
  namedOpenShellGateway,
  cliOpenShellSandboxPolicyReader,
} from "../../../src/lib/adapters/openshell/sandbox-policy-cli.ts";
import { validateNemoClawConfig } from "../../../src/lib/config/schema.ts";
import { load, save } from "../../../src/lib/state/registry/persistence.ts";
import type { ArtifactSink } from "./artifacts.ts";
import type { HostCliClient } from "./clients/host.ts";
import { trustedSandboxShellScript, type SandboxClient } from "./clients/sandbox.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "./paths.ts";

interface HermesConfigExportLiveInput {
  readonly artifacts: ArtifactSink;
  readonly cleanup: CleanupRegistry;
  readonly enabled: boolean;
  readonly dashboardEnabled?: boolean;
  readonly sandbox?: SandboxClient;
  readonly env: NodeJS.ProcessEnv;
  readonly host: HostCliClient;
  readonly redactionValues: readonly string[];
  readonly sandboxName: string;
}

export interface HermesConfigExportLiveResult {
  readonly checked: boolean;
  readonly passed: boolean;
}

export interface HermesConfigExportLiveEvidence {
  readonly agent: string | undefined;
  readonly aliasesEquivalent: boolean;
  readonly checked: true;
  readonly credentialReferenceMatches: boolean;
  readonly credentialValuesOmitted: boolean;
  readonly identityDriftPreventedPublication: boolean;
  readonly identityDriftReported: boolean;
  readonly immutableManagedImageMatches: boolean;
  readonly interfacesMatch: boolean;
  readonly dashboardRuntimeMatches: boolean;
  readonly inferenceEndpointMatches: boolean;
  readonly launchersSucceeded: boolean;
  readonly policyMatches: boolean;
  readonly sandboxNameMatches: boolean;
}

/** Decide the live contract from redacted, serializable observations. */
export function passesHermesConfigExportLiveEvidence(
  evidence: HermesConfigExportLiveEvidence,
): boolean {
  return (
    evidence.agent === "hermes" &&
    evidence.aliasesEquivalent &&
    evidence.credentialReferenceMatches &&
    evidence.credentialValuesOmitted &&
    evidence.identityDriftPreventedPublication &&
    evidence.identityDriftReported &&
    evidence.immutableManagedImageMatches &&
    evidence.interfacesMatch &&
    evidence.dashboardRuntimeMatches &&
    evidence.inferenceEndpointMatches &&
    evidence.launchersSucceeded &&
    evidence.policyMatches &&
    evidence.sandboxNameMatches
  );
}

function hermesTuiEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.NEMOCLAW_HERMES_DASHBOARD_TUI ?? "0").toLowerCase(),
  );
}

function expectedHermesInterfaces(input: HermesConfigExportLiveInput) {
  const port = Number(input.env.NEMOCLAW_DASHBOARD_PORT ?? HERMES_INTERFACE_DEFAULTS.dashboardPort);
  const internalPort = Number(
    input.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ??
      HERMES_INTERFACE_DEFAULTS.dashboardInternalPort,
  );
  const apiPort = Number(input.env.NEMOCLAW_HERMES_API_PORT ?? HERMES_INTERFACE_DEFAULTS.apiPort);
  const api = apiPort === HERMES_INTERFACE_DEFAULTS.apiPort ? undefined : { port: apiPort };
  if (!input.dashboardEnabled) return api ? { api } : undefined;
  return {
    dashboard: {
      enabled: true,
      ...(port === HERMES_INTERFACE_DEFAULTS.dashboardPort ? {} : { port }),
      ...(internalPort === HERMES_INTERFACE_DEFAULTS.dashboardInternalPort ? {} : { internalPort }),
      ...(hermesTuiEnabled(input.env) ? { tui: { enabled: true } } : {}),
    },
    ...(api ? { api } : {}),
  };
}

async function dashboardRuntimeMatches(input: HermesConfigExportLiveInput): Promise<boolean> {
  if (!input.dashboardEnabled) return true;
  if (!input.sandbox) return false;
  const process = await input.sandbox.execShell(
    input.sandboxName,
    trustedSandboxShellScript(
      `ps -eo comm=,args= | awk '
      $1 ~ /^(python[0-9.]*|hermes|hermes.real)$/ && $0 ~ / dashboard / {
        port = ""; tui = "false";
        for (i = 2; i <= NF; i++) {
          if ($i == "--port" && $(i+1) ~ /^[0-9]+$/) port = $(i+1);
          if ($i == "--tui") tui = "true";
        }
        if (port != "") print port " " tui;
      }'`,
    ),
    {
      artifactName: "phase-6-hermes-dashboard-interface-process",
      env: input.env,
      timeoutMs: 30_000,
      redactionValues: [...input.redactionValues],
    },
  );
  const port =
    input.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ??
    HERMES_INTERFACE_DEFAULTS.dashboardInternalPort;
  const expectedTui = hermesTuiEnabled(input.env);
  if (process.exitCode !== 0 || process.stdout.trim() !== `${port} ${String(expectedTui)}`)
    return false;
  const listener = await input.sandbox.exec(
    input.sandboxName,
    [
      "curl",
      "-sS",
      "--max-time",
      "10",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `http://127.0.0.1:${port}/`,
    ],
    {
      artifactName: "phase-6-hermes-dashboard-internal-listener",
      env: input.env,
      timeoutMs: 30_000,
    },
  );
  return listener.exitCode === 0 && /^(200|301|302|307|308)$/.test(listener.stdout.trim());
}

/** Exercise both public CLI names against the configured managed Hermes source. */
export async function verifyHermesConfigExportLive(
  input: HermesConfigExportLiveInput,
): Promise<HermesConfigExportLiveResult> {
  if (!input.enabled) return { checked: false, passed: true };

  const exportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-export-"));
  input.cleanup.trackDisposable("remove private Hermes config export files", () =>
    fs.rmSync(exportDirectory, { recursive: true, force: true }),
  );

  const registry = load();
  const entry = registry.sandboxes[input.sandboxName]!;
  const policy = await cliOpenShellSandboxPolicyReader.readSandboxPolicy({
    target: namedOpenShellGateway(entry.gatewayName ?? ""),
    sandboxName: input.sandboxName,
    scope: "effective",
  });
  const nemoclawPath = path.join(exportDirectory, "nemoclaw.yaml");
  const nemohermesPath = path.join(exportDirectory, "nemohermes.yaml");
  const commonOptions = {
    env: input.env,
    timeoutMs: 120_000,
    redactionValues: [...input.redactionValues],
  };
  const nemoclaw = await input.host.command(
    "node",
    [CLI_ENTRYPOINT, "config", "export", input.sandboxName, "--output", nemoclawPath],
    { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemoclaw" },
  );
  const nemohermes = await input.host.command(
    "node",
    [
      path.join(REPO_ROOT, "bin", "nemohermes.js"),
      "config",
      "export",
      input.sandboxName,
      "--output",
      nemohermesPath,
    ],
    { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemohermes" },
  );

  const launchersSucceeded = nemoclaw.exitCode === 0 && nemohermes.exitCode === 0;
  const nemoclawRaw = nemoclaw.exitCode === 0 ? fs.readFileSync(nemoclawPath, "utf8") : "";
  const nemohermesRaw = nemohermes.exitCode === 0 ? fs.readFileSync(nemohermesPath, "utf8") : "";
  const containsCredential = input.redactionValues.some(
    (value) => value.length > 0 && (nemoclawRaw.includes(value) || nemohermesRaw.includes(value)),
  );
  if (!launchersSucceeded) {
    const evidence: HermesConfigExportLiveEvidence = {
      agent: undefined,
      aliasesEquivalent: false,
      checked: true,
      credentialReferenceMatches: false,
      credentialValuesOmitted: !containsCredential,
      identityDriftPreventedPublication: false,
      identityDriftReported: false,
      immutableManagedImageMatches: false,
      interfacesMatch: false,
      dashboardRuntimeMatches: false,
      inferenceEndpointMatches: false,
      launchersSucceeded,
      policyMatches: false,
      sandboxNameMatches: false,
    };
    await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
    return { checked: true, passed: false };
  }

  const nemoclawDocument = validateNemoClawConfig(YAML.parse(nemoclawRaw));
  const nemohermesDocument = validateNemoClawConfig(YAML.parse(nemohermesRaw));
  const sandbox = nemoclawDocument.spec.sandboxes[0]!;
  const provider = nemoclawDocument.spec.inferenceProviders[0];
  const hostedProvider = provider && !("serving" in provider) ? provider : undefined;
  const expectedPolicy = policy.ok ? YAML.parse(policy.value.document) : null;
  const expectedImage = entry.workload?.kind === "managed-image" ? entry.workload.reference : null;

  const nemoclawMismatchPath = path.join(exportDirectory, "nemoclaw-mismatch.yaml");
  const nemohermesMismatchPath = path.join(exportDirectory, "nemohermes-mismatch.yaml");
  let nemoclawDriftExitCode: number | null = 0;
  let nemohermesDriftExitCode: number | null = 0;
  let nemoclawDriftDiagnostics = "";
  let nemohermesDriftDiagnostics = "";
  try {
    save({
      ...registry,
      sandboxes: {
        ...registry.sandboxes,
        [input.sandboxName]: {
          ...entry,
          lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId(randomUUID())!,
        },
      },
    });
    const nemoclawDrift = await input.host.command(
      "node",
      [CLI_ENTRYPOINT, "config", "export", input.sandboxName, "--output", nemoclawMismatchPath],
      { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemoclaw-drift" },
    );
    const nemohermesDrift = await input.host.command(
      "node",
      [
        path.join(REPO_ROOT, "bin", "nemohermes.js"),
        "config",
        "export",
        input.sandboxName,
        "--output",
        nemohermesMismatchPath,
      ],
      { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemohermes-drift" },
    );
    nemoclawDriftExitCode = nemoclawDrift.exitCode;
    nemohermesDriftExitCode = nemohermesDrift.exitCode;
    nemoclawDriftDiagnostics = [nemoclawDrift.stdout, nemoclawDrift.stderr].join("\n");
    nemohermesDriftDiagnostics = [nemohermesDrift.stdout, nemohermesDrift.stderr].join("\n");
  } finally {
    save(registry);
  }

  const evidence: HermesConfigExportLiveEvidence = {
    aliasesEquivalent: isDeepStrictEqual(nemohermesDocument.spec, nemoclawDocument.spec),
    agent: sandbox.agents[0]?.type,
    checked: true,
    credentialValuesOmitted: !containsCredential,
    credentialReferenceMatches: hostedProvider?.credential?.env === entry.credentialEnv,
    identityDriftPreventedPublication:
      typeof nemoclawDriftExitCode === "number" &&
      nemoclawDriftExitCode !== 0 &&
      typeof nemohermesDriftExitCode === "number" &&
      nemohermesDriftExitCode !== 0 &&
      !fs.existsSync(nemoclawMismatchPath) &&
      !fs.existsSync(nemohermesMismatchPath),
    identityDriftReported:
      nemoclawDriftDiagnostics.includes("drifted") &&
      nemohermesDriftDiagnostics.includes("drifted"),
    immutableManagedImageMatches: sandbox.runtime.image.ref === expectedImage,
    interfacesMatch: isDeepStrictEqual(
      sandbox.agents[0]?.interfaces,
      expectedHermesInterfaces(input),
    ),
    dashboardRuntimeMatches: await dashboardRuntimeMatches(input),
    inferenceEndpointMatches: hostedProvider?.endpoint === entry.endpointUrl,
    launchersSucceeded,
    policyMatches: isDeepStrictEqual(sandbox.network.policy.explicit, expectedPolicy),
    sandboxNameMatches: sandbox.name === input.sandboxName,
  };
  await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
  return { checked: true, passed: passesHermesConfigExportLiveEvidence(evidence) };
}
