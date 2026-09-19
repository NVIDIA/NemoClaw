// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";

export type HermesSandboxLifecycleResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type HermesSandboxIdentityEntry = {
  readonly name: string;
  readonly agent?: string | null;
  readonly gatewayName?: string | null;
  readonly lifecycleGeneration?: string;
  readonly lifecycleLiveIdentityFingerprint?: string;
};

export function createHermesSandboxIdentityRevalidator(input: {
  readonly sandboxName: string;
  readonly getSandbox: (sandboxName: string) => HermesSandboxIdentityEntry | null | undefined;
  readonly inspectLiveIdentity: (sandboxName: string, gatewayName: string) => string;
}): (operation: string) => void {
  const expected = input.getSandbox(input.sandboxName);
  const expectedFingerprint = expected?.lifecycleLiveIdentityFingerprint;
  const expectedGatewayName = expected?.gatewayName;

  return (operation: string) => {
    const current = input.getSandbox(input.sandboxName);
    const registryChanged =
      !expected ||
      !current ||
      current.name !== expected.name ||
      current.agent !== expected.agent ||
      current.gatewayName !== expected.gatewayName ||
      current.lifecycleGeneration !== expected.lifecycleGeneration ||
      current.lifecycleLiveIdentityFingerprint !== expectedFingerprint;
    if (
      registryChanged ||
      typeof expectedGatewayName !== "string" ||
      expectedGatewayName.length === 0 ||
      typeof expectedFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(expectedFingerprint)
    ) {
      throw new Error(`Sandbox '${input.sandboxName}' identity changed before ${operation}.`);
    }

    let observedFingerprint: string;
    try {
      observedFingerprint = input.inspectLiveIdentity(input.sandboxName, expectedGatewayName);
    } catch {
      throw new Error(
        `Sandbox '${input.sandboxName}' live identity could not be verified before ${operation}.`,
      );
    }
    if (observedFingerprint !== expectedFingerprint) {
      throw new Error(`Sandbox '${input.sandboxName}' live identity changed before ${operation}.`);
    }
  };
}

export function restartHermesSandboxThroughOpenShell(
  sandboxName: string,
  runOpenshell: MessagingOpenShellRunner,
  revalidateSandboxIdentity: (operation: string) => void,
): HermesSandboxLifecycleResult {
  const run = (action: "stop" | "start"): HermesSandboxLifecycleResult => {
    revalidateSandboxIdentity(
      `${action === "stop" ? "stopping" : "starting"} Hermes sandbox '${sandboxName}'`,
    );
    const result = runOpenshell(["sandbox", action, sandboxName], {
      ignoreError: true,
      suppressOutput: true,
      timeout: 210000,
    });
    revalidateSandboxIdentity(
      `confirming Hermes sandbox '${sandboxName}' after OpenShell ${action}`,
    );
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };

  const stopped = run("stop");
  return stopped.status === 0 ? run("start") : stopped;
}
