// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import * as dockerRunNamespace from "../../../src/lib/adapters/docker/run.ts";
import * as openshellRuntimeNamespace from "../../../src/lib/adapters/openshell/runtime.ts";
import * as managedBootstrapAdapterNamespace from "../../../src/lib/onboard/managed-bootstrap/adapter.ts";
import * as dockerGpuPatchCloneNamespace from "../../../src/lib/onboard/docker-gpu-patch-clone.ts";
import type {
  DockerContainerInspect,
  DockerGpuPatchDeps,
} from "../../../src/lib/onboard/docker-gpu-patch-types.ts";
import * as startupCommandEnvNamespace from "../../../src/lib/onboard/docker-startup-command-env.ts";
import * as startupCommandPatchNamespace from "../../../src/lib/onboard/docker-startup-command-patch.ts";
import { redactString } from "../fixtures/redaction.ts";

const LEGACY_KEEPALIVE_COMMAND = ["sleep", "infinity"] as const;
const MANAGED_IMAGE_ENTRYPOINT = ["/usr/local/bin/nemoclaw-start"] as const;
const MANAGED_IMAGE_COMMAND = ["/bin/bash"] as const;
const OPENSHELL_SANDBOX_ENTRYPOINT = ["/opt/openshell/bin/openshell-sandbox"] as const;
const OPENSHELL_WORKDIR_COMMAND = ["--workdir", "/sandbox"] as const;
const OPENSHELL_SANDBOX_COMMAND_ENV = "OPENSHELL_SANDBOX_COMMAND";
const OPENSHELL_OCI_IMAGE_USER_ENV = "OPENSHELL_OCI_IMAGE_USER";
const MANAGED_STARTUP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DEFAULT_RECREATE_TIMEOUT_SECS = 180;
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/i;
const managedBootstrapAdapter = (
  "default" in managedBootstrapAdapterNamespace
    ? managedBootstrapAdapterNamespace.default
    : managedBootstrapAdapterNamespace
) as typeof import("../../../src/lib/onboard/managed-bootstrap/adapter.ts");
const { assertManagedBootstrapSafeProcessEnvironmentKey } = managedBootstrapAdapter;
const dockerGpuPatchClone = (
  "default" in dockerGpuPatchCloneNamespace
    ? dockerGpuPatchCloneNamespace.default
    : dockerGpuPatchCloneNamespace
) as typeof import("../../../src/lib/onboard/docker-gpu-patch-clone.ts");
const { shouldOmitOpenShellOciImageUser } = dockerGpuPatchClone;
const startupCommandEnv = (
  "default" in startupCommandEnvNamespace
    ? startupCommandEnvNamespace.default
    : startupCommandEnvNamespace
) as typeof import("../../../src/lib/onboard/docker-startup-command-env.ts");
const { openshellSandboxCommandEnvValue } = startupCommandEnv;
const startupCommandPatch = (
  "default" in startupCommandPatchNamespace
    ? startupCommandPatchNamespace.default
    : startupCommandPatchNamespace
) as typeof import("../../../src/lib/onboard/docker-startup-command-patch.ts");
const { recreateOpenShellDockerSandboxWithStartupCommand } = startupCommandPatch;
const dockerRun = (
  "default" in dockerRunNamespace ? dockerRunNamespace.default : dockerRunNamespace
) as typeof import("../../../src/lib/adapters/docker/run.ts");
const { dockerCapture: defaultDockerCapture } = dockerRun;
const openshellRuntime = (
  "default" in openshellRuntimeNamespace
    ? openshellRuntimeNamespace.default
    : openshellRuntimeNamespace
) as typeof import("../../../src/lib/adapters/openshell/runtime.ts");

type StartupCommandRecreate = typeof recreateOpenShellDockerSandboxWithStartupCommand;
type DockerCapture = NonNullable<DockerGpuPatchDeps["dockerCapture"]>;

export type LegacyKeepaliveFixtureOptions = {
  sandboxName: string;
  expectedContainerId: string;
  timeoutSecs?: number;
};

export type LegacyKeepaliveFixtureDeps = {
  recreate: StartupCommandRecreate;
  dockerCapture: DockerCapture;
  runOpenshell: NonNullable<DockerGpuPatchDeps["runOpenshell"]>;
  runCaptureOpenshell: NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>;
};

