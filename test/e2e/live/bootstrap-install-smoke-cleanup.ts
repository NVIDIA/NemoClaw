// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

const GATEWAY = "nemoclaw";
const SANDBOX_ABSENT =
  /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox[^\n]*not found|no such sandbox/i;
const GATEWAY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/i;
type BootstrapHost = Pick<HostCliClient, "command" | "cleanupGatewayRegistration">;

function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry?.name !== "string")) {
    throw new Error(`${label} did not return a list of named resources`);
  }
  return value.map((entry: { name: string }) => entry.name);
}

async function gatewayNames(host: BootstrapHost, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await host.command("openshell", ["gateway", "list", "-o", "json"], {
    artifactName: "bootstrap-gateway-inventory",
    env,
    timeoutMs: 30_000,
  });
  assertExitZero(result, "inspect bootstrap gateway registrations");
  return names(JSON.parse(result.stdout), "OpenShell gateway inventory");
}

async function sandboxNames(host: BootstrapHost, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await host.command("nemoclaw", ["list", "--json"], {
    artifactName: "bootstrap-sandbox-inventory",
    env,
    timeoutMs: 30_000,
  });
  assertExitZero(result, "inspect bootstrap sandbox inventory");
  return names(JSON.parse(result.stdout).sandboxes, "NemoClaw sandbox inventory");
}

export async function cleanupBootstrapClone(
  host: BootstrapHost,
  cloneDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const options = { artifactName: "cleanup-bootstrap-clone", env, timeoutMs: 60_000 };
  const privileged = await host.command("sudo", ["rm", "-rf", "--", cloneDir], options);
  if (privileged.exitCode !== 0) {
    const unprivileged = await host.command("rm", ["-rf", "--", cloneDir], options);
    assertExitZero(unprivileged, "remove owned bootstrap clone");
  }
  if (fs.existsSync(cloneDir)) {
    throw new Error(`Owned bootstrap clone still exists after cleanup: ${cloneDir}`);
  }
}

export async function cleanupBootstrapGateway(
  host: BootstrapHost,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await host.cleanupGatewayRegistration(GATEWAY, {
    artifactName: "cleanup-bootstrap-gateway",
    env,
    timeoutMs: 60_000,
  });
  if ((await gatewayNames(host, env)).includes(GATEWAY)) {
    throw new Error("Owned bootstrap gateway remains registered after cleanup");
  }
}

export async function registerBootstrapRuntimeCleanup(
  cleanup: Pick<CleanupRegistry, "add">,
  host: BootstrapHost,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // The bootstrap uses the default gateway. Refuse to acquire somebody else's
  // existing gateway or sandbox before registering any destructive callback.
  if ((await gatewayNames(host, env)).includes(GATEWAY)) {
    throw new Error("Bootstrap smoke requires an unused nemoclaw gateway");
  }
  if ((await sandboxNames(host, env)).includes(sandboxName)) {
    throw new Error(`Bootstrap smoke requires an unused sandbox name: ${sandboxName}`);
  }

  cleanup.add("remove owned bootstrap gateway", () => cleanupBootstrapGateway(host, env));
  cleanup.add(`delete owned bootstrap runtime sandbox ${sandboxName}`, async () => {
    const result = await host.command(
      "openshell",
      ["sandbox", "delete", "-g", GATEWAY, sandboxName],
      { artifactName: "cleanup-bootstrap-runtime-sandbox", env, timeoutMs: 60_000 },
    );
    assertCleanupSucceededOrAbsent(
      result,
      SANDBOX_ABSENT.test(`${result.stdout}\n${result.stderr}`) ||
        GATEWAY_ABSENT.test(`${result.stdout}\n${result.stderr}`),
      `delete owned bootstrap runtime sandbox ${sandboxName}`,
    );
    const inventory = await host.command(
      "openshell",
      ["sandbox", "list", "-g", GATEWAY, "-o", "json"],
      {
        artifactName: "cleanup-bootstrap-runtime-inventory",
        env,
        timeoutMs: 30_000,
      },
    );
    if (
      inventory.exitCode !== 0 &&
      GATEWAY_ABSENT.test(`${inventory.stdout}\n${inventory.stderr}`) &&
      !(await gatewayNames(host, env)).includes(GATEWAY)
    ) {
      return;
    }
    assertExitZero(inventory, "inspect bootstrap runtime sandbox inventory after cleanup");
    if (names(JSON.parse(inventory.stdout), "OpenShell sandbox inventory").includes(sandboxName)) {
      throw new Error(
        `Owned bootstrap runtime sandbox remains registered after cleanup: ${sandboxName}`,
      );
    }
  });
  cleanup.add(`destroy owned bootstrap sandbox ${sandboxName}`, async () => {
    const result = await host.command("nemoclaw", [sandboxName, "destroy", "--yes"], {
      artifactName: "cleanup-bootstrap-sandbox",
      env,
      timeoutMs: 120_000,
    });
    assertCleanupSucceededOrAbsent(
      result,
      SANDBOX_ABSENT,
      `destroy owned bootstrap sandbox ${sandboxName}`,
    );
    if ((await sandboxNames(host, env)).includes(sandboxName)) {
      throw new Error(`Owned bootstrap sandbox remains registered after cleanup: ${sandboxName}`);
    }
  });
}
