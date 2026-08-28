// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isNonInteractiveEnv } from "../core/non-interactive";
import { getNameValidationGuidance } from "../name-validation";
import { cliDisplayName } from "./branding";
import {
  canonicalPlaceholderKeys,
  EXTRA_PLACEHOLDER_KEYS_ENV,
  parseExtraPlaceholderKeys,
} from "./extra-placeholder-keys";
import { RESERVED_SANDBOX_NAMES } from "./sandbox-agent";
import {
  requireStationExpressResumeIntent,
  type StationExpressSessionLike,
  wrapOnboard as wrapStationExpressOnboard,
} from "./station-express-resume";

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
  persistedRecoverySandboxName?: string | null;
  persistedSessionSandboxName?: string | null;
  retainedRecoverySandboxNames?: readonly string[];
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

type PersistedOnboardEntrySession = {
  readonly status: string;
  readonly sandboxName?: string | null;
  readonly cancellationRecovery?: { readonly sandboxName: string } | null;
};

interface DefaultRunEntryState {
  loadSession(): PersistedOnboardEntrySession | null;
  listRetainedSandboxRecoveryRecords(): readonly { readonly sandboxName: string }[];
}

type NonInteractiveEntryOptions = { nonInteractive?: boolean };
type ResumableEntryOptions = NonInteractiveEntryOptions & {
  resume?: boolean;
  fresh?: boolean;
  apfInterceptorRequested?: boolean | null;
};

const PROVIDER_INTENT_ENV_KEYS = [
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_PROVIDER_MODEL",
  "NEMOCLAW_SERVING_PRESET",
  "NEMOCLAW_MESSAGING_PLAN_B64",
] as const;

const PROVIDERLESS_WEB_SEARCH_ENV_VALUES = new Set(["", "none", "off", "disabled", "no", "0"]);

/** Reject ambient provider intent before onboarding records or external effects. */
export function assertProviderlessInterceptorEnvironment(
  interceptorRequested: boolean,
  env: NodeJS.ProcessEnv,
): void {
  if (!interceptorRequested) return;
  const hasProviderIntent =
    PROVIDER_INTENT_ENV_KEYS.some((key) => String(env[key] ?? "").trim().length > 0) ||
    parseExtraPlaceholderKeys(env[EXTRA_PLACEHOLDER_KEYS_ENV], canonicalPlaceholderKeys()).keys
      .length > 0 ||
    !PROVIDERLESS_WEB_SEARCH_ENV_VALUES.has(
      String(env.NEMOCLAW_WEB_SEARCH_PROVIDER ?? "")
        .trim()
        .toLowerCase(),
    );
  if (!hasProviderIntent) return;
  throw new Error(
    "Interceptor onboarding supports providerless sandbox creation only. No sandbox or provider was created.",
  );
}

export function resolveOnboardRunOptions(
  options: OnboardEntryOptionsInput["opts"] & { autoYes?: boolean; nonInteractive?: boolean },
  env: NodeJS.ProcessEnv,
  persistedSessionStatus: string | null,
  isNonInteractiveEnv: () => boolean,
  terminal: { stdinIsTty: boolean; stdoutIsTty: boolean } = {
    stdinIsTty: Boolean(process.stdin?.isTTY),
    stdoutIsTty: Boolean(process.stdout?.isTTY),
  },
  persistedRecoverySandboxName: string | null = null,
  persistedSessionSandboxName: string | null = null,
  retainedRecoverySandboxNames: readonly string[] = [],
) {
  const resume =
    options.resume === true || (options.fresh !== true && persistedSessionStatus === "in_progress");
  const nonInteractive =
    options.nonInteractive === true ||
    ((options.autoYes === true || env.NEMOCLAW_YES === "1") && resume && !terminal.stdinIsTty) ||
    isNonInteractiveEnv();
  return {
    resume,
    nonInteractive,
    entryOptionsInput: {
      opts: options,
      env,
      ...terminal,
      persistedSessionStatus,
      persistedRecoverySandboxName,
      persistedSessionSandboxName,
      retainedRecoverySandboxNames,
    },
  };
}

export function resolveOnboardRunEntryOptions(
  options: OnboardEntryOptionsInput["opts"] & { autoYes?: boolean; nonInteractive?: boolean },
  env: NodeJS.ProcessEnv,
  persistedSessionStatus: string | null,
  isNonInteractiveEnv: () => boolean,
  deps: Omit<OnboardEntryOptionsDeps, "isNonInteractive">,
  persistedRecoverySandboxName: string | null = null,
  persistedSessionSandboxName: string | null = null,
  retainedRecoverySandboxNames: readonly string[] = [],
) {
  const context = resolveOnboardRunOptions(
    options,
    env,
    persistedSessionStatus,
    isNonInteractiveEnv,
    undefined,
    persistedRecoverySandboxName,
    persistedSessionSandboxName,
    retainedRecoverySandboxNames,
  );
  return {
    ...context,
    ...resolveOnboardEntryOptions(context.entryOptionsInput, {
      ...deps,
      isNonInteractive: () => context.nonInteractive,
    }),
  };
}

export function resolveDefaultRunEntryOptions(
  options: OnboardEntryOptionsInput["opts"] & { autoYes?: boolean; nonInteractive?: boolean },
  persistedSession: PersistedOnboardEntrySession | null,
  validateSandboxName: OnboardEntryOptionsDeps["validateName"],
  env: NodeJS.ProcessEnv = process.env,
  retainedRecoverySandboxNames: readonly string[] = [],
) {
  return resolveOnboardRunEntryOptions(
    options,
    env,
    persistedSession?.status ?? null,
    isNonInteractiveEnv,
    {
      validateName: validateSandboxName,
      reservedSandboxNames: RESERVED_SANDBOX_NAMES,
      cliDisplayName,
      getNameValidationGuidance,
      error: (message) => console.error(message),
      exitProcess: (code) => process.exit(code),
    },
    persistedSession?.cancellationRecovery?.sandboxName ?? null,
    persistedSession?.sandboxName ?? null,
    retainedRecoverySandboxNames,
  );
}

