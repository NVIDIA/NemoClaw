// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  connectManagedOpenShellSdk,
  gatewayPort,
  OpenShellSdkPreflightUnavailableError,
  type OpenShellSdkConnectionDeps,
} from "./sdk";
import { isValidName } from "../../sandbox-name-contract";
import type {
  OpenShellSandboxCommandCompletion,
  OpenShellSandboxCommandError,
  OpenShellSandboxCommandOutcome,
  OpenShellSandboxCommandRequest,
} from "./sandbox-command";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

type SdkExecEvent =
  | Readonly<{ stream: "stdout" | "stderr"; data: Buffer }>
  | Readonly<{ type: "exit"; exitCode: number }>;

type SdkSandboxClient = Readonly<{
  execStream(
    name: string,
    command: string[],
    options?: Readonly<{
      noLoginShell?: boolean;
      signal?: AbortSignal;
      timeoutSecs?: number;
      workdir?: string;
    }>,
  ): AsyncIterable<SdkExecEvent>;
}>;

type SdkClient = Readonly<{ sandbox: SdkSandboxClient }>;

export type SdkOpenShellSandboxCommandExecutorDeps = Readonly<{
  connect?: (target: OpenShellGatewayTarget) => Promise<SdkClient>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loadSdk?: OpenShellSdkConnectionDeps["loadSdk"];
  stderr?: (data: Buffer) => void;
  stdout?: (data: Buffer) => void;
}>;

function commandFailure(error: unknown): OpenShellSandboxCommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  let kind: OpenShellSandboxCommandError["kind"] = "invocation";
  if (
    error instanceof OpenShellSdkPreflightUnavailableError ||
    /Cannot find (?:module|package) ['"]@nvidia\/openshell-sdk['"]/u.test(message)
  ) {
    kind = "unavailable";
  } else if (/timeout|deadline/iu.test(`${code} ${message}`)) {
    kind = "timeout";
  }
  return { kind: "failed", error: { kind, message } };
}

function assertRequestName(name: string, label: string): void {
  if (!isValidName(name)) throw new Error(`Invalid OpenShell ${label} name`);
}

/** SDK-backed streaming executor used by non-interactive sandbox actions. */
export function createSdkOpenShellSandboxCommandExecutor(
  deps: SdkOpenShellSandboxCommandExecutorDeps = {},
): Readonly<{
  runStreaming(request: OpenShellSandboxCommandRequest): Promise<OpenShellSandboxCommandCompletion>;
}> {
  const connect =
    deps.connect ??
    (async (target) => (await connectManagedOpenShellSdk(target, deps)) as SdkClient);
  const stdout = deps.stdout ?? ((data: Buffer) => process.stdout.write(data));
  const stderr = deps.stderr ?? ((data: Buffer) => process.stderr.write(data));

  return {
    runStreaming: async (request): Promise<OpenShellSandboxCommandCompletion> => {
      assertRequestName(request.sandboxName, "sandbox");
      gatewayPort(request.target);
      if (request.tty === true || request.stdin === true) {
        return {
          outcome: {
            kind: "failed",
            error: {
              kind: "invocation",
              message:
                "OpenShell SDK non-interactive execution does not accept TTY or inherited stdin",
            },
          },
          release: () => {},
        };
      }

      try {
        const client = await connect(request.target);
        let exitCode: number | undefined;
        for await (const event of client.sandbox.execStream(
          request.sandboxName,
          [...request.command],
          {
            noLoginShell: true,
            ...(request.timeoutSeconds !== undefined
              ? { timeoutSecs: request.timeoutSeconds }
              : {}),
            ...(request.workdir ? { workdir: request.workdir } : {}),
          },
        )) {
          if ("type" in event) exitCode = event.exitCode;
          else if (event.stream === "stdout") stdout(event.data);
          else stderr(event.data);
        }
        if (exitCode === undefined) {
          throw new Error("OpenShell SDK exec stream ended without an exit event");
        }
        return { outcome: { kind: "completed", exitCode }, release: () => {} };
      } catch (error) {
        return { outcome: commandFailure(error), release: () => {} };
      }
    },
  };
}
