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
  /**
   * Status of the persisted onboard session (`~/.nemoclaw/onboard-session.json`),
   * or null when there is no session on disk. When it is "in_progress" a prior
   * onboard was interrupted, so resume mode is auto-detected even without an
   * explicit `--resume` flag (#5470). Optional: omitting it preserves the
   * flag-only behavior for callers that don't load the session.
   */
  persistedSessionStatus?: string | null;
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
  const explicitResume = input.opts.resume === true;
  const fresh = input.opts.fresh === true;
  // The mutual-exclusion error applies only to the explicit flags — a leftover
  // in_progress session combined with an explicit `--fresh` is not a conflict
  // (fresh wins, see below), so it must not trip this guard.
  if (explicitResume && fresh) {
    deps.error("  --resume and --fresh cannot both be set.");
    deps.exitProcess(1);
  }
  // Auto-detect resume from a persisted in_progress session so a re-run of
  // `nemoclaw onboard` after an interrupted attempt continues that attempt
  // (banner + resume preflight) instead of starting over (#5470). `--fresh`
  // always wins, and an explicit `--resume` is preserved unchanged.
  const sessionInProgress = input.persistedSessionStatus === "in_progress";
  const resume = !fresh && (explicitResume || sessionInProgress);

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