const defaultDeps: LegacyKeepaliveFixtureDeps = {
  recreate: recreateOpenShellDockerSandboxWithStartupCommand,
  dockerCapture: defaultDockerCapture,
  runOpenshell: openshellRuntime.runOpenshell,
  runCaptureOpenshell: (args, options) =>
    openshellRuntime.captureOpenshell(args, {
      ignoreError: true,
      includeStderr: true,
      timeout: typeof options?.timeout === "number" ? options.timeout : undefined,
    }).output,
};

function requireFixtureInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasExactTokens(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((token, index) => token === expected[index])
  );
}

function reviewedManagedRuntimeWorkload(environment: unknown): string[] | null {
  if (!Array.isArray(environment) || !environment.every((entry) => typeof entry === "string")) {
    return null;
  }
  const prefix = `${OPENSHELL_SANDBOX_COMMAND_ENV}=`;
  const commandEntries = environment.filter(
    (entry) => entry === OPENSHELL_SANDBOX_COMMAND_ENV || entry.startsWith(prefix),
  );
  if (commandEntries.length !== 1 || !commandEntries[0].startsWith(prefix)) return null;

  const command = commandEntries[0].slice(prefix.length);
  const tokens = command.split(" ");
  if (tokens.length < 2 || tokens[0] !== "env" || tokens.at(-1) !== MANAGED_IMAGE_ENTRYPOINT[0]) {
    return null;
  }
  try {
    const assignmentKeys = new Set<string>();
    for (const assignment of tokens.slice(1, -1)) {
      const separator = assignment.indexOf("=");
      if (separator <= 0) return null;
      const key = assignment.slice(0, separator);
      if (!MANAGED_STARTUP_ENV_KEY.test(key) || assignmentKeys.has(key)) {
        return null;
      }
      assertManagedBootstrapSafeProcessEnvironmentKey(key);
      assignmentKeys.add(key);
    }
    return openshellSandboxCommandEnvValue(tokens) === command ? tokens : null;
  } catch {
    return null;
  }
}

function hasReviewedOpenShellManagedSource(
  config: Record<string, unknown>,
  managedWorkload: readonly string[] | null,
): boolean {
  const labels = config.Labels;
  return (
    managedWorkload !== null &&
    typeof labels === "object" &&
    labels !== null &&
    (labels as Record<string, unknown>)["openshell.ai/managed-by"] === "openshell"
  );
}

export function rewriteManagedInspectForLegacyKeepalive(
  output: string,
  expectedContainerId: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("legacy keepalive fixture could not parse Docker inspect output");
  }
  requireFixtureInput(
    Array.isArray(parsed) && parsed.length === 1,
    "legacy keepalive fixture requires one Docker inspect record",
  );
  const inspect = parsed[0];
  requireFixtureInput(
    typeof inspect === "object" && inspect !== null,
    "legacy keepalive fixture requires a Docker inspect object",
  );
  const record = inspect as Record<string, unknown>;
  requireFixtureInput(
    record.Id === expectedContainerId,
    "legacy keepalive fixture Docker inspect identity changed",
  );
  const config = record.Config;
  requireFixtureInput(
    typeof config === "object" && config !== null,
    "legacy keepalive fixture requires Docker configuration",
  );
  const configRecord = config as Record<string, unknown>;
  const managedWorkload = reviewedManagedRuntimeWorkload(configRecord.Env);
  const isManagedRuntimeSource = hasReviewedOpenShellManagedSource(configRecord, managedWorkload);
  requireFixtureInput(
    (hasExactTokens(configRecord.Entrypoint, MANAGED_IMAGE_ENTRYPOINT) &&
      hasExactTokens(configRecord.Cmd, MANAGED_IMAGE_COMMAND)) ||
      isManagedRuntimeSource,
    "legacy keepalive fixture requires the reviewed managed-image or OpenShell-managed runtime process contract",
  );
  requireFixtureInput(
    managedWorkload !== null,
    "legacy keepalive fixture requires the reviewed managed startup workload",
  );

  // Keep the reviewed current OpenShell supervisor and /sandbox workdir
  // envelope while the recreation helper replaces only its managed workload
  // with the exact legacy keepalive command. Giving today's supervisor the old
  // empty argument tuple conflates two runtime contracts: the keepalive ignores
  // its working directory, but the later managed startup does not. OpenShell
  // 0.0.99's OCI-user marker must also be absent because it
  // would mutate the shared /sandbox ownership before the synthetic keepalive.
  // Keep both test-only rewrites separate from the production allowlist.
  configRecord.Entrypoint = [...OPENSHELL_SANDBOX_ENTRYPOINT];
  configRecord.Cmd = [...OPENSHELL_WORKDIR_COMMAND];
  const environment = configRecord.Env as string[];
  const hasOciImageUser = environment.some(
    (entry) =>
      entry === OPENSHELL_OCI_IMAGE_USER_ENV ||
      entry.startsWith(`${OPENSHELL_OCI_IMAGE_USER_ENV}=`),
  );
  if (isManagedRuntimeSource || hasOciImageUser) {
    const workspaceBoundaryInspect = hasOciImageUser
      ? record
      : {
          ...record,
          Config: {
            ...configRecord,
            Env: [...environment, `${OPENSHELL_OCI_IMAGE_USER_ENV}=fixture-validation`],
          },
        };
    let hasReviewedWorkspaceBoundary = false;
    try {
      hasReviewedWorkspaceBoundary = shouldOmitOpenShellOciImageUser(
        workspaceBoundaryInspect as DockerContainerInspect,
        managedWorkload,
      );
    } catch {
      // Normalize production identity-metadata failures to the fixture boundary.
    }
    requireFixtureInput(
      hasReviewedWorkspaceBoundary,
      "legacy keepalive fixture requires the reviewed OpenShell OCI workspace identity contract",
    );
  }
  configRecord.Env = environment.filter(
    (entry) =>
      entry !== OPENSHELL_OCI_IMAGE_USER_ENV &&
      !entry.startsWith(`${OPENSHELL_OCI_IMAGE_USER_ENV}=`),
  );
  return JSON.stringify(parsed);
}

