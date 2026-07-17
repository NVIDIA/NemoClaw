// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { selectVllmModelFromEnv, type VllmModelDef } from "../inference/vllm-models";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../name-validation";
import { getNemoclawStateRoot, resolveHome, STATE_DIR_NAME } from "../state/state-root";
import { isSafeModelId } from "../validation";

export const STATION_EXPRESS_ENV = "NEMOCLAW_STATION_EXPRESS";
export const STATION_EXPRESS_INTENT_VERSION = 1;

export interface StationExpressResumeIntent {
  version: typeof STATION_EXPRESS_INTENT_VERSION;
  model: string;
  sandboxName: string;
  servedModel?: string;
}

export interface StationExpressSessionLike {
  resumable?: boolean;
  status?: string;
  mode?: string;
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  stationExpressIntent?: StationExpressResumeIntent | null;
  steps?: { provider_selection?: { status?: string | null } | null } | null;
}

interface ResumeOptionsLike {
  resume?: boolean;
  fresh?: boolean;
}

interface StationExpressResumeDeps {
  loadSession(): StationExpressSessionLike | null;
  clearInstallerResume(): void;
  error(message: string): void;
  exitProcess(code: number): never;
}

type StationExpressFailureDeps = Pick<StationExpressResumeDeps, "error" | "exitProcess">;

type IntentResult =
  | { ok: true; intent: StationExpressResumeIntent | null }
  | { ok: false; message: string };

const RESUME_ENV = [
  STATION_EXPRESS_ENV,
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_YES",
  "NEMOCLAW_POLICY_MODE",
  "NEMOCLAW_SANDBOX_NAME",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_VLLM_MODEL",
  "NEMOCLAW_MODEL",
] as const;
const MAX_SERVED_MODEL_LENGTH = 512;
const UNBOUND_INTENT_KEYS = "model,sandboxName,version";
const BOUND_INTENT_KEYS = "model,sandboxName,servedModel,version";
const STATION_EXPRESS_INSTALLER_RESUME_FILE = "station-express-resume";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stationModel(value: unknown): VllmModelDef | null {
  if (typeof value !== "string") return null;
  try {
    const model = selectVllmModelFromEnv({ NEMOCLAW_VLLM_MODEL: value });
    return model?.platforms.includes("station") ? model : null;
  } catch {
    return null;
  }
}

function servedModel(model: VllmModelDef): string {
  return model.servedModelId ?? model.id;
}

function identifiesModel(model: VllmModelDef, value: string): boolean {
  const normalized = value.toLowerCase();
  return [model.envValue, model.id, model.servedModelId].some(
    (candidate) => candidate?.toLowerCase() === normalized,
  );
}

function validSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)
  );
}

export function clearStationExpressInstallerResume(env: NodeJS.ProcessEnv = process.env): void {
  const stateBase = path.join(resolveHome(env), STATE_DIR_NAME);
  const stateFile = path.join(
    getNemoclawStateRoot(resolveHome(env)),
    STATION_EXPRESS_INSTALLER_RESUME_FILE,
  );
  const relative = path.relative(stateBase, stateFile);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing DGX Station Express resume path outside ${stateBase}.`);
  }

  const paths = [stateBase];
  let current = stateBase;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    paths.push(current);
  }

  for (const candidate of paths) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in DGX Station Express resume path: ${candidate}`);
    }
    if (candidate !== stateFile && !stat.isDirectory()) {
      throw new Error(`Refusing invalid DGX Station Express resume directory: ${candidate}`);
    }
    if (candidate === stateFile) {
      const uid = process.getuid?.();
      if (!stat.isFile() || uid === undefined || stat.uid !== uid) {
        throw new Error(
          `Refusing to remove invalid DGX Station Express resume state: ${stateFile}`,
        );
      }
    }
  }

  try {
    fs.unlinkSync(stateFile);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

export function parseStationExpressResumeIntent(value: unknown): StationExpressResumeIntent | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== UNBOUND_INTENT_KEYS && keys !== BOUND_INTENT_KEYS) return null;
  if (value.version !== STATION_EXPRESS_INTENT_VERSION) return null;
  const model = stationModel(value.model);
  if (!model || value.model !== model.envValue || !validSandboxName(value.sandboxName)) return null;
  const servedModelValue = value.servedModel;
  if (
    keys === BOUND_INTENT_KEYS &&
    (typeof servedModelValue !== "string" ||
      servedModelValue.length === 0 ||
      servedModelValue.length > MAX_SERVED_MODEL_LENGTH ||
      servedModelValue.trim() !== servedModelValue ||
      !isSafeModelId(servedModelValue) ||
      !identifiesModel(model, servedModelValue))
  ) {
    return null;
  }
  return {
    version: STATION_EXPRESS_INTENT_VERSION,
    model: model.envValue,
    sandboxName: value.sandboxName,
    ...(keys === BOUND_INTENT_KEYS ? { servedModel: servedModelValue as string } : {}),
  };
}

