// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type MessagingBoundaryAgent = "hermes" | "openclaw";
export type DockerRunnerResult =
  | string
  | {
      readonly error?: unknown;
      readonly status: number | null;
      readonly stderr?: string | null;
      readonly stdout?: string | null;
    };
export type DockerRunner = (args: string[]) => DockerRunnerResult;

type JsonRecord = Record<string, unknown>;
type FullPlanScanOptions = {
  readonly allowPlaceholder?: boolean;
  readonly allowRenderedConfig?: boolean;
};

export const FULL_PLAN_ONLY_SENTINEL = "nemoclaw-ci-full-plan-must-not-leak";
export const TEAMS_APP_ID = "nemoclaw-ci-teams-app-id";
export const TEAMS_TENANT_ID = "00000000-0000-0000-0000-000000000042";
export const TEAMS_SECRET_PLACEHOLDER = "openshell:resolve:env:MSTEAMS_APP_PASSWORD";
export const OPENCLAW_TEAMS_PACKAGE_SPEC = "npm:@openclaw/msteams@{{openclaw.version}}";
export const OPENCLAW_TEAMS_PACKAGE_VERSION = "2026.6.10";
export const HERMES_TEAMS_PACKAGE_SPEC = "microsoft-teams-apps==2.0.13.4";
export const HERMES_AIOHTTP_PACKAGE_SPEC = "aiohttp==3.14.1";

const PLAN_ENV_KEY = "NEMOCLAW_MESSAGING_PLAN_B64";
const RUNTIME_PLAN_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json";
const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const OPENCLAW_TEAMS_MANAGED_ROOT =
  /^\/sandbox\/\.openclaw\/npm\/projects\/openclaw-msteams-[a-f0-9]{10}\/node_modules\/@openclaw\/msteams$/;
const OPENCLAW_TEAMS_PRELOAD_PATH = "/usr/local/lib/nemoclaw/preloads/msteams-message-hints.js";
const HERMES_ENV_PATH = "/sandbox/.hermes/.env";
const HERMES_CONFIG_PATH = "/sandbox/.hermes/config.yaml";

const OPENCLAW_RUNTIME_PRELOAD = Object.freeze({
  channelId: "teams",
  module: "msteams-message-hints",
  source: OPENCLAW_TEAMS_PRELOAD_PATH,
  target: "/tmp/nemoclaw-msteams-message-hints.js",
  injectInto: ["boot", "connect"],
  optional: false,
  installMessage: "[channels] Installing Microsoft Teams message hint patch (native mentions)",
  installedMessage:
    "[channels] Microsoft Teams message hint patch installed (NODE_OPTIONS updated)",
});

/**
 * Return a compact plan equivalent to the build-relevant output of the Teams
 * manifest compiler. Keep this stdlib-only so CI can generate the build arg
 * before installing the repository's TypeScript runtime dependencies.
 */
