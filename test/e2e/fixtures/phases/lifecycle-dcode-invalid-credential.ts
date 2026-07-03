// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { ArtifactSink } from "../artifacts.ts";
import { resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { DcodeInvalidCredentialRebuildOptions } from "./lifecycle-dcode-options.ts";
import {
  DcodeInvalidCredentialProbes,
  is2xx,
  routeHttpCode,
  sameStrings,
  sortedUniqueLines,
} from "./lifecycle-dcode-probes.ts";
import type { NemoClawInstance } from "./onboarding.ts";
import { latestRebuildBackupDir } from "./state-validation.ts";

// The rejected credential is probed before image build and the production
// sandbox probe is capped at 100 seconds. Keep this comfortably below the
// live project's 30-minute test budget so finally/cleanup can always restore.
const REBUILD_TIMEOUT_MS = 3 * 60_000;
const DCODE_TARGET_SANDBOX_PREFIX = "e2e-ubuntu-repo-cloud-langchain-deepagents-code";

export interface DcodeLifecycleCleanup {
  add(name: string, run: () => Promise<void> | void): void;
}

export interface DcodeInvalidCredentialLifecycleDeps {
  host: HostCliClient;
  sandbox: SandboxClient;
  cleanup: DcodeLifecycleCleanup;
  artifacts?: ArtifactSink;
}

export interface DcodeInvalidCredentialLifecycleResult {
  profile: "dcode-rebuild-invalid-credential";
  steps: Array<{ id: string; results: ShellProbeResult[] }>;
}

function assertDcodeTarget(instance: NemoClawInstance): void {
  if (instance.agent !== "langchain-deepagents-code") {
    throw new Error(
      `dcode invalid-credential lifecycle requires agent langchain-deepagents-code, got '${instance.agent}'`,
    );
  }
  if (!instance.sandboxName.startsWith(DCODE_TARGET_SANDBOX_PREFIX)) {
    throw new Error(
      `dcode invalid-credential lifecycle refuses sandbox '${instance.sandboxName}'; ` +
        `expected prefix '${DCODE_TARGET_SANDBOX_PREFIX}'`,
    );
  }
}

function assertFailedBeforeDestructiveWork(rebuild: ShellProbeResult): void {
  if (rebuild.timedOut) {
    throw new Error("DCode invalid-credential rebuild timed out instead of failing closed");
  }
  if (rebuild.signal !== null) {
    throw new Error(
      `DCode invalid-credential rebuild exited by signal ${rebuild.signal} instead of a numeric status`,
    );
  }
  if (typeof rebuild.exitCode !== "number" || rebuild.exitCode <= 0) {
    throw new Error(
      `DCode invalid-credential rebuild expected a numeric non-zero exit, got ${String(rebuild.exitCode)}`,
    );
  }
  const output = resultText(rebuild);
  if (!/recorded inference credentials or route/i.test(output)) {
    throw new Error(
      `DCode invalid-credential rebuild did not identify the recorded inference route failure: ${output}`,
    );
  }
  if (!/HTTP (?:401|403)\b/.test(output)) {
    throw new Error(
      `DCode invalid-credential rebuild did not surface actionable HTTP 401/403 output: ${output}`,
    );
  }
  if (!/Sandbox is untouched\s+—\s+no data was lost\./i.test(output)) {
    throw new Error(
      `DCode invalid-credential rebuild did not report the atomic untouched guarantee: ${output}`,
    );
  }
  const destructiveOutput = [
    /Backing up sandbox state/i,
    /Deleting old sandbox/i,
    /Old sandbox deleted/i,
    /Creating new sandbox/i,
    /Recreate failed after sandbox was destroyed/i,
  ].find((pattern) => pattern.test(output));
  if (destructiveOutput) {
    throw new Error(
      `DCode invalid-credential rebuild crossed a destructive boundary: ${destructiveOutput.source}`,
    );
  }
}

async function restoreAndVerify(
  probes: DcodeInvalidCredentialProbes,
  options: DcodeInvalidCredentialRebuildOptions,
  phase: "finally" | "cleanup",
  record?: (id: string, result: ShellProbeResult) => void,
): Promise<void> {
  const restore = await probes.updateProviderCredential(options.validCredential, phase);
  record?.(`provider-credential:${phase}`, restore);
  const restoredRoute = await probes.waitForRoute((code) => is2xx(code), `restored-${phase}`);
  record?.(`inference-local:restored-${phase}`, restoredRoute);
  const route = await probes.assertInferenceRoute(`restored-${phase}`);
  record?.(`inference-route:restored-${phase}`, route);
  const ready = await probes.assertReady(`restored-${phase}`);
  record?.(`sandbox-ready:restored-${phase}`, ready);
  const status = await probes.assertNemoclawStatus(`restored-${phase}`);
  record?.(`nemoclaw-status:restored-${phase}`, status);
}

/**
 * Prove #6195's atomic boundary against the real DCode typed target. The
 * gateway credential is intentionally broken while the sandbox remains Ready;
 * rebuild must reject it without backup, delete, or container replacement.
 */
export async function simulateDcodeInvalidCredentialRebuild(
  instance: NemoClawInstance,
  options: DcodeInvalidCredentialRebuildOptions,
  deps: DcodeInvalidCredentialLifecycleDeps,
): Promise<DcodeInvalidCredentialLifecycleResult> {
  assertDcodeTarget(instance);
  const probes = new DcodeInvalidCredentialProbes(
    deps.host,
    deps.sandbox,
    instance.sandboxName,
    options,
  );
  const steps: DcodeInvalidCredentialLifecycleResult["steps"] = [];
  const record = (id: string, result: ShellProbeResult): void => {
    steps.push({ id, results: [result] });
  };

  const sandboxNames = await probes.gatewaySandboxNames();
  record("gateway-sandbox-names:before", sandboxNames);
  const exactGatewaySandboxes = sortedUniqueLines(sandboxNames.stdout);
  if (!sameStrings(exactGatewaySandboxes, [instance.sandboxName])) {
    throw new Error(
      `dcode invalid-credential lifecycle requires '${instance.sandboxName}' to be the only sandbox ` +
        `on gateway '${options.gatewayName}'; found ${exactGatewaySandboxes.join(", ") || "none"}`,
    );
  }

  record("sandbox-ready:before", await probes.assertReady("before"));
  record("provider-names:before", await probes.assertProviderListed());
  record("inference-route:before", await probes.assertInferenceRoute("before"));
  record("dcode-identity", await probes.assertDcodeIdentity());
  record("marker-write", await probes.writeMarker());

  const containerIdsBeforeResult = await probes.discoverManagedContainerIds("before");
  const containerIdsBefore = sortedUniqueLines(containerIdsBeforeResult.stdout);
  if (containerIdsBefore.length === 0) {
    throw new Error(
      `no Docker container carried both OpenShell managed-by and sandbox-name labels for '${instance.sandboxName}'`,
    );
  }
  record("docker-container-ids:before", containerIdsBeforeResult);

  const baselineRoute = await probes.probeInferenceLocal("baseline");
  if (!is2xx(routeHttpCode(baselineRoute))) {
    throw new Error(
      `DCode baseline inference.local /v1/chat/completions probe expected 2xx, got ` +
        `${routeHttpCode(baselineRoute) ?? "no HTTP status"}: ${resultText(baselineRoute)}`,
    );
  }
  record("inference-local:baseline", baselineRoute);

  const backupBefore = latestRebuildBackupDir(instance.sandboxName);
  const badCredential = `nvapi-e2e-invalid-${randomUUID().replaceAll("-", "")}`;
  deps.artifacts?.addRedactionValues([badCredential, options.validCredential]);
  let restorationVerified = false;
  const restoreOnce = async (
    phase: "finally" | "cleanup",
    stepRecorder?: (id: string, result: ShellProbeResult) => void,
  ): Promise<void> => {
    if (restorationVerified) return;
    await restoreAndVerify(probes, options, phase, stepRecorder);
    restorationVerified = true;
  };

  // CleanupRegistry unwinds in reverse order. This entry is registered after
  // onboarding cleanup, so the valid credential is restored while the sandbox
  // and gateway still exist. It is deliberately armed before mutation and is
  // a retry fallback when the explicit finally restoration did not verify.
  deps.cleanup.add(
    `lifecycle.restore-dcode-provider-credential:${options.gatewayName}:${options.providerName}`,
    () => restoreOnce("cleanup"),
  );

  let primaryError: unknown;
  try {
    record(
      "provider-credential:invalid",
      await probes.updateProviderCredential(badCredential, "invalid"),
    );
    record(
      "inference-local:invalid",
      await probes.waitForRoute((code) => code === "401" || code === "403", "invalid"),
    );
    record("sandbox-ready:invalid", await probes.assertReady("invalid"));

    const rebuild = await deps.host.nemoclaw(
      [instance.sandboxName, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "lifecycle-dcode-rebuild-invalid-credential",
        // Contains neither the bad key nor the valid secret. Rebuild must use
        // the credential already stored in this gateway's provider registry.
        env: probes.gatewayEnv(),
        timeoutMs: REBUILD_TIMEOUT_MS,
      },
    );
    record("nemoclaw-rebuild:invalid-credential", rebuild);
    assertFailedBeforeDestructiveWork(rebuild);

    const backupAfter = latestRebuildBackupDir(instance.sandboxName);
    if (backupAfter !== backupBefore) {
      throw new Error(
        `DCode invalid-credential rebuild created or changed a backup before failing: ` +
          `${String(backupBefore)} -> ${String(backupAfter)}`,
      );
    }

    const containerIdsAfterResult =
      await probes.discoverManagedContainerIds("after-invalid-rebuild");
    const containerIdsAfter = sortedUniqueLines(containerIdsAfterResult.stdout);
    record("docker-container-ids:after-invalid-rebuild", containerIdsAfterResult);
    if (!sameStrings(containerIdsAfter, containerIdsBefore)) {
      throw new Error(
        `DCode invalid-credential rebuild changed the labeled Docker container ID set: ` +
          `${containerIdsBefore.join(",")} -> ${containerIdsAfter.join(",")}`,
      );
    }

    record("marker-read:after-invalid-rebuild", await probes.assertMarker());
    record(
      "sandbox-ready:after-invalid-rebuild",
      await probes.assertReady("after-invalid-rebuild"),
    );
  } catch (error) {
    primaryError = error;
  }

  let restorationError: unknown;
  try {
    await restoreOnce("finally", record);
  } catch (error) {
    restorationError = error;
  }
  if (primaryError && restorationError) {
    throw new AggregateError(
      [primaryError, restorationError],
      "DCode invalid-credential lifecycle failed and provider credential restoration also failed",
    );
  }
  if (primaryError) throw primaryError;
  if (restorationError) throw restorationError;

  return { profile: "dcode-rebuild-invalid-credential", steps };
}