export function bindStationExpressProviderSelection(
  intentValue: unknown,
  provider: unknown,
  model: unknown,
): StationExpressResumeIntent {
  const intent = parseStationExpressResumeIntent(intentValue);
  const selectedModel = intent ? stationModel(intent.model) : null;
  if (
    !intent ||
    !selectedModel ||
    provider !== "vllm-local" ||
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > MAX_SERVED_MODEL_LENGTH ||
    model.trim() !== model ||
    !isSafeModelId(model) ||
    !identifiesModel(selectedModel, model)
  ) {
    throw new Error("Cannot record an invalid DGX Station Express provider selection.");
  }
  return { ...intent, servedModel: model };
}

function expectedEnvironment(
  intent: StationExpressResumeIntent,
  includeProviderSelection = true,
): Partial<Record<(typeof RESUME_ENV)[number], string>> | null {
  const model = stationModel(intent.model);
  if (!model) return null;
  const expected: Partial<Record<(typeof RESUME_ENV)[number], string>> = {
    [STATION_EXPRESS_ENV]: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_YES: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_SANDBOX_NAME: intent.sandboxName,
  };
  if (includeProviderSelection) {
    expected.NEMOCLAW_PROVIDER = "install-vllm";
    expected.NEMOCLAW_VLLM_MODEL = model.envValue;
    expected.NEMOCLAW_MODEL = servedModel(model);
  }
  return expected;
}

function equivalentEnvironmentValue(
  name: (typeof RESUME_ENV)[number],
  actual: string,
  expected: string,
): boolean {
  if (name === "NEMOCLAW_VLLM_MODEL") {
    return stationModel(actual)?.envValue === expected;
  }
  if (name === "NEMOCLAW_SANDBOX_NAME") {
    return actual.trim().toLowerCase() === expected;
  }
  return actual.trim().toLowerCase() === expected.toLowerCase();
}

function validateExpectedEnvironment(
  env: NodeJS.ProcessEnv,
  expected: Partial<Record<(typeof RESUME_ENV)[number], string>>,
): string | null {
  for (const name of RESUME_ENV) {
    const expectedValue = expected[name];
    if (expectedValue === undefined) continue;
    const actual = env[name];
    if (typeof actual !== "string" || actual.trim().length === 0) continue;
    if (!equivalentEnvironmentValue(name, actual, expectedValue)) return name;
  }
  return null;
}

export function getStationExpressResumeIntent(
  env: NodeJS.ProcessEnv,
  sandboxName: string | null,
): IntentResult {
  const marker = String(env[STATION_EXPRESS_ENV] ?? "").trim();
  if (!marker) return { ok: true, intent: null };
  if (marker !== "1") {
    return { ok: false, message: `${STATION_EXPRESS_ENV} must be 1 when set.` };
  }

  const model = stationModel(env.NEMOCLAW_VLLM_MODEL);
  if (!model || !sandboxName || !validSandboxName(sandboxName)) {
    return {
      ok: false,
      message: "DGX Station Express requires a registered Station vLLM model and sandbox name.",
    };
  }
  const intent: StationExpressResumeIntent = {
    version: STATION_EXPRESS_INTENT_VERSION,
    model: model.envValue,
    sandboxName,
  };
  const expected = expectedEnvironment(intent);
  if (!expected) {
    return { ok: false, message: "DGX Station Express model state is invalid." };
  }
  for (const name of [
    STATION_EXPRESS_ENV,
    "NEMOCLAW_NON_INTERACTIVE",
    "NEMOCLAW_YES",
    "NEMOCLAW_POLICY_MODE",
    "NEMOCLAW_PROVIDER",
  ] as const) {
    const actual = String(env[name] ?? "");
    const expectedValue = expected[name];
    if (!expectedValue || !equivalentEnvironmentValue(name, actual, expectedValue)) {
      return { ok: false, message: `DGX Station Express requires ${name}=${expectedValue}.` };
    }
  }
  const conflict = validateExpectedEnvironment(env, expected);
  if (conflict) {
    return { ok: false, message: `DGX Station Express has a conflicting ${conflict} value.` };
  }
  return { ok: true, intent };
}