export function createMessagingBoundaryPlan(agent: unknown) {
  assertAgent(agent);
  const common = {
    schemaVersion: 1,
    sandboxName: "nemoclaw-ci-messaging-plan-boundary",
    agent,
    workflow: "rebuild",
    channels: [{ channelId: "teams", active: true, disabled: false }],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "teams",
        credentialId: "teamsClientSecret",
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        placeholder: TEAMS_SECRET_PLACEHOLDER,
      },
    ],
    // Deliberately present only in the full build plan. The reduced runtime
    // artifact must discard this field, and neither image nor process env may
    // retain the encoded full plan.
    fullPlanOnlySentinel: FULL_PLAN_ONLY_SENTINEL,
  };

  if (agent === "openclaw") {
    return {
      ...common,
      agentRender: [
        {
          channelId: "teams",
          renderId: "teams-openclaw-channel",
          kind: "json-fragment",
          agent,
          target: "openclaw.json",
          path: "channels.msteams",
          value: {
            enabled: true,
            appId: TEAMS_APP_ID,
            appPassword: TEAMS_SECRET_PLACEHOLDER,
            tenantId: TEAMS_TENANT_ID,
            webhook: { port: 3978, path: "/api/messages" },
            healthMonitor: { enabled: false },
            streaming: { mode: "off" },
            groupPolicy: "open",
            requireMention: true,
          },
        },
        {
          channelId: "teams",
          renderId: "teams-openclaw-plugin",
          kind: "json-fragment",
          agent,
          target: "openclaw.json",
          path: "plugins.entries.msteams",
          value: { enabled: true },
        },
      ],
      buildSteps: [
        {
          channelId: "teams",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: OPENCLAW_TEAMS_PACKAGE_SPEC,
            pin: true,
          },
        },
      ],
      runtimeSetup: {
        nodePreloads: [OPENCLAW_RUNTIME_PRELOAD],
        envAliases: [],
        secretScans: [],
      },
    };
  }

  return {
    ...common,
    agentRender: [
      {
        channelId: "teams",
        renderId: "teams-hermes-env",
        kind: "env-lines",
        agent,
        target: "~/.hermes/.env",
        lines: [
          `TEAMS_CLIENT_ID=${TEAMS_APP_ID}`,
          `TEAMS_CLIENT_SECRET=${TEAMS_SECRET_PLACEHOLDER}`,
          `TEAMS_TENANT_ID=${TEAMS_TENANT_ID}`,
          "TEAMS_PORT=3978",
        ],
      },
      {
        channelId: "teams",
        renderId: "teams-hermes-platform",
        kind: "json-fragment",
        agent,
        target: "~/.hermes/config.yaml",
        path: "platforms.teams",
        value: { enabled: true },
      },
    ],
    buildSteps: [
      {
        channelId: "teams",
        kind: "package-install",
        outputId: "hermesTeamsAppsPackage",
        required: true,
        value: { manager: "hermes-uv-pip", spec: HERMES_TEAMS_PACKAGE_SPEC },
      },
      {
        channelId: "teams",
        kind: "package-install",
        outputId: "hermesAiohttpPackage",
        required: true,
        value: { manager: "hermes-uv-pip", spec: HERMES_AIOHTTP_PACKAGE_SPEC },
      },
    ],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
  };
}

export function encodeMessagingBoundaryPlan(agent: unknown): string {
  return Buffer.from(JSON.stringify(createMessagingBoundaryPlan(agent))).toString("base64");
}

