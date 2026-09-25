// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { HERMES_INTERFACE_DEFAULTS } from "../../../src/lib/config/model.ts";
import {
  V1ALPHA1_RUNTIME_DEFAULTS,
  V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
} from "../../../src/lib/domain/config/v1alpha1-runtime-defaults.ts";
import { fingerprintOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import {
  namedOpenShellGateway,
  cliOpenShellSandboxPolicyReader,
} from "../../../src/lib/adapters/openshell/sandbox-policy-cli.ts";
import { load, save } from "../../../src/lib/state/registry/persistence.ts";
import type { ArtifactSink } from "./artifacts.ts";
import type { HostCliClient } from "./clients/host.ts";
import { trustedSandboxShellScript, type SandboxClient } from "./clients/sandbox.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "./paths.ts";
import {
  expectedPinnedV1HermesNativeSettings,
  type PinnedV1ConsumerEvidence,
  validateConfigExportWithPinnedV1,
} from "../../support/v1-config-consumer.ts";
import {
  inspectConfigExportArtifactSafety,
  parseConfigExport,
} from "./phases/config-export-validation.ts";

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
  readonly validateWithPinnedV1?: (raw: string) => PinnedV1ConsumerEvidence;
}

export interface HermesConfigExportLiveResult {
  readonly checked: boolean;
  readonly passed: boolean;
}

interface HermesConfigExportPublishedEvidence {
  readonly outcome: "published";
  readonly agent: string | undefined;
  readonly aliasesEquivalent: boolean;
  readonly checked: true;
  readonly consumer: HermesPinnedV1ConsumerEvidence;
  readonly credentialReferenceMatches: boolean;
  readonly credentialValuesOmitted: boolean;
  readonly identityDriftPreventedPublication: boolean;
  readonly identityDriftReported: boolean;
  readonly managedImageIsOmitted: boolean;
  readonly interfacesMatch: boolean;
  readonly dashboardRuntimeMatches: boolean;
  readonly inferenceEndpointMatches: boolean;
  readonly launchersSucceeded: boolean;
  readonly policyMatches: boolean;
  readonly sandboxNameMatches: boolean;
}

interface HermesPinnedV1ConsumerEvidence {
  readonly expected: PinnedV1ConsumerEvidence;
  readonly actual: Partial<Record<"nemoclaw" | "nemohermes", PinnedV1ConsumerEvidence>>;
  readonly passed: boolean;
}

interface HermesConfigExportExpectedRefusalEvidence {
  readonly outcome: "expected-refusal";
  readonly aliasesEquivalent: boolean;
  readonly checked: true;
  readonly credentialValuesOmitted: boolean;
  readonly outputFilesAbsent: boolean;
  readonly refusalCategory: "unsupported" | null;
  readonly refusalDiagnosticMatches: boolean;
}

export type HermesConfigExportLiveEvidence =
  | HermesConfigExportPublishedEvidence
  | HermesConfigExportExpectedRefusalEvidence;

const CREDENTIAL_HTTP_REFUSAL =
  "V1alpha1 requires HTTPS when an inference provider declares a credential.";
const PODMAN_REFUSAL =
  "V1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred.";

function normalizeCommandDiagnostics(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((output) => output.replace(/\r\n?/g, "\n").trim())
    .filter((output) => output.length > 0)
    .join("\n");
}

/** Decide the live contract from redacted, serializable observations. */
export function passesHermesConfigExportLiveEvidence(
  evidence: HermesConfigExportLiveEvidence,
): boolean {
  if (evidence.outcome === "expected-refusal") {
    return (
      evidence.aliasesEquivalent &&
      evidence.credentialValuesOmitted &&
      evidence.outputFilesAbsent &&
      evidence.refusalCategory === "unsupported" &&
      evidence.refusalDiagnosticMatches
    );
  }
  return (
    evidence.agent === "hermes" &&
    evidence.aliasesEquivalent &&
    evidence.consumer.passed &&
    evidence.credentialReferenceMatches &&
    evidence.credentialValuesOmitted &&
    evidence.identityDriftPreventedPublication &&
    evidence.identityDriftReported &&
    evidence.managedImageIsOmitted &&
    evidence.interfacesMatch &&
    evidence.dashboardRuntimeMatches &&
    evidence.inferenceEndpointMatches &&
    evidence.launchersSucceeded &&
    evidence.policyMatches &&
    evidence.sandboxNameMatches
  );
}

