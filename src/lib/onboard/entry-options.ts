// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OnboardEntryOptionsInput {
  opts: {
    resume?: boolean;
    fresh?: boolean;
    fromDockerfile?: string | null;
    sandboxName?: string | null;
  };
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

export interface OnboardEntryOptionsDeps {
  isNonInteractive(): boolean;
  validateName(name: string, kind: string): string;
  reservedSandboxNames: ReadonlySet<string>;
  cliDisplayName(): string;
  getNameValidationGuidance(
    kind: string,
    value: string | null | undefined,
    options?: { includeAllowedFormat?: boolean },
  ): string[];
  error(message: string): void;
  exitProcess(code: number): never;
}

export interface ResolvedOnboardEntryOptions {
  resume: boolean;
  fresh: boolean;
  requestedFromDockerfile: string | null;
  requestedSandboxName: string | null;
  cannotPrompt: boolean;
}

export function resolveOnboardEntryOptions(
  input: OnboardEntryOptionsInput,
  deps: OnboardEntryOptionsDeps,
): ResolvedOnboardEntryOptions {
  const resume = input.opts.resume === true;
  const fresh = input.opts.fresh === true;
  if (resume && fresh) {
    deps.error("  --resume and --fresh cannot both be set.");
    deps.exitProcess(1);
  }

  const requestedFromDockerfile =
    input.opts.fromDockerfile ||
    (deps.isNonInteractive() ? input.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
  const cannotPrompt = deps.isNonInteractive() || !input.stdinIsTty || !input.stdoutIsTty;
  let requestedSandboxName: string | null =
    typeof input.opts.sandboxName === "string" && input.opts.sandboxName.length > 0
      ? input.opts.sandboxName
      : null;
  let requestedSandboxSource: "--name" | "NEMOCLAW_SANDBOX_NAME" | null = requestedSandboxName
    ? "--name"
    : null;
  if (!requestedSandboxName && cannotPrompt) {
    const envName = input.env.NEMOCLAW_SANDBOX_NAME;
    if (typeof envName === "string" && envName.trim().length > 0) {
      requestedSandboxName = envName.trim();
      requestedSandboxSource = "NEMOCLAW_SANDBOX_NAME";
    }
  }
  if (requestedSandboxName) {
    let validated: string;
    try {
      validated = deps.validateName(requestedSandboxName, "sandbox name");
    } catch (error) {
      deps.error(`  ${error instanceof Error ? error.message : String(error)}`);
      for (const line of deps.getNameValidationGuidance("sandbox name", requestedSandboxName, {
        includeAllowedFormat: false,
      })) {
        deps.error(`  ${line}`);
      }
      deps.exitProcess(1);
    }
    if (deps.reservedSandboxNames.has(validated)) {
      deps.error(`  Reserved name: '${validated}' is a ${deps.cliDisplayName()} CLI command.`);
      deps.error(
        `  Choose a different sandbox name (passed via ${requestedSandboxSource}) to avoid routing conflicts.`,
      );
      deps.exitProcess(1);
    }
    requestedSandboxName = validated;
  }
  if (cannotPrompt && !resume && requestedFromDockerfile && !requestedSandboxName) {
    deps.error(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
    deps.error("  A sandbox name cannot be prompted for in this context.");
    deps.exitProcess(1);
  }

  return {
    resume,
    fresh,
    requestedFromDockerfile,
    requestedSandboxName,
    cannotPrompt,
  };
}
