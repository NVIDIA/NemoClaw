// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw Blueprint Runner
 *
 * Orchestrates OpenClaw sandbox lifecycle inside OpenShell.
 *
 * Protocol:
 *   - stdout lines starting with PROGRESS:<0-100>:<label> are parsed as progress updates
 *   - stdout line RUN_ID:<id> reports the run identifier
 *   - exit code 0 = success, non-zero = failure
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { execa } from "execa";
import YAML from "yaml";

import { validateEndpointUrl } from "./ssrf.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { DASHBOARD_PORT } from "../lib/ports.js";

type Action = "plan" | "apply" | "status" | "rollback";

type BlueprintDataScalar = string | number | boolean | null;
type BlueprintDataValue = BlueprintDataScalar | PolicyAdditions | BlueprintDataValue[];
type RollbackPlanSource = { sandbox_name?: string };
type UnknownRecord = { [key: string]: unknown };

function isAction(value: string | undefined): value is Action {
  return value === "plan" || value === "apply" || value === "status" || value === "rollback";
}

function isObjectLike(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isOptionalPortList(value: unknown): value is number[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((entry) => isValidPort(entry)))
  );
}

function isBlueprintDataValue(value: unknown): value is BlueprintDataValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isBlueprintDataValue(entry));
  }
  if (!isObjectLike(value)) {
    return false;
  }
  return Object.values(value).every((entry) => isBlueprintDataValue(entry));
}

function isInferenceProfile(value: unknown): value is InferenceProfile {
  if (!isObjectLike(value)) {
    return false;
  }

  return (
    isOptionalString(value.provider_type) &&
    isOptionalString(value.provider_name) &&
    isOptionalString(value.endpoint) &&
    isOptionalString(value.model) &&
    isOptionalString(value.credential_env) &&
    isOptionalString(value.credential_default) &&
    isOptionalFiniteNumber(value.timeout_secs)
  );
}

function isBlueprint(value: unknown): value is Blueprint {
  if (!isObjectLike(value)) {
    return false;
  }

  const version = value.version;
  if (!isOptionalString(version)) {
    return false;
  }

  const components = value.components;
  if (components === undefined) {
    return true;
  }
  if (!isObjectLike(components)) {
    return false;
  }

  const inference = components.inference;
  if (inference !== undefined) {
    if (!isObjectLike(inference)) {
      return false;
    }
    const profiles = inference.profiles;
    if (profiles !== undefined) {
      if (
        !isObjectLike(profiles) ||
        !Object.values(profiles).every((entry) => isInferenceProfile(entry))
      ) {
        return false;
      }
    }
  }

  const sandbox = components.sandbox;
  if (sandbox !== undefined) {
    if (!isObjectLike(sandbox)) {
      return false;
    }
    if (
      !isOptionalString(sandbox.image) ||
      !isOptionalString(sandbox.name) ||
      !isOptionalPortList(sandbox.forward_ports)
    ) {
      return false;
    }
  }

  const policy = components.policy;
  if (policy !== undefined) {
    if (!isObjectLike(policy)) {
      return false;
    }
    const additions = policy.additions;
    if (additions !== undefined) {
      if (
        !isObjectLike(additions) ||
        !Object.values(additions).every((entry) => isBlueprintDataValue(entry))
      ) {
        return false;
      }
    }
  }

  return true;
}

// ── Logging helpers ─────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

function progress(pct: number, label: string): void {
  process.stdout.write(`PROGRESS:${String(pct)}:${label}\n`);
}

function readRollbackSandboxName(value: RollbackPlanSource | null): string {
  return value && typeof value.sandbox_name === "string" ? value.sandbox_name : "openclaw";
}

// ── Utilities ───────────────────────────────────────────────────