function expectedHermesConsumerEvidence(
  input: HermesConfigExportLiveInput,
): PinnedV1ConsumerEvidence {
  const nativeSettings = expectedPinnedV1HermesNativeSettings({
    hermesApiPort: Number(input.env.NEMOCLAW_HERMES_API_PORT ?? HERMES_INTERFACE_DEFAULTS.apiPort),
    hermesDashboardEnabled: input.dashboardEnabled === true,
    hermesDashboardPort: Number(
      input.env.NEMOCLAW_DASHBOARD_PORT ?? HERMES_INTERFACE_DEFAULTS.dashboardPort,
    ),
    hermesDashboardInternalPort: Number(
      input.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ??
        HERMES_INTERFACE_DEFAULTS.dashboardInternalPort,
    ),
    hermesDashboardTui: hermesTuiEnabled(input.env),
  });
  return {
    revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
    compiledSandboxes: 1,
    hermesNativeSettings: { [input.sandboxName]: nativeSettings },
    openclawNativeSettingsVerified: 0,
    hermesNativeSettingsVerified: 1,
  };
}

function comparableHermesConsumerEvidence(
  evidence: PinnedV1ConsumerEvidence,
  sandboxName: string,
): PinnedV1ConsumerEvidence {
  const nativeSettings = evidence.hermesNativeSettings?.[sandboxName];
  return {
    revision: evidence.revision,
    compiledSandboxes: evidence.compiledSandboxes,
    hermesNativeSettings: nativeSettings ? { [sandboxName]: nativeSettings } : {},
    openclawNativeSettingsVerified: evidence.openclawNativeSettingsVerified,
    hermesNativeSettingsVerified: evidence.hermesNativeSettingsVerified,
  };
}

function validateHermesConsumers(
  input: HermesConfigExportLiveInput,
  nemoclawRaw: string,
  nemohermesRaw: string,
): HermesPinnedV1ConsumerEvidence {
  const expected = expectedHermesConsumerEvidence(input);
  const actual: HermesPinnedV1ConsumerEvidence["actual"] = {};
  const validate = input.validateWithPinnedV1 ?? validateConfigExportWithPinnedV1;
  try {
    actual.nemoclaw = comparableHermesConsumerEvidence(validate(nemoclawRaw), input.sandboxName);
    actual.nemohermes = comparableHermesConsumerEvidence(
      validate(nemohermesRaw),
      input.sandboxName,
    );
  } catch {
    return { expected, actual, passed: false };
  }
  return {
    expected,
    actual,
    passed:
      isDeepStrictEqual(actual.nemoclaw, expected) &&
      isDeepStrictEqual(actual.nemohermes, expected),
  };
}

function hermesTuiEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.NEMOCLAW_HERMES_DASHBOARD_TUI ?? "0").toLowerCase(),
  );
}