export function defaultDockerRunner(args: string[]): DockerRunnerResult {
  return spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

/**
 * Verify the boundary against a built image. A runner receives Docker argv
 * (without the leading `docker`) and returns a spawnSync-like result; tests can
 * inject a deterministic runner without weakening the production CLI path.
 */
export function verifyMessagingPlanImageBoundary(
  image: unknown,
  agent: unknown,
  runner: DockerRunner = defaultDockerRunner,
) {
  assertImage(image);
  assertAgent(agent);

  const inspected = parseJson(
    runDocker(runner, ["image", "inspect", image], `inspect image ${image}`),
    "docker image inspect output",
  );
  if (!Array.isArray(inspected) || inspected.length !== 1 || !isObject(inspected[0]?.Config)) {
    throw new Error(`docker image inspect returned an unexpected shape for ${image}`);
  }
  const configEnv = inspected[0].Config.Env;
  if (configEnv !== undefined && configEnv !== null && !Array.isArray(configEnv)) {
    throw new Error(`docker image inspect returned non-array Config.Env for ${image}`);
  }
  assertNoPlanEnv("image Config.Env", configEnv ?? []);

  const processEnv = runDocker(
    runner,
    ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/env", image, "-0"],
    `read process environment from ${image}`,
  );
  assertNoPlanEnv("container process environment", processEnv.split("\0").filter(Boolean));

  const artifactText = readImageFile(runner, image, RUNTIME_PLAN_PATH);
  assertReducedRuntimeArtifact(artifactText, agent);

  if (agent === "openclaw") {
    assertOpenClawEvidence(runner, image);
  } else {
    assertHermesEvidence(runner, image);
  }

  return { image, agent, runtimePlanPath: RUNTIME_PLAN_PATH };
}

function assertReducedRuntimeArtifact(text: string, agent: MessagingBoundaryAgent): void {
  assertDoesNotContainFullPlanData("reduced runtime plan", text);
  const artifact = parseJson(text, "reduced runtime plan");
  if (
    !isObject(artifact) ||
    artifact.schemaVersion !== 1 ||
    artifact.agent !== agent ||
    artifact.sandboxName !== "nemoclaw-ci-messaging-plan-boundary" ||
    artifact.workflow !== "rebuild"
  ) {
    throw new Error(`reduced runtime plan is not a schemaVersion 1 ${agent} plan`);
  }
  assertAllowedKeys(
    artifact,
    [
      "schemaVersion",
      "sandboxName",
      "agent",
      "workflow",
      "channels",
      "disabledChannels",
      "credentialBindings",
      "runtimeSetup",
    ],
    "reduced runtime plan",
  );
  for (const key of [
    "agentRender",
    "buildSteps",
    "stateUpdates",
    "healthChecks",
    "fullPlanOnlySentinel",
  ]) {
    if (Object.hasOwn(artifact, key)) {
      throw new Error(`reduced runtime plan unexpectedly contains full-plan key ${key}`);
    }
  }
  if (
    !Array.isArray(artifact.channels) ||
    artifact.channels.length !== 1 ||
    !isObject(artifact.channels[0]) ||
    artifact.channels[0]?.channelId !== "teams" ||
    artifact.channels[0]?.active !== true ||
    artifact.channels[0]?.disabled !== false
  ) {
    throw new Error("reduced runtime plan does not retain the active Teams channel marker");
  }
  assertAllowedKeys(
    artifact.channels[0],
    ["channelId", "active", "disabled"],
    "reduced runtime plan channel",
  );
  if (!Array.isArray(artifact.disabledChannels) || artifact.disabledChannels.length !== 0) {
    throw new Error("reduced runtime plan contains unexpected disabled channels");
  }
  const [credentialBinding] = Array.isArray(artifact.credentialBindings)
    ? artifact.credentialBindings
    : [];
  if (
    !Array.isArray(artifact.credentialBindings) ||
    artifact.credentialBindings.length !== 1 ||
    !isObject(credentialBinding) ||
    credentialBinding.channelId !== "teams" ||
    credentialBinding.providerEnvKey !== "MSTEAMS_APP_PASSWORD"
  ) {
    throw new Error("reduced runtime plan does not contain the sanitized Teams credential binding");
  }
  assertAllowedKeys(
    credentialBinding,
    ["channelId", "providerEnvKey"],
    "reduced runtime plan credential binding",
  );
  const runtimeSetup = artifact.runtimeSetup;
  if (
    !isObject(runtimeSetup) ||
    !Array.isArray(runtimeSetup.nodePreloads) ||
    !Array.isArray(runtimeSetup.envAliases) ||
    !Array.isArray(runtimeSetup.secretScans)
  ) {
    throw new Error("reduced runtime plan is missing the normalized runtimeSetup arrays");
  }
  assertAllowedKeys(
    runtimeSetup,
    ["nodePreloads", "envAliases", "secretScans"],
    "reduced runtime plan runtimeSetup",
  );
  assertRuntimeSetupEntryAllowlist(
    runtimeSetup.nodePreloads,
    [
      "channelId",
      "source",
      "target",
      "injectInto",
      "optional",
      "installMessage",
      "installedMessage",
    ],
    "nodePreloads",
  );
  assertRuntimeSetupEntryAllowlist(
    runtimeSetup.envAliases,
    ["channelId", "envKey", "match", "value", "message"],
    "envAliases",
  );
  assertRuntimeSetupEntryAllowlist(
    runtimeSetup.secretScans,
    ["channelId", "path", "pattern", "message", "exitCode"],
    "secretScans",
  );
  if (runtimeSetup.envAliases.length !== 0 || runtimeSetup.secretScans.length !== 0) {
    throw new Error("reduced runtime plan contains unexpected Teams runtime setup entries");
  }
  if (agent === "openclaw") {
    const [preload] = runtimeSetup.nodePreloads;
    if (
      runtimeSetup.nodePreloads.length !== 1 ||
      !isObject(preload) ||
      preload.channelId !== "teams" ||
      preload.source !== OPENCLAW_TEAMS_PRELOAD_PATH ||
      preload.target !== OPENCLAW_RUNTIME_PRELOAD.target ||
      JSON.stringify(preload.injectInto) !== JSON.stringify(["boot", "connect"]) ||
      preload.optional !== false ||
      Object.hasOwn(preload, "module")
    ) {
      throw new Error("reduced runtime plan does not contain the sanitized Teams node preload");
    }
  } else if (runtimeSetup.nodePreloads.length !== 0) {
    throw new Error("Hermes reduced runtime plan unexpectedly contains node preloads");
  }
}

function assertOpenClawEvidence(runner: DockerRunner, image: string): void {
  const configText = readImageFile(runner, image, OPENCLAW_CONFIG_PATH);
  assertDoesNotContainFullPlanData("OpenClaw rendered config", configText, {
    allowPlaceholder: true,
    allowRenderedConfig: true,
  });
  const config = parseJson(configText, "OpenClaw rendered config");
  const channels = isObject(config) && isObject(config.channels) ? config.channels : {};
  const teams = channels.msteams;
  const plugins = isObject(config) && isObject(config.plugins) ? config.plugins : {};
  const pluginEntries = isObject(plugins.entries) ? plugins.entries : {};
  const teamsPlugin = pluginEntries.msteams;
  if (
    !isObject(teams) ||
    teams.enabled !== true ||
    teams.appId !== TEAMS_APP_ID ||
    teams.appPassword !== TEAMS_SECRET_PLACEHOLDER ||
    teams.tenantId !== TEAMS_TENANT_ID ||
    !isObject(teamsPlugin) ||
    teamsPlugin.enabled !== true
  ) {
    throw new Error("OpenClaw image is missing the expected Teams render output");
  }

  const inspectText = runDocker(
    runner,
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "sandbox",
      "--env",
      "HOME=/sandbox",
      "--entrypoint",
      "openclaw",
      image,
      "plugins",
      "inspect",
      "msteams",
      "--runtime",
      "--json",
    ],
    `inspect the OpenClaw Teams plugin in ${image}`,
  );
  const inspect = parseJsonAfterLogPreamble(inspectText, "OpenClaw Teams plugin inspection");
  const plugin = isObject(inspect) && isObject(inspect.plugin) ? inspect.plugin : {};
  const hasTeamsChannel =
    isObject(inspect) &&
    Array.isArray(inspect.capabilities) &&
    inspect.capabilities.some(
      (capability) =>
        isObject(capability) &&
        capability.kind === "channel" &&
        Array.isArray(capability.ids) &&
        capability.ids.includes("msteams"),
    );
  if (
    plugin.id !== "msteams" ||
    plugin.packageName !== "@openclaw/msteams" ||
    plugin.version !== OPENCLAW_TEAMS_PACKAGE_VERSION ||
    plugin.status !== "loaded" ||
    typeof plugin.rootDir !== "string" ||
    !OPENCLAW_TEAMS_MANAGED_ROOT.test(plugin.rootDir) ||
    !hasTeamsChannel
  ) {
    throw new Error(
      `OpenClaw Teams plugin evidence must be loaded from the managed npm project as @openclaw/msteams@${OPENCLAW_TEAMS_PACKAGE_VERSION} with the msteams channel registered`,
    );
  }

  const preload = readImageFile(runner, image, OPENCLAW_TEAMS_PRELOAD_PATH);
  if (preload.trim().length === 0) {
    throw new Error("OpenClaw Teams runtime preload is empty");
  }
}

