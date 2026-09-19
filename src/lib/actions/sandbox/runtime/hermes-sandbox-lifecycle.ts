// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";

export type HermesSandboxLifecycleResult = {
  status: number;
  stdout: string;
  stderr: string;
};

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
