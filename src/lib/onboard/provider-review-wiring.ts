// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isOnboardAutoYesNonInteractive } from "./no-tty-auto-yes";

export function resolveOnboardReviewContext(
  options: {
    nonInteractive?: boolean;
    autoYes?: boolean;
    resume?: boolean;
    fresh?: boolean;
    fromDockerfile?: string | null;
    sandboxName?: string | null;
  },
  env: NodeJS.ProcessEnv,
  persistedSessionStatus: string | null,
  isNonInteractiveEnv: () => boolean,
) {
  const terminal = {
    stdinIsTty: Boolean(process.stdin?.isTTY),
    stdoutIsTty: Boolean(process.stdout?.isTTY),
  };
  const resume =
    options.resume === true ||
    (options.fresh !== true && persistedSessionStatus === "in_progress");
  return {
    resume,
    nonInteractive:
      options.nonInteractive === true ||
      isOnboardAutoYesNonInteractive(
        options.autoYes === true || env.NEMOCLAW_YES === "1",
        resume,
        terminal,
      ) ||
      isNonInteractiveEnv(),
    entryOptionsInput: {
      opts: options,
      env,
      stdinIsTty: terminal.stdinIsTty,
      stdoutIsTty: terminal.stdoutIsTty,
      persistedSessionStatus,
    },
  };
}

export async function checkpointProviderReviewSandbox(
  sandboxName: string,
  agent: { name?: string } | null,
  updateSession: (mutator: (session: any) => any) => unknown,
  checkpointSandboxName: (...args: any[]) => Promise<void>,
): Promise<void> {
  await checkpointSandboxName(sandboxName, agent, updateSession);
}

export interface ProviderReviewDeps {
  checkpointSandboxIdentity(sandboxName: string, agent: { name?: string } | null): Promise<void>;
  prepareLocalProviderForInference(providerName: string): Promise<void>;
}

export interface ProviderReviewDepsFactoryInput {
  updateSession: (mutator: (session: any) => any) => unknown;
  checkpointSandboxName: (...args: any[]) => Promise<void>;
  shouldFrontOllamaWithProxy: () => boolean;
  startOllamaAuthProxy: () => boolean;
  getOllamaProxyToken: () => string | null;
  persistAndProbeOllamaProxy: (token: string) => Promise<void>;
  exitProcess: (code: number) => never;
  writeError: (message: string) => void;
}

export function createProviderReviewDeps(
  deps: ProviderReviewDepsFactoryInput,
): ProviderReviewDeps {
  return {
    checkpointSandboxIdentity: (sandboxName: string, agent: { name?: string } | null) =>
      checkpointProviderReviewSandbox(
        sandboxName,
        agent,
        deps.updateSession,
        deps.checkpointSandboxName,
      ),
    prepareLocalProviderForInference: async (providerName: string) => {
      if (providerName !== "ollama-local" || !deps.shouldFrontOllamaWithProxy()) return;
      if (!deps.startOllamaAuthProxy()) deps.exitProcess(1);
      const proxyToken = deps.getOllamaProxyToken();
      if (!proxyToken) {
        deps.writeError("  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.");
        deps.exitProcess(1);
      }
      await deps.persistAndProbeOllamaProxy(proxyToken);
    },
  };
}