function legacyKeepaliveDockerCapture(
  expectedContainerId: string,
  capture: DockerCapture,
): DockerCapture {
  return (args, options) => {
    const output = capture(args, options);
    if (
      args.length === 4 &&
      args[0] === "inspect" &&
      args[1] === "--type" &&
      args[2] === "container" &&
      args[3] === expectedContainerId
    ) {
      return rewriteManagedInspectForLegacyKeepalive(output, expectedContainerId);
    }
    return output;
  };
}

export function createLegacyKeepaliveFixture(
  options: LegacyKeepaliveFixtureOptions,
  deps: Partial<LegacyKeepaliveFixtureDeps> = defaultDeps,
): ReturnType<StartupCommandRecreate> {
  requireFixtureInput(options.sandboxName.trim() !== "", "sandbox name is required");
  requireFixtureInput(
    DOCKER_CONTAINER_ID_PATTERN.test(options.expectedContainerId),
    "expected container ID must be a full Docker container ID",
  );

  const recreate = deps.recreate ?? defaultDeps.recreate;
  const dockerCapture = deps.dockerCapture ?? defaultDeps.dockerCapture;
  const runOpenshell = deps.runOpenshell ?? defaultDeps.runOpenshell;
  const runCaptureOpenshell = deps.runCaptureOpenshell ?? defaultDeps.runCaptureOpenshell;
  const result = recreate(
    {
      sandboxName: options.sandboxName,
      expectedOldContainerId: options.expectedContainerId,
      openshellSandboxCommand: LEGACY_KEEPALIVE_COMMAND,
      timeoutSecs: options.timeoutSecs ?? DEFAULT_RECREATE_TIMEOUT_SECS,
    },
    {
      dockerCapture: legacyKeepaliveDockerCapture(options.expectedContainerId, dockerCapture),
      runCaptureOpenshell,
      runOpenshell,
    },
  );

  requireFixtureInput(
    result.oldContainerId === options.expectedContainerId,
    "legacy keepalive recreation changed an unpinned container",
  );
  requireFixtureInput(
    result.mode.kind === "startup-command",
    "legacy keepalive recreation did not use startup-command mode",
  );
  requireFixtureInput(
    result.newContainerId !== result.oldContainerId,
    "legacy keepalive recreation did not replace the container",
  );
  requireFixtureInput(
    result.backupRemoved,
    "legacy keepalive recreation left the original container backup in place",
  );
  return result;
}

function main(): void {
  const [sandboxName, expectedContainerId, ...extraArgs] = process.argv.slice(2);
  requireFixtureInput(
    sandboxName !== undefined && expectedContainerId !== undefined && extraArgs.length === 0,
    "usage: gateway-guard-legacy-keepalive-fixture <sandbox-name> <container-id>",
  );
  const result = createLegacyKeepaliveFixture({ sandboxName, expectedContainerId });
  process.stdout.write(
    `${JSON.stringify({
      oldContainerId: result.oldContainerId,
      newContainerId: result.newContainerId,
      startupCommand: LEGACY_KEEPALIVE_COMMAND.join(" "),
    })}\n`,
  );
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    main();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactString(detail)}\n`);
    process.exitCode = 1;
  }
}