/** Validate initial Station Express intent before onboarding acquires its session lock. */
export function requireStationExpressResumeIntent(
  env: NodeJS.ProcessEnv,
  sandboxName: string | null,
  resume: boolean,
  deps: StationExpressFailureDeps = {
    error: (message) => console.error(message),
    exitProcess: (code) => process.exit(code),
  },
): StationExpressResumeIntent | null {
  if (resume) return null;
  const result = getStationExpressResumeIntent(env, sandboxName);
  if (!result.ok) {
    deps.error(`  ${result.message}`);
    deps.exitProcess(1);
  }
  return result.intent;
}

function shouldRestoreStationExpress(
  options: ResumeOptionsLike | undefined,
  session: StationExpressSessionLike | null,
): session is StationExpressSessionLike & { stationExpressIntent: StationExpressResumeIntent } {
  if (options?.fresh === true || !session?.stationExpressIntent || session.resumable === false)
    return false;
  return options?.resume === true || session.status === "in_progress";
}

function requiresExplicitFailedSessionChoice(
  options: ResumeOptionsLike | undefined,
  session: StationExpressSessionLike | null,
): boolean {
  return (
    options?.resume !== true &&
    options?.fresh !== true &&
    Boolean(session?.stationExpressIntent) &&
    session?.resumable !== false &&
    session?.status === "failed"
  );
}

function matchesRecordedStationExpressSelection(
  session: StationExpressSessionLike,
  intent: StationExpressResumeIntent,
): boolean {
  if (session.sandboxName != null && session.sandboxName !== intent.sandboxName) return false;

  const providerComplete = session.steps?.provider_selection?.status === "complete";
  if (!providerComplete) return session.provider == null && session.model == null;

  return Boolean(
    intent.servedModel && session.provider === "vllm-local" && session.model === intent.servedModel,
  );
}

export function withStationExpressResumeEnvironment<Options extends ResumeOptionsLike>(
  run: (options?: Options) => Promise<void>,
  deps: StationExpressResumeDeps,
  env: NodeJS.ProcessEnv = process.env,
): (options?: Options) => Promise<void> {
  return async (options) => {
    const session = deps.loadSession();
    if (options?.fresh === true) {
      try {
        deps.clearInstallerResume();
      } catch (error) {
        deps.error(
          `  Could not discard DGX Station Express installer resume state: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.exitProcess(1);
      }
    }
    if (requiresExplicitFailedSessionChoice(options, session)) {
      deps.error(
        "  A failed DGX Station Express session is waiting. Run nemoclaw onboard --resume to continue it, or nemoclaw onboard --fresh to discard it.",
      );
      deps.exitProcess(1);
    }
    if (!shouldRestoreStationExpress(options, session)) return run(options);
    const intent = parseStationExpressResumeIntent(session.stationExpressIntent);
    if (
      session.mode !== "non-interactive" ||
      !intent ||
      !matchesRecordedStationExpressSelection(session, intent)
    ) {
      deps.error(
        "  DGX Station Express resume state is invalid. Run nemoclaw onboard --fresh to start again.",
      );
      deps.exitProcess(1);
    }

    const expected = expectedEnvironment(
      intent,
      session.steps?.provider_selection?.status !== "complete",
    );
    if (!expected) {
      deps.error(
        "  DGX Station Express resume model is no longer supported. Run nemoclaw onboard --fresh to start again.",
      );
      deps.exitProcess(1);
    }
    const conflict = validateExpectedEnvironment(env, expected);
    if (conflict) {
      deps.error(
        `  DGX Station Express resume conflicts with ${conflict}. Unset ${conflict} and rerun nemoclaw onboard --resume, or run nemoclaw onboard --fresh to start again.`,
      );
      deps.exitProcess(1);
    }

    const previous = new Map<(typeof RESUME_ENV)[number], string | undefined>();
    for (const name of RESUME_ENV) {
      const expectedValue = expected[name];
      if (expectedValue === undefined) continue;
      previous.set(name, env[name]);
      env[name] = expectedValue;
    }
    try {
      await run(options);
    } finally {
      for (const name of RESUME_ENV) {
        if (!previous.has(name)) continue;
        const value = previous.get(name);
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    }
  };
}

export function wrapOnboard<Options extends ResumeOptionsLike>(
  run: (options?: Options) => Promise<void>,
  loadSession: StationExpressResumeDeps["loadSession"],
): (options?: Options) => Promise<void> {
  return withStationExpressResumeEnvironment(run, {
    loadSession,
    clearInstallerResume: clearStationExpressInstallerResume,
    error: (message) => console.error(message),
    exitProcess: (code) => process.exit(code),
  });
}