function expectedHermesInterfaces(input: HermesConfigExportLiveInput) {
  const targetDefaults = V1ALPHA1_RUNTIME_DEFAULTS.hermes.interfaces;
  const port = Number(input.env.NEMOCLAW_DASHBOARD_PORT ?? HERMES_INTERFACE_DEFAULTS.dashboardPort);
  const internalPort = Number(
    input.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ??
      HERMES_INTERFACE_DEFAULTS.dashboardInternalPort,
  );
  const apiPort = Number(input.env.NEMOCLAW_HERMES_API_PORT ?? HERMES_INTERFACE_DEFAULTS.apiPort);
  const api = apiPort === targetDefaults.api.port ? undefined : { port: apiPort };
  if (!input.dashboardEnabled) {
    return {
      ...(targetDefaults.dashboard.enabled ? { dashboard: { enabled: false as const } } : {}),
      ...(api ? { api } : {}),
    };
  }
  const tuiEnabled = hermesTuiEnabled(input.env);
  return {
    dashboard: {
      enabled: true,
      ...(port === targetDefaults.dashboard.port ? {} : { port }),
      ...(internalPort === targetDefaults.dashboard.internalPort ? {} : { internalPort }),
      ...(tuiEnabled === targetDefaults.dashboard.tuiEnabled
        ? {}
        : { tui: { enabled: tuiEnabled } }),
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
  const nemoclawDiagnostics = normalizeCommandDiagnostics(nemoclaw.stdout, nemoclaw.stderr);
  const nemohermesDiagnostics = normalizeCommandDiagnostics(nemohermes.stdout, nemohermes.stderr);
  const containsCredential = input.redactionValues.some(
    (value) =>
      value.length > 0 &&
      [nemoclawRaw, nemohermesRaw, nemoclawDiagnostics, nemohermesDiagnostics].some((output) =>
        output.includes(value),
      ),
  );
  const expectsCredentialHttpRefusal =
    typeof entry.credentialEnv === "string" &&
    entry.credentialEnv.length > 0 &&
    entry.endpointUrl?.toLowerCase().startsWith("http:") === true;
  const expectedRefusals = [
    ...(entry.openshellDriver === "podman" ? [PODMAN_REFUSAL] : []),
    ...(expectsCredentialHttpRefusal ? [CREDENTIAL_HTTP_REFUSAL] : []),
  ];
  if (expectedRefusals.length > 0 || !launchersSucceeded) {
    if (expectedRefusals.length > 0) {
      const expectedDiagnostic = ["Config export failed (unsupported).", ...expectedRefusals].join(
        "\n",
      );
      const refusalDiagnosticMatches = [nemoclawDiagnostics, nemohermesDiagnostics].every(
        (diagnostic) => diagnostic === expectedDiagnostic,
      );
      const refusalCategory = refusalDiagnosticMatches ? "unsupported" : null;
      const evidence: HermesConfigExportExpectedRefusalEvidence = {
        outcome: "expected-refusal",
        aliasesEquivalent:
          nemoclaw.exitCode === 2 &&
          nemohermes.exitCode === 2 &&
          nemoclawDiagnostics === nemohermesDiagnostics,
        checked: true,
        credentialValuesOmitted: !containsCredential,
        outputFilesAbsent: !fs.existsSync(nemoclawPath) && !fs.existsSync(nemohermesPath),
        refusalCategory,
        refusalDiagnosticMatches,
      };
      await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
      return { checked: true, passed: passesHermesConfigExportLiveEvidence(evidence) };
    }
    const evidence: HermesConfigExportLiveEvidence = {
      outcome: "published",
      agent: undefined,
      aliasesEquivalent: false,
      checked: true,
      consumer: {
        expected: expectedHermesConsumerEvidence(input),
        actual: {},
        passed: false,
      },
      credentialReferenceMatches: false,
      credentialValuesOmitted: !containsCredential,
      identityDriftPreventedPublication: false,
      identityDriftReported: false,
      managedImageIsOmitted: false,
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

  const nemoclawDocument = parseConfigExport(nemoclawRaw);
  const nemohermesDocument = parseConfigExport(nemohermesRaw);
  const exportsSafe = [
    inspectConfigExportArtifactSafety(nemoclawRaw, input.redactionValues, nemoclawDocument),
    inspectConfigExportArtifactSafety(nemohermesRaw, input.redactionValues, nemohermesDocument),
  ].every(({ internalTransportsAbsent, knownSecretsAbsent }) => {
    return internalTransportsAbsent && knownSecretsAbsent;
  });
  const sandbox = nemoclawDocument.spec.sandboxes[0]!;
  const hostedProvider = nemoclawDocument.spec.inferenceProviders[0];
  const expectedPolicy = policy.ok ? YAML.parse(policy.value.document) : null;
  const consumer = validateHermesConsumers(input, nemoclawRaw, nemohermesRaw);

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
    outcome: "published",
    aliasesEquivalent: isDeepStrictEqual(nemohermesDocument.spec, nemoclawDocument.spec),
    agent: sandbox.harness.kind,
    checked: true,
    consumer,
    credentialValuesOmitted: !containsCredential && exportsSafe,
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
    managedImageIsOmitted: !("image" in sandbox),
    interfacesMatch: isDeepStrictEqual(sandbox.harness.interfaces, expectedHermesInterfaces(input)),
    dashboardRuntimeMatches: await dashboardRuntimeMatches(input),
    inferenceEndpointMatches: hostedProvider?.endpoint === entry.endpointUrl,
    launchersSucceeded,
    policyMatches:
      expectedPolicy === null ||
      isDeepStrictEqual(
        (sandbox.network.policy.explicit as { network_policies?: unknown }).network_policies,
        (expectedPolicy as { network_policies?: unknown }).network_policies,
      ),
    sandboxNameMatches: sandbox.name === input.sandboxName,
  };
  const passed = passesHermesConfigExportLiveEvidence(evidence);
  await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
  if (passed) await input.artifacts.writeText("hermes-config-export.yaml", nemoclawRaw);
  return { checked: true, passed };
}