export function emitRunId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})/, "$1-$2");
  const rid = `nc-${ts}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  process.stdout.write(`RUN_ID:${rid}\n`);
  return rid;
}

type InferenceProfileMap = { [profileName: string]: InferenceProfile };
type PolicyAdditions = { [name: string]: BlueprintDataValue };

interface Blueprint {
  version?: string;
  components?: {
    inference?: {
      profiles?: InferenceProfileMap;
    };
    sandbox?: SandboxConfig;
    policy?: {
      additions?: PolicyAdditions;
    };
  };
}

interface InferenceProfile {
  provider_type?: string;
  provider_name?: string;
  endpoint?: string;
  model?: string;
  credential_env?: string;
  credential_default?: string;
  timeout_secs?: number;
}

interface SandboxConfig {
  image?: string;
  name?: string;
  forward_ports?: number[];
}

export function loadBlueprint(): Blueprint {
  const blueprintPath = process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".";
  const bpFile = join(blueprintPath, "blueprint.yaml");
  let content: string;
  try {
    content = readFileSync(bpFile, "utf-8");
  } catch {
    throw new Error(`blueprint.yaml not found at ${bpFile}`);
  }
  const parsed: unknown = YAML.parse(content);
  if (!isBlueprint(parsed)) {
    throw new Error(
      `blueprint.yaml at ${bpFile} must contain a YAML mapping with valid nested component shapes`,
    );
  }
  return parsed;
}

async function runCmd(
  args: string[],
  options?: { reject?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: options?.reject ?? true,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function openshellAvailable(): Promise<boolean> {
  const result = await execa("which", ["openshell"], { reject: false, stdout: "pipe" });
  return result.exitCode === 0;
}

/**
 * Resolve inference config and sandbox config from a blueprint, applying
 * endpoint URL override and SSRF validation if provided.
 */
async function resolveRunConfig(
  profile: string,
  blueprint: Blueprint,
  endpointUrl?: string,
): Promise<{
  inferenceProfiles: InferenceProfileMap;
  inferenceCfg: InferenceProfile;
  sandboxCfg: SandboxConfig;
}> {
  const inferenceProfiles = blueprint.components?.inference?.profiles ?? {};
  if (!(profile in inferenceProfiles)) {
    const available = Object.keys(inferenceProfiles).join(", ");
    throw new Error(`Profile '${profile}' not found. Available: ${available}`);
  }

  let inferenceCfg = { ...inferenceProfiles[profile] };
  if (endpointUrl) {
    const validated = await validateEndpointUrl(endpointUrl);
    // Use DNS-pinned URL for HTTP (full SSRF/rebinding protection). For HTTPS,
    // keep the original hostname — TLS certificate validation prevents rebinding
    // since the attacker cannot present a valid cert for the target.
    const safe = endpointUrl.startsWith("https:") ? validated.url : validated.pinnedUrl;
    inferenceCfg = { ...inferenceCfg, endpoint: safe };
  }

  // Validate the final endpoint (whether from CLI override or blueprint profile)
  if (inferenceCfg.endpoint) {
    const validated = await validateEndpointUrl(inferenceCfg.endpoint);
    const safe = inferenceCfg.endpoint.startsWith("https:") ? validated.url : validated.pinnedUrl;
    inferenceCfg = { ...inferenceCfg, endpoint: safe };
  }

  const sandboxCfg = blueprint.components?.sandbox ?? {};
  return { inferenceProfiles, inferenceCfg, sandboxCfg };
}

// ── Actions ─────────────────────────────────────────────────────

export interface RunPlan {
  run_id: string;
  profile: string;
  sandbox: {
    image: string;
    name: string;
    forward_ports: number[];
  };
  inference: {
    provider_type: string | undefined;
    provider_name: string | undefined;
    endpoint: string | undefined;
    model: string | undefined;
    credential_env: string | undefined;
  };
  policy_additions: PolicyAdditions;
  dry_run: boolean;
}

export async function actionPlan(
  profile: string,
  blueprint: Blueprint,
  options?: { dryRun?: boolean; endpointUrl?: string },
): Promise<RunPlan> {
  const rid = emitRunId();
  progress(10, "Validating blueprint");

  const { inferenceCfg, sandboxCfg } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  progress(20, "Checking prerequisites");
  if (!(await openshellAvailable())) {
    throw new Error(
      "openshell CLI not found. Install OpenShell first.\n  See: https://github.com/NVIDIA/OpenShell",
    );
  }

  const plan: RunPlan = {
    run_id: rid,
    profile,
    sandbox: {
      image: sandboxCfg.image ?? "openclaw",
      name: sandboxCfg.name ?? "openclaw",
      forward_ports: sandboxCfg.forward_ports ?? [DASHBOARD_PORT],
    },
    inference: {
      provider_type: inferenceCfg.provider_type,
      provider_name: inferenceCfg.provider_name,
      endpoint: inferenceCfg.endpoint,
      model: inferenceCfg.model,
      credential_env: inferenceCfg.credential_env,
    },
    policy_additions: blueprint.components?.policy?.additions ?? {},
    dry_run: options?.dryRun ?? false,
  };

  progress(100, "Plan complete");
  log(JSON.stringify(plan, null, 2));
  return plan;
}

export async function actionApply(
  profile: string,
  blueprint: Blueprint,
  options?: { planPath?: string; endpointUrl?: string },
): Promise<void> {
  if (options?.planPath) {
    throw new Error(
      "--plan is not yet implemented. Run apply without --plan to use the live blueprint.",
    );
  }

  const rid = emitRunId();

  const { inferenceCfg, sandboxCfg } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  const sandboxName = sandboxCfg.name ?? "openclaw";
  const sandboxImage = sandboxCfg.image ?? "openclaw";
  const forwardPorts = sandboxCfg.forward_ports ?? [DASHBOARD_PORT];

  progress(20, "Creating OpenClaw sandbox");
  const createArgs = [
    "openshell",
    "sandbox",
    "create",
    "--from",
    sandboxImage,
    "--name",
    sandboxName,
  ];
  for (const port of forwardPorts) {
    createArgs.push("--forward", String(port));
  }

  const createResult = await runCmd(createArgs, { reject: false });
  if (createResult.exitCode !== 0) {
    if (createResult.stderr.includes("already exists")) {
      log(`Sandbox '${sandboxName}' already exists, reusing.`);
    } else {
      throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
    }
  }

  progress(50, "Configuring inference provider");
  const providerName = inferenceCfg.provider_name ?? "default";
  const providerType = inferenceCfg.provider_type ?? "openai";
  const endpoint = inferenceCfg.endpoint ?? "";
  const model = inferenceCfg.model ?? "";

  const credentialEnv = inferenceCfg.credential_env;
  const credentialDefault = inferenceCfg.credential_default ?? "";
  let credential = "";
  if (credentialEnv) {
    credential = process.env[credentialEnv] ?? credentialDefault;
  }

  const providerArgs = [
    "openshell",
    "provider",
    "create",
    "--name",
    providerName,
    "--type",
    providerType,
  ];
  // Pass the env-var NAME (not the value) to --credential; openshell reads the value from the env.
  // Scope the credential to the subprocess to avoid leaking into later commands.
  const credEnv: Record<string, string> = {};
  if (credential) {
    credEnv.OPENAI_API_KEY = credential;
    providerArgs.push("--credential", "OPENAI_API_KEY");
  }
  if (endpoint) {
    providerArgs.push("--config", `OPENAI_BASE_URL=${endpoint}`);
  }

  await execa(providerArgs[0], providerArgs.slice(1), {
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
    env: buildSubprocessEnv(credEnv),
  });

  progress(70, "Setting inference route");
  const inferenceArgs = [
    "openshell",
    "inference",
    "set",
    "--provider",
    providerName,
    "--model",
    model,
  ];
  if (inferenceCfg.timeout_secs !== undefined) {
    inferenceArgs.push("--timeout", String(inferenceCfg.timeout_secs));
  }
  await runCmd(inferenceArgs, { reject: false });

  progress(85, "Saving run state");
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "plan.json"),
    JSON.stringify(
      {
        run_id: rid,
        profile,
        sandbox_name: sandboxName,
        inference: {
          provider_type: inferenceCfg.provider_type,
          provider_name: inferenceCfg.provider_name,
          endpoint: inferenceCfg.endpoint,
          model: inferenceCfg.model,
          // Omit credential_env and credential_default — secrets must not be persisted
        },
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  progress(100, "Apply complete");
  log(`Sandbox '${sandboxName}' is ready.`);
  log(`Inference: ${providerName} -> ${model} @ ${endpoint}`);
}

function validateRunId(rid: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(rid)) {
    throw new Error(
      `Invalid run ID: must contain only alphanumeric characters, hyphens, and underscores`,
    );
  }
}

function safeRunDir(runsDir: string, rid: string): string {
  validateRunId(rid);
  const resolved = join(runsDir, rid);
  if (!resolved.startsWith(runsDir + sep)) {
    throw new Error("Run ID resolves outside expected directory");
  }
  return resolved;
}

export function actionStatus(rid?: string): void {
  emitRunId();
  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");

  let runDir: string;
  if (rid) {
    runDir = safeRunDir(runsDir, rid);
  } else {
    let runs: string[];
    try {
      runs = readdirSync(runsDir).sort().reverse();
    } catch {
      log("No runs found.");
      return;
    }
    if (runs.length === 0) {
      log("No runs found.");
      return;
    }
    runDir = join(runsDir, runs[0]);
  }

  try {
    log(readFileSync(join(runDir, "plan.json"), "utf-8"));
  } catch {
    const name = runDir.split("/").pop() ?? "unknown";
    log(JSON.stringify({ run_id: name, status: "unknown" }));
  }
}

export async function actionRollback(rid: string): Promise<void> {
  emitRunId();

  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");
  const stateDir = safeRunDir(runsDir, rid);
  try {
    readdirSync(stateDir);
  } catch {
    throw new Error(`Run ${rid} not found.`);
  }

  const planFile = join(stateDir, "plan.json");
  try {
    const planData = readFileSync(planFile, "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const rollbackPlan: RollbackPlanSource | null =
      typeof parsedPlan === "object" && parsedPlan !== null && !Array.isArray(parsedPlan)
        ? parsedPlan
        : null;
    const sandboxName = readRollbackSandboxName(rollbackPlan);

    progress(30, `Stopping sandbox ${sandboxName}`);
    await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });

    progress(60, `Removing sandbox ${sandboxName}`);
    await runCmd(["openshell", "sandbox", "remove", sandboxName], { reject: false });
  } catch {
    // plan.json missing or corrupt — skip sandbox stop/remove
  }

  progress(90, "Cleaning up run state");
  writeFileSync(join(stateDir, "rolled_back"), new Date().toISOString());

  progress(100, "Rollback complete");
}

// ── CLI ─────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const rawAction = argv.at(0);
  const action = isAction(rawAction) ? rawAction : undefined;
  let profile = "default";
  let planPath: string | undefined;
  let runId: string | undefined;
  let dryRun = false;
  let endpointUrl: string | undefined;

  function requireValue(flag: string, i: number): string {
    if (i >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i];
  }

  if (!action) {
    throw new Error(
      `Unknown action '${rawAction ?? "(missing)"}'. Use: plan, apply, status, rollback`,
    );
  }

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--profile":
        profile = requireValue("--profile", ++i);
        break;
      case "--plan":
        planPath = requireValue("--plan", ++i);
        break;
      case "--run-id":
        runId = requireValue("--run-id", ++i);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--endpoint-url":
        endpointUrl = requireValue("--endpoint-url", ++i);
        break;
    }
  }

  switch (action) {
    case "plan": {
      const blueprint = loadBlueprint();
      await actionPlan(profile, blueprint, { dryRun, endpointUrl });
      break;
    }
    case "apply": {
      const blueprint = loadBlueprint();
      await actionApply(profile, blueprint, { planPath, endpointUrl });
      break;
    }
    case "status":
      actionStatus(runId);
      break;
    case "rollback":
      if (!runId) {
        throw new Error("--run-id is required for rollback");
      }
      await actionRollback(runId);
      break;
  }
}