export function resolveDefaultRunEntryOptionsFromState(
  options: OnboardEntryOptionsInput["opts"] & { autoYes?: boolean; nonInteractive?: boolean },
  validateSandboxName: OnboardEntryOptionsDeps["validateName"],
  state: DefaultRunEntryState,
  env: NodeJS.ProcessEnv = process.env,
) {
  return resolveDefaultRunEntryOptions(
    options,
    state.loadSession(),
    validateSandboxName,
    env,
    state.listRetainedSandboxRecoveryRecords().map((record) => record.sandboxName),
  );
}

export function assertDefaultSandboxNameAllowed(sandboxName: string): void {
  if (!RESERVED_SANDBOX_NAMES.has(sandboxName)) return;
  console.error(
    `  Reserved name in resumed session: '${sandboxName}' is a ${cliDisplayName()} CLI command.`,
  );
  console.error("  Start a fresh onboard with --name <sandbox> to choose a different name.");
  process.exit(1);
}
interface StationExpressSessionLifecycle {
  loadSession(): StationExpressSessionLike | null;
  reconcileStationExpressReceiptRetirement(generation: string): void;
}

/** Scope the CLI flag to helpers that still read the compatibility environment variable. */
export function withNonInteractiveEnvironment<Options extends NonInteractiveEntryOptions>(
  run: (options?: Options) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): (options?: Options) => Promise<void> {
  return async (options) => {
    if (options?.nonInteractive !== true) return run(options);

    const previous = env.NEMOCLAW_NON_INTERACTIVE;
    env.NEMOCLAW_NON_INTERACTIVE = "1";
    try {
      await run(options);
    } finally {
      if (previous === undefined) delete env.NEMOCLAW_NON_INTERACTIVE;
      else env.NEMOCLAW_NON_INTERACTIVE = previous;
    }
  };
}

export function wrapOnboard<Options extends ResumableEntryOptions>(
  run: (options?: Options) => Promise<void>,
  session: StationExpressSessionLifecycle,
): (options?: Options) => Promise<void> {
  const guardProviderlessInput = async (options?: Options): Promise<void> => {
    assertProviderlessInterceptorEnvironment(
      options?.apfInterceptorRequested === true,
      process.env,
    );
    await run(options);
  };
  return wrapStationExpressOnboard(
    withNonInteractiveEnvironment(guardProviderlessInput),
    session.loadSession,
    session.reconcileStationExpressReceiptRetirement,
  );
}

export function prepareSessionInput<RuntimeControlRequests extends object>(
  runtimeControlRequests: RuntimeControlRequests,
  sandboxName: string | null,
  resume: boolean,
  preflight: () => void,
) {
  preflight();
  return {
    ...runtimeControlRequests,
    stationExpressIntent: requireStationExpressResumeIntent(process.env, sandboxName, resume),
  };
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
  const retainedRecoverySandboxNames = new Set(
    (input.retainedRecoverySandboxNames ?? []).map((name) => name.trim()).filter(Boolean),
  );
  const recoveryEntryName =
    requestedSandboxName ?? input.persistedSessionSandboxName?.trim() ?? null;
  if (retainedRecoverySandboxNames.size > 0) {
    if (!recoveryEntryName) {
      deps.error(
        "  Onboarding cannot continue while a retained sandbox recovery record is unresolved without an explicit different sandbox name.",
      );
      deps.error(
        "  Use --fresh --name <new-name>; the retained sandbox recovery record stays unresolved.",
      );
      deps.exitProcess(1);
    }
    if (retainedRecoverySandboxNames.has(recoveryEntryName)) {
      deps.error(
        `  Onboarding cannot use retained sandbox '${recoveryEntryName}' while its identity-bound recovery record is unresolved.`,
      );
      deps.error(
        "  Automatic and explicit resume, reuse, recreation, and same-name fresh onboarding remain disabled; NemoClaw has no supported operation to clear this recovery record.",
      );
      deps.exitProcess(1);
    }
  }
  if (input.persistedSessionStatus === "recovery_required") {
    const recoverySandboxName = input.persistedRecoverySandboxName?.trim() || null;
    if (!fresh) {
      deps.error(
        `  Onboarding cannot continue because cancellation preserved sandbox '${recoverySandboxName ?? "unknown"}' in recovery-only state.`,
      );
      deps.error(
        "  Automatic and explicit resume, reuse, and recreation are disabled to protect the retained sandbox.",
      );
      deps.error(
        "  Use --fresh --name <new-name>; the retained sandbox recovery record stays unresolved.",
      );
      deps.exitProcess(1);
    }
    if (
      !recoverySandboxName ||
      !requestedSandboxName ||
      requestedSandboxName === recoverySandboxName
    ) {
      deps.error(
        "  Recovery-only onboarding state requires --fresh with an explicit sandbox name different from the retained sandbox.",
      );
      deps.error(
        "  The retained sandbox recovery record stays unresolved when onboarding starts with another name.",
      );
      deps.exitProcess(1);
    }
    if (!retainedRecoverySandboxNames.has(recoverySandboxName)) {
      deps.error(
        "  Onboarding cannot replace the recovery-only session because its independent retained sandbox recovery record is unavailable.",
      );
      deps.error(
        "  Preserve the session and registry state for identity-bound administrator recovery.",
      );
      deps.exitProcess(1);
    }
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