function assertHermesEvidence(runner: DockerRunner, image: string): void {
  const envText = readImageFile(runner, image, HERMES_ENV_PATH);
  assertDoesNotContainFullPlanData("Hermes rendered .env", envText, {
    allowPlaceholder: true,
    allowRenderedConfig: true,
  });
  const renderedEnv = parseEnvFile(envText);
  if (
    renderedEnv.TEAMS_CLIENT_ID !== TEAMS_APP_ID ||
    renderedEnv.TEAMS_CLIENT_SECRET !== TEAMS_SECRET_PLACEHOLDER ||
    renderedEnv.TEAMS_TENANT_ID !== TEAMS_TENANT_ID
  ) {
    throw new Error("Hermes image is missing the expected Teams .env render output");
  }

  const yaml = readImageFile(runner, image, HERMES_CONFIG_PATH);
  assertDoesNotContainFullPlanData("Hermes rendered config", yaml, {
    allowRenderedConfig: true,
  });
  if (!yamlHasNestedBooleanTrue(yaml, "platforms", "teams", "enabled")) {
    throw new Error("Hermes image is missing platforms.teams.enabled: true");
  }

  const packageVersionsText = runDocker(
    runner,
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "/opt/hermes/.venv/bin/python",
      image,
      "-c",
      'import importlib.metadata as m,json; print(json.dumps({"microsoft-teams-apps":m.version("microsoft-teams-apps"),"aiohttp":m.version("aiohttp")}))',
    ],
    `read Hermes Teams package metadata from ${image}`,
  );
  const packageVersions = parseJson(packageVersionsText, "Hermes package metadata");
  if (
    !isObject(packageVersions) ||
    packageVersions["microsoft-teams-apps"] !== "2.0.13.4" ||
    packageVersions.aiohttp !== "3.14.1"
  ) {
    throw new Error(
      `Hermes package evidence must include ${HERMES_TEAMS_PACKAGE_SPEC} and ${HERMES_AIOHTTP_PACKAGE_SPEC}`,
    );
  }
}

