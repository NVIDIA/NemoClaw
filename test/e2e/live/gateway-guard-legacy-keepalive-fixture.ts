// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import * as startupCommandPatchNamespace from "../../../src/lib/onboard/docker-startup-command-patch.ts";
import { redactString } from "../fixtures/redaction.ts";

const LEGACY_KEEPALIVE_COMMAND = ["sleep", "infinity"] as const;
const DEFAULT_RECREATE_TIMEOUT_SECS = 180;
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/i;
const startupCommandPatch = (
  "default" in startupCommandPatchNamespace
    ? startupCommandPatchNamespace.default
    : startupCommandPatchNamespace
) as typeof import("../../../src/lib/onboard/docker-startup-command-patch.ts");
const { recreateOpenShellDockerSandboxWithStartupCommand } = startupCommandPatch;

type StartupCommandRecreate = typeof recreateOpenShellDockerSandboxWithStartupCommand;

export type LegacyKeepaliveFixtureOptions = {
  sandboxName: string;
  expectedContainerId: string;
  timeoutSecs?: number;
};

export type LegacyKeepaliveFixtureDeps = {
  recreate: StartupCommandRecreate;
};

const defaultDeps: LegacyKeepaliveFixtureDeps = {
  recreate: recreateOpenShellDockerSandboxWithStartupCommand,
};

function requireFixtureInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createLegacyKeepaliveFixture(
  options: LegacyKeepaliveFixtureOptions,
  deps: LegacyKeepaliveFixtureDeps = defaultDeps,
): ReturnType<StartupCommandRecreate> {
  requireFixtureInput(options.sandboxName.trim() !== "", "sandbox name is required");
  requireFixtureInput(
    DOCKER_CONTAINER_ID_PATTERN.test(options.expectedContainerId),
    "expected container ID must be a full Docker container ID",
  );

  const result = deps.recreate({
    sandboxName: options.sandboxName,
    expectedOldContainerId: options.expectedContainerId,
    openshellSandboxCommand: LEGACY_KEEPALIVE_COMMAND,
    timeoutSecs: options.timeoutSecs ?? DEFAULT_RECREATE_TIMEOUT_SECS,
  });

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
