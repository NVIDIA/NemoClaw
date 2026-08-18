// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import * as dockerRunNamespace from "../../../src/lib/adapters/docker/run.ts";
import type { DockerGpuPatchDeps } from "../../../src/lib/onboard/docker-gpu-patch-types.ts";
import * as startupCommandPatchNamespace from "../../../src/lib/onboard/docker-startup-command-patch.ts";
import { redactString } from "../fixtures/redaction.ts";

const LEGACY_KEEPALIVE_COMMAND = ["sleep", "infinity"] as const;
const MANAGED_IMAGE_ENTRYPOINT = ["/usr/local/bin/nemoclaw-start"] as const;
const MANAGED_IMAGE_COMMAND = ["/bin/bash"] as const;
const LEGACY_OPENSHELL_ENTRYPOINT = ["/opt/openshell/bin/openshell-sandbox"] as const;
const DEFAULT_RECREATE_TIMEOUT_SECS = 180;
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/i;
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
};

const defaultDeps: LegacyKeepaliveFixtureDeps = {
  recreate: recreateOpenShellDockerSandboxWithStartupCommand,
  dockerCapture: defaultDockerCapture,
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
  requireFixtureInput(
    hasExactTokens(configRecord.Entrypoint, MANAGED_IMAGE_ENTRYPOINT) &&
      hasExactTokens(configRecord.Cmd, MANAGED_IMAGE_COMMAND),
    "legacy keepalive fixture requires the reviewed managed-image process contract",
  );

  // The replacement container runs the exact pre-0.0.99 OpenShell supervisor
  // contract. The production recreation helper still rejects other shapes.
  configRecord.Entrypoint = [...LEGACY_OPENSHELL_ENTRYPOINT];
  configRecord.Cmd = [];
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
  const result = recreate(
    {
      sandboxName: options.sandboxName,
      expectedOldContainerId: options.expectedContainerId,
      openshellSandboxCommand: LEGACY_KEEPALIVE_COMMAND,
      timeoutSecs: options.timeoutSecs ?? DEFAULT_RECREATE_TIMEOUT_SECS,
    },
    {
      dockerCapture: legacyKeepaliveDockerCapture(options.expectedContainerId, dockerCapture),
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