function readImageFile(runner: DockerRunner, image: string, path: string): string {
  return runDocker(
    runner,
    ["run", "--rm", "--network", "none", "--entrypoint", "/bin/cat", image, path],
    `read ${path} from ${image}`,
  );
}

function runDocker(runner: DockerRunner, args: string[], action: string): string {
  let result: DockerRunnerResult;
  try {
    result = runner(args);
  } catch (error) {
    throw new Error(`Failed to ${action}: ${formatError(error)}`);
  }
  if (typeof result === "string") return result;
  if (!isObject(result)) {
    throw new Error(`Failed to ${action}: Docker runner returned no result`);
  }
  if (result.error) {
    throw new Error(`Failed to ${action}: ${formatError(result.error)}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(
      `Failed to ${action}: docker ${args.join(" ")} exited ${String(result.status)}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return String(result.stdout ?? "");
}

function assertNoPlanEnv(label: string, entries: unknown): void {
  if (
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${label} must be a string array`);
  }
  const planEntry = entries.find((entry) => entry.split("=", 1)[0] === PLAN_ENV_KEY);
  if (planEntry) {
    throw new Error(`${label} retains forbidden ${PLAN_ENV_KEY}`);
  }
  assertDoesNotContainFullPlanData(label, entries.join("\n"));
}

function assertDoesNotContainFullPlanData(
  label: string,
  text: string,
  { allowPlaceholder = false, allowRenderedConfig = false }: FullPlanScanOptions = {},
): void {
  const forbidden = [
    { value: FULL_PLAN_ONLY_SENTINEL, name: FULL_PLAN_ONLY_SENTINEL },
    { value: PLAN_ENV_KEY, name: PLAN_ENV_KEY },
    {
      value: encodeMessagingBoundaryPlan("openclaw"),
      name: "encoded openclaw messaging plan",
    },
    { value: encodeMessagingBoundaryPlan("hermes"), name: "encoded Hermes messaging plan" },
  ];
  if (!allowPlaceholder) {
    forbidden.push({ value: TEAMS_SECRET_PLACEHOLDER, name: TEAMS_SECRET_PLACEHOLDER });
  }
  if (!allowRenderedConfig) {
    forbidden.push(
      { value: TEAMS_APP_ID, name: TEAMS_APP_ID },
      { value: TEAMS_TENANT_ID, name: TEAMS_TENANT_ID },
    );
  }
  for (const { value, name } of forbidden) {
    if (text.includes(value)) {
      throw new Error(`${label} contains full messaging plan data: ${name}`);
    }
  }
}

function assertAllowedKeys(value: JsonRecord, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`${label} contains non-allowlisted fields: ${unexpected.join(", ")}`);
  }
}

function assertRuntimeSetupEntryAllowlist(
  entries: unknown[],
  allowedKeys: readonly string[],
  label: string,
): void {
  entries.forEach((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`reduced runtime plan ${label}[${index}] must be an object`);
    }
    assertAllowedKeys(entry, allowedKeys, `reduced runtime plan ${label}[${index}]`);
  });
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`Hermes rendered .env contains an invalid line: ${line}`);
    out[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return out;
}

function yamlHasNestedBooleanTrue(
  text: string,
  parentKey: string,
  childKey: string,
  valueKey: string,
): boolean {
  const lines = text.split(/\r?\n/);
  let parentIndent: number | null = null;
  let childIndent: number | null = null;
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (parentIndent === null) {
      if (line === `${parentKey}:`) parentIndent = indent;
      continue;
    }
    if (indent <= parentIndent) {
      parentIndent = line === `${parentKey}:` ? indent : null;
      childIndent = null;
      continue;
    }
    if (childIndent === null) {
      if (line === `${childKey}:`) childIndent = indent;
      continue;
    }
    if (indent <= childIndent) {
      childIndent = line === `${childKey}:` ? indent : null;
      continue;
    }
    if (line === `${valueKey}: true`) return true;
  }
  return false;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${formatError(error)}`);
  }
}

function parseJsonAfterLogPreamble(text: string, label: string): unknown {
  const jsonStart = text.search(/^\s*\{/mu);
  return parseJson(jsonStart < 0 ? text : text.slice(jsonStart), label);
}

function assertAgent(agent: unknown): asserts agent is MessagingBoundaryAgent {
  if (agent !== "openclaw" && agent !== "hermes") {
    throw new Error(`agent must be 'openclaw' or 'hermes', got ${String(agent)}`);
  }
}

function assertImage(image: unknown): asserts image is string {
  if (typeof image !== "string" || !image.trim() || image.startsWith("-")) {
    throw new Error("image must be a non-empty Docker image reference");
  }
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return [
    "Usage:",
    "  node --experimental-strip-types scripts/check-messaging-plan-image-boundary.mts plan <openclaw|hermes>",
    "  node --experimental-strip-types scripts/check-messaging-plan-image-boundary.mts verify <image> <openclaw|hermes>",
  ].join("\n");
}

function main(argv: string[]): void {
  const [command, first, second, ...extra] = argv;
  if (command === "plan" && first && !second && extra.length === 0) {
    process.stdout.write(encodeMessagingBoundaryPlan(first));
    return;
  }
  if (command === "verify" && first && second && extra.length === 0) {
    verifyMessagingPlanImageBoundary(first, second);
    process.stdout.write(`Verified ${second} messaging plan image boundary: ${first}\n`);
    return;
  }
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${formatError(error)}\n`);
    process.exitCode = 1;
  }
}
