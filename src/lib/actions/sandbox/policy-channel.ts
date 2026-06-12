// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { type AgentDefinition, loadAgent } from "../../agent/defs";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt, getCredential } from "../../credentials/store";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import {
  type ChannelManifest,
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  getMessagingManifestAvailabilityContext,
  MessagingHostStateApplier,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  type SandboxMessagingChannelPlan,
  type SandboxMessagingPlan,
  toMessagingAgentId,
} from "../../messaging";
import { hashCredential } from "../../security/credential-hash";

const { isNonInteractive } = require("../../onboard") as { isNonInteractive: () => boolean };
const onboardProviders = require("../../onboard/providers");

import { filterSetupPolicyPresetsForAgent } from "../../onboard/agent-policy-presets";
import * as policies from "../../policy";

const onboardSession =
  require("../../state/onboard-session") as typeof import("../../state/onboard-session");

import { runOpenshell } from "../../adapters/openshell/runtime";
import {
  type PolicyAddOptions,
  type PolicyRemoveOptions,
  parsePolicyAddOptions,
} from "../../domain/policy-channel";
import { getMessagingToken } from "../../onboard/messaging-token";
import { shellQuote } from "../../runner";
import {
  type ChannelDef,
  channelUsesInSandboxQrPairing,
  clearChannelTokens,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  persistChannelTokens,
} from "../../sandbox/channels";
import * as registry from "../../state/registry";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";
import { refreshSandboxPolicyContextFile } from "./policy-context-refresh";
import { executeSandboxCommand, executeSandboxExecCommand } from "./process-recovery";
import { rebuildSandbox } from "./rebuild";
import { printTelegramDirectMessageAllowlistWarning } from "./telegram-channel-bridge-verification";

type ChannelMutationOptions = {
  channel?: string;
  dryRun?: boolean;
  force?: boolean;
};

const messagingManifestRegistry = createBuiltInChannelManifestRegistry();

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const R = useColor ? "\x1b[0m" : "";
const YW = useColor ? "\x1b[1;33m" : "";

/**
 * Handle `nemoclaw <sandbox> policy-add [flags]`. Supports three mutually
 * exclusive modes: interactive preset picker (default), `--from-file <path>`
 * for a single custom preset YAML, and `--from-dir <path>` for every
 * `.yaml`/`.yml` file in a directory. `--dry-run` previews without applying,
 * `--yes`/`-y`/`--force` (or `NEMOCLAW_NON_INTERACTIVE=1`) skips the
 * confirmation prompt. `--from-dir` applies non-hidden files in lexicographic
 * order and aborts at the first failure (already-applied presets are not
 * rolled back).
 */
export async function addSandboxPolicy(
  sandboxName: string,
  options: PolicyAddOptions = {},
): Promise<void> {
  const { dryRun, skipConfirm, source, presetArg } = parsePolicyAddOptions(options);

  if (source.kind === "error") {
    console.error(`  ${source.message}`);
    process.exit(1);
  }

  if (source.kind === "file") {
    const ok = await applyExternalPreset(sandboxName, source.path, { dryRun, yes: skipConfirm });
    if (!ok) process.exit(1);
    return;
  }

  if (source.kind === "dir") {
    const dirPath = source.path;
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      console.error(`  Directory not found: ${dirPath}`);
      process.exit(1);
    }
    const files = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter(
        (ent: { name: string; isFile(): boolean }) =>
          ent.isFile() && !ent.name.startsWith(".") && /\.ya?ml$/i.test(ent.name),
      )
      .map((ent: { name: string }) => path.join(absDir, ent.name))
      .sort();
    if (files.length === 0) {
      console.error(`  No .yaml/.yml preset files in ${dirPath}`);
      process.exit(1);
    }
    for (const f of files) {
      const ok = await applyExternalPreset(sandboxName, f, { dryRun, yes: skipConfirm });
      if (!ok) {
        console.error(`  Aborting --from-dir: ${f} failed. Remaining presets not applied.`);
        process.exit(1);
      }
    }
    return;
  }

  const sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  const allPresets = filterSetupPolicyPresetsForAgent(policies.listPresets(), sandboxAgent);
  const applied = policies.getAppliedPresets(sandboxName);

  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item: { name: string }) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(
        `  Valid presets: ${allPresets.map((item: { name: string }) => item.name).join(", ")}`,
      );
      process.exit(1);
    }
    if (applied.includes(preset.name)) {
      console.error(`  Preset '${preset.name}' is already applied.`);
      process.exit(1);
    }
    answer = preset.name;
  } else {
    if (process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
      console.error("  Non-interactive mode requires a preset name.");
      console.error(`  Usage: ${CLI_NAME} <sandbox> policy-add <preset> [--yes] [--dry-run]`);
      process.exit(1);
    }
    answer = await policies.selectFromList(allPresets, { applied });
  }
  if (!answer) return;

  const presetContent = policies.loadPreset(answer);
  if (!presetContent) return;

  const endpoints = policies.getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Endpoints that would be opened: ${endpoints.join(", ")}`);
  }

  const presetWarning = policies.getPresetValidationWarning(answer);
  if (presetWarning) {
    console.log("");
    console.log(`  ${presetWarning}`);
    console.log("");
  }

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (!skipConfirm) {
    const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
    if (confirm.trim().toLowerCase().startsWith("n")) return;
  }

  if (!policies.applyPreset(sandboxName, answer)) {
    process.exit(1);
  }
  syncSessionPolicyPresetsWithRegistry(sandboxName, answer, "add");
  refreshSandboxPolicyContextFile(sandboxName);
}

/**
 * Apply one custom preset file (`--from-file`, or one entry of `--from-dir`)
 * to a sandbox. Loads and validates the file via `policies.loadPresetFromFile`,
 * prints the egress endpoints with a warning that custom targets are not
 * vetted, honors `dryRun` and `yes`, and delegates to
 * `policies.applyPresetContent`. Returns `true` on success, `false` on any
 * load/apply failure so the caller can decide whether to abort.
 */
async function applyExternalPreset(
  sandboxName: string,
  filePath: string,
  { dryRun, yes }: { dryRun: boolean; yes: boolean },
): Promise<boolean> {
  let loaded;
  try {
    loaded = policies.loadPresetFromFile(filePath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to load preset ${filePath}: ${message}`);
    return false;
  }
  if (!loaded) return false;

  const endpoints = policies.getPresetEndpoints(loaded.content);
  if (endpoints.length > 0) {
    console.log(`  [${loaded.presetName}] Endpoints that would be opened: ${endpoints.join(", ")}`);
    console.log(
      `  ${YW}Warning: custom preset targets are not vetted. Review hosts before applying.${R}`,
    );
  }

  if (dryRun) {
    console.log(`  --dry-run: '${loaded.presetName}' not applied.`);
    return true;
  }

  if (!yes) {
    const confirm = await askPrompt(
      `  Apply '${loaded.presetName}' from ${filePath} to sandbox '${sandboxName}'? [Y/n]: `,
    );
    if (confirm.trim().toLowerCase().startsWith("n")) return true; // user-cancel counts as success (no abort)
  }

  try {
    const result = policies.applyPresetContent(sandboxName, loaded.presetName, loaded.content, {
      custom: { sourcePath: path.resolve(filePath) },
    });
    if (result !== false) {
      // Custom presets share the registry slot with built-ins (customPolicies
      // in policy/index.ts:684), so they need the same session-sync.
      syncSessionPolicyPresetsWithRegistry(sandboxName, loaded.presetName, "add");
      refreshSandboxPolicyContextFile(sandboxName);
    }
    return result !== false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to apply preset '${loaded.presetName}': ${message}`);
    return false;
  }
}

export function listSandboxPolicies(sandboxName: string) {
  const builtin = policies.listPresets();
  const custom = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtin, ...custom];
  const registryPresets = policies.getAppliedPresets(sandboxName);

  // getGatewayPresets returns null when gateway is unreachable, or an
  // array of matched preset names when reachable (possibly empty).
  const gatewayPresets = policies.getGatewayPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p: { name: string; description: string }) => {
    const inRegistry = registryPresets.includes(p.name);
    const inGateway = gatewayPresets ? gatewayPresets.includes(p.name) : null;

    let marker;
    let suffix = "";
    if (inGateway === null) {
      // Gateway unreachable — fall back to registry-only display
      marker = inRegistry ? "●" : "○";
    } else if (inRegistry && inGateway) {
      marker = "●";
    } else if (!inRegistry && !inGateway) {
      marker = "○";
    } else if (inGateway && !inRegistry) {
      marker = "●";
      suffix = " (active on gateway, missing from local state)";
    } else {
      // inRegistry && !inGateway
      marker = "○";
      suffix = " (recorded locally, not active on gateway)";
    }
    console.log(`    ${marker} ${p.name} — ${p.description}${suffix}`);
  });

  if (gatewayPresets === null) {
    console.log("");
    // A null gateway result can be a transient Docker daemon outage rather
    // than a gateway-only problem. Name the runtime outage so the user
    // restarts Docker instead of assuming their local policy state drifted
    // (#4428).
    if (isDockerRuntimeDown(sandboxName)) {
      printDockerRuntimeDownGuidance(sandboxName, {
        writer: console.log,
        retryCommand: "policy-list",
      });
    } else {
      console.log("  ⚠ Could not query gateway — showing local state only.");
    }
  }
  console.log("");
}

// ── Messaging channels ───────────────────────────────────────────

function resolveAgentForSandbox(sandboxName: string): AgentDefinition {
  const entry = registry.getSandbox(sandboxName);
  const agentName = entry?.agent || "openclaw";
  return loadAgent(agentName);
}

function knownManifestChannelNames(): string[] {
  return messagingManifestRegistry.list().map((manifest) => manifest.id);
}

function resolveChannelManifest(name: string): ChannelManifest | undefined {
  return messagingManifestRegistry.get(name.trim().toLowerCase());
}

function availableManifestChannelsForAgent(agent: AgentDefinition): ChannelManifest[] {
  return messagingManifestRegistry.listAvailable(getMessagingManifestAvailabilityContext(agent));
}

function channelSupportedByAgent(channelName: string, agent: AgentDefinition): boolean {
  return availableManifestChannelsForAgent(agent).some((manifest) => manifest.id === channelName);
}

export function listSandboxChannels(sandboxName: string) {
  const agent = resolveAgentForSandbox(sandboxName);
  console.log("");
  console.log(`  Known messaging channels for sandbox '${sandboxName}':`);
  for (const manifest of availableManifestChannelsForAgent(agent)) {
    console.log(`    ${manifest.id} — ${manifest.description ?? manifest.displayName}`);
  }
  console.log("");
}

// Map a channel + token-env-key to the OpenShell provider name onboarding
// uses for it. Mirrors the names in src/lib/onboard.ts:3201-3221 so a
// channels-add upsert collides with (i.e. updates) the same provider that
// a later rebuild would have created from scratch.
function bridgeProviderName(sandboxName: string, channelName: string, envKey: string): string {
  const credential = messagingManifestRegistry
    .get(channelName)
    ?.credentials.find((entry) => entry.providerEnvKey === envKey);
  if (credential) {
    return credential.providerName.replaceAll("{sandboxName}", sandboxName);
  }
  return `${sandboxName}-${channelName}-bridge`;
}

// Detect whether another sandbox already uses one of this channel's
// credentials. Mirrors the onboard.ts conflict check. Returns true if the
// caller should PROCEED with the add, false if it should abort. Never logs
// credential values. Conflict-detection errors fail closed unless --force is set.
async function checkChannelAddConflict(
  sandboxName: string,
  channelName: string,
  acquired: Record<string, string>,
  force: boolean,
): Promise<boolean> {
  // Build credential hashes from the manifest's declared providerEnvKey values.
  // This scopes the lookup to the channel's known credential keys, mirroring
  // what planToConflictChannelRequests() produces from bindings. QR-only
  // channels (e.g. WhatsApp) have no manifest credentials → early exit with no
  // conflict possible. Unknown channelName → also exits early.
  const channelManifest = createBuiltInChannelManifestRegistry()
    .list()
    .find((m) => m.id === channelName);
  if (!channelManifest || channelManifest.credentials.length === 0) return true;

  const credentialHashes: Record<string, string> = {};
  for (const cred of channelManifest.credentials) {
    const token = acquired[cred.providerEnvKey];
    const hash = token ? hashCredential(token) : null;
    if (hash) credentialHashes[cred.providerEnvKey] = hash;
  }
  if (Object.keys(credentialHashes).length === 0) return true;

  const { findChannelConflicts } =
    require("../../messaging/applier") as typeof import("../../messaging/applier");

  let conflicts: ReturnType<typeof findChannelConflicts>;
  try {
    conflicts = findChannelConflicts(
      sandboxName,
      [{ channel: channelName, credentialHashes }],
      registry,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Could not verify messaging channel conflicts for ${channelName}: ${message}`);
    if (force) {
      console.log("  --force: proceeding without a completed messaging channel conflict check.");
      return true;
    }
    if (isNonInteractive()) {
      console.error(
        `  Aborting: rerun with --force to skip the messaging channel conflict check for ${channelName}.`,
      );
      process.exit(1);
    }
    const answer = (await askPrompt("  Continue without a completed conflict check? [y/N]: "))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    console.log("  Aborting channel add.");
    return false;
  }
  if (conflicts.length === 0) return true;

  for (const { channel, sandbox, reason } of conflicts) {
    const detail =
      reason === "matching-token"
        ? `uses the same ${channel} credential`
        : `already has ${channel} enabled, but its credential hash is unavailable`;
    console.log(
      `  ${YW}⚠${R} Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect — continuing may break both bridges (e.g. Telegram getUpdates 409).`,
    );
  }

  if (force) {
    console.log(`  --force: proceeding despite the messaging channel conflict above.`);
    return true;
  }
  if (isNonInteractive()) {
    console.error(
      `  Aborting: resolve the messaging channel conflict above, run \`${CLI_NAME} <sandbox> channels remove ${channelName}\` on the other sandbox, or re-run with --force.`,
    );
    process.exit(1);
  }
  const answer = (await askPrompt("  Continue anyway? [y/N]: ")).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  console.log("  Aborting channel add.");
  return false;
}

// Gateway-scoped Slack Socket Mode conflict (#4953): even with a distinct Slack
// app/token, only one sandbox per OpenShell gateway reliably receives Socket
// Mode events. Runs AFTER `checkChannelAddConflict` so the credential axis —
// which catches a *shared* token and stays accurate across gateways — is
// reported first; this axis then catches the distinct-token, same-gateway case
// instead of letting it become a silent black hole. Returns true to PROCEED,
// false to abort. Fail-soft: a detection error must not crash the add or bypass
// `--force`, so it is swallowed (the credential axis already ran its guarded
// check). Only meaningful for Slack; other channels proceed unchanged.
async function checkSlackSocketModeGatewayConflict(
  sandboxName: string,
  channelName: string,
  force: boolean,
): Promise<boolean> {
  if (channelName !== "slack") return true;
  let conflictMessages: string[] = [];
  try {
    const applier = require("../../messaging/applier") as typeof import("../../messaging/applier");
    const { BASE_GATEWAY_NAME } =
      require("../../onboard/gateway-binding") as typeof import("../../onboard/gateway-binding");
    // `channels add` registers the Slack provider on the default `nemoclaw`
    // gateway — applyChannelAddToGatewayAndRegistry → recoverNamedGatewayRuntime
    // selects `nemoclaw` regardless of the sandbox's recorded gateway. Detect
    // conflicts on the gateway the add actually mutates so the check matches the
    // provider registration and cannot leave a false negative (#4953).
    const gatewayName = BASE_GATEWAY_NAME;
    conflictMessages = applier
      .findSlackSocketModeGatewayConflicts(
        sandboxName,
        gatewayName,
        registry.listSandboxes().sandboxes,
      )
      .map(({ sandbox }) => applier.formatSlackSocketModeConflictMessage(sandbox));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${YW}⚠${R} Could not verify Slack Socket Mode gateway conflicts: ${message}`);
    return true;
  }
  if (conflictMessages.length === 0) return true;

  for (const message of conflictMessages) {
    console.log(`  ${YW}⚠${R} ${message}`);
  }
  if (force) {
    console.log("  --force: proceeding despite the Slack Socket Mode gateway conflict above.");
    return true;
  }
  if (isNonInteractive()) {
    console.error(
      `  Aborting: only one sandbox per gateway can receive Slack Socket Mode events. Run \`${CLI_NAME} <sandbox> channels remove slack\` on the other sandbox, onboard this sandbox on a separate gateway (set NEMOCLAW_GATEWAY_PORT), or re-run with --force.`,
    );
    process.exit(1);
  }
  const answer = (await askPrompt("  Continue anyway? [y/N]: ")).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  console.log("  Aborting channel add.");
  return false;
}

// Push channel tokens to the OpenShell gateway. Durable channel state is
// written separately as a compiled messaging plan.
async function applyChannelAddToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  acquired: Record<string, string>,
): Promise<void> {
  const tokenDefs = Object.entries(acquired).map(([envKey, token]) => ({
    name: bridgeProviderName(sandboxName, channelName, envKey),
    envKey,
    token,
  }));
  if (tokenDefs.length > 0) {
    const recovery = await recoverNamedGatewayRuntime();
    if (!recovery.recovered) {
      console.error(
        `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway. Tokens were staged`,
      );
      console.error("  in env for this run only — re-run after starting the gateway, or run");
      console.error("  'openshell gateway start --name nemoclaw' manually.");
      process.exit(1);
    }
    // upsertMessagingProviders handles create-or-update and process.exits on
    // failure, so reaching the next line means every entry is registered.
    onboardProviders.upsertMessagingProviders(tokenDefs, runOpenshell);
  }
}

// Remove a channel's bridge providers from the gateway and drop it from the
// compiled messaging plan. Mirrors applyChannelAddToGatewayAndRegistry.
async function applyChannelRemoveToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  channelTokenKeys: string[],
  options: { bestEffort?: boolean } = {},
): Promise<{ ok: boolean; residual: string[] }> {
  const bestEffort = Boolean(options.bestEffort);
  const residual: string[] = [];
  let gatewayReachable = true;

  if (channelTokenKeys.length > 0) {
    const recovery = await recoverNamedGatewayRuntime();
    if (!recovery.recovered) {
      console.error(
        `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway to delete the bridge.`,
      );
      console.error(
        "  Re-run after starting the gateway, or run 'openshell gateway start --name nemoclaw'.",
      );
      if (!bestEffort) process.exit(1);
      gatewayReachable = false;
      residual.push("gateway-providers");
    }
  }

  // Detach providers from the sandbox before deletion. openshell rejects
  // `provider delete` with FailedPrecondition when the provider is still
  // attached to a sandbox; the sandbox image itself only stops referencing
  // the bridge after the next rebuild, so without an explicit detach the
  // delete will fail on any sandbox that is still alive at remove-time.
  // NotFound / NotAttached are treated as success-equivalent because a
  // previous run may have already detached, or the channel may have been
  // configured for a sandbox that is no longer alive.
  const detachFailures: Array<{ name: string; output: string }> = [];
  if (gatewayReachable) {
    for (const envKey of channelTokenKeys) {
      const name = bridgeProviderName(sandboxName, channelName, envKey);
      const result = runOpenshell(["sandbox", "provider", "detach", sandboxName, name], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const output = `${result.stdout || ""}${result.stderr || ""}`;
        if (!/\bNotFound\b|not found|not attached/i.test(output)) {
          detachFailures.push({ name, output: output.trim() });
        }
      }
    }
    if (detachFailures.length > 0) {
      console.error(
        `  Failed to detach bridge provider(s) from sandbox '${sandboxName}': ${detachFailures.map((f) => f.name).join(", ")}.`,
      );
      for (const f of detachFailures) {
        console.error(`    [${f.name}] ${f.output.split("\n").join("\n      ")}`);
      }
      if (!bestEffort) {
        console.error("  Registry not updated; re-run after resolving the gateway error.");
        process.exit(1);
      }
      if (!residual.includes("gateway-providers")) residual.push("gateway-providers");
    }
  }

  // Capture each delete's outcome. If any non-NotFound failure surfaces
  // we must NOT update the registry — otherwise NemoClaw would record
  // the channel as removed locally while the bridge is still live in
  // the gateway, which produces a half-configured sandbox the user
  // can't easily recover. Surface the underlying openshell output so the
  // operator can see exactly why the delete was rejected.
  const deleteFailures: Array<{ name: string; output: string }> = [];
  if (gatewayReachable) {
    const detachFailedSet = new Set(detachFailures.map((f) => f.name));
    for (const envKey of channelTokenKeys) {
      const name = bridgeProviderName(sandboxName, channelName, envKey);
      if (!bestEffort && detachFailedSet.has(name)) continue;
      const result = runOpenshell(["provider", "delete", name], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        const output = `${result.stdout || ""}${result.stderr || ""}`;
        if (!/\bNotFound\b|not found/i.test(output)) {
          deleteFailures.push({ name, output: output.trim() });
        }
      }
    }
    if (deleteFailures.length > 0) {
      console.error(
        `  Failed to delete bridge provider(s) from the OpenShell gateway: ${deleteFailures.map((f) => f.name).join(", ")}.`,
      );
      for (const f of deleteFailures) {
        console.error(`    [${f.name}] ${f.output.split("\n").join("\n      ")}`);
      }
      if (!bestEffort) {
        console.error("  Registry not updated; re-run after resolving the gateway error.");
        process.exit(1);
      }
      if (!residual.includes("gateway-providers")) residual.push("gateway-providers");
    }
  }

  return { ok: residual.length === 0, residual };
}

async function promptAndRebuild(sandboxName: string, actionDesc: string): Promise<boolean> {
  if (isNonInteractive()) {
    console.log("");
    console.log(
      `  Change queued. Run '${CLI_NAME} ${sandboxName} rebuild' to apply (${actionDesc}).`,
    );
    return false;
  }
  const answer = (await askPrompt(`  Rebuild '${sandboxName}' now to apply? [Y/n]: `))
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") {
    console.log(
      `  Run '${CLI_NAME} ${sandboxName} rebuild' when you are ready to apply (${actionDesc}).`,
    );
    return false;
  }
  await rebuildSandbox(sandboxName, ["--yes"]);
  return true;
}

// Channels that share the canonical OpenClaw `channels.<name>.enabled` shape
// and emit `[<name>] [default]` startup breadcrumbs in /tmp/gateway.log.
// WhatsApp is QR-only (no host-side bridge process at this point), and WeChat
// is recorded under the `openclaw-weixin` channel id with its own per-account
// metadata flow seeded by the manifest post-agent-install hook — neither match
// the probe shape and would produce false-negative warnings here.
const OPENCLAW_BRIDGE_VERIFIABLE_CHANNELS = new Set(["telegram", "discord", "slack"]);

// Probe OpenClaw runtime state for a freshly added messaging channel. Runs
// after `channels add <channel>` triggers a successful rebuild. Reads the
// baked openclaw.json and tails the gateway log to confirm the bridge module
// is enabled and emitted a startup breadcrumb. Failures here are best-effort
// warnings — the rebuild has already succeeded; the goal is to surface
// "bridge did not spawn" so the user does not discover it from radio silence
// hours later (#4314, #4390). Restricted to the OpenClaw agent because Hermes
// sandboxes use /sandbox/.hermes with a different config layout.
function verifyChannelBridgeAfterRebuild(sandboxName: string, channelName: string): void {
  if (!OPENCLAW_BRIDGE_VERIFIABLE_CHANNELS.has(channelName)) return;
  const agent = resolveAgentForSandbox(sandboxName);
  if (agent.name !== "openclaw") return;
  const configProbe = executeSandboxExecCommand(
    sandboxName,
    "cat /sandbox/.openclaw/openclaw.json 2>/dev/null || true",
    10000,
  );
  if (!configProbe || configProbe.status !== 0 || !configProbe.stdout) {
    console.log(
      `  ${YW}⚠${R} Could not read /sandbox/.openclaw/openclaw.json to verify '${channelName}' bridge startup.`,
    );
    console.log(
      `    Run '${CLI_NAME} ${sandboxName} status' to inspect the sandbox once it is fully running.`,
    );
    return;
  }
  let channelEnabled = false;
  let channelBlock: any = null;
  try {
    const cfg = JSON.parse(configProbe.stdout);
    channelBlock = cfg?.channels?.[channelName];
    channelEnabled = Boolean(channelBlock?.enabled);
  } catch {
    // Malformed config — fall through to the log probe to capture context.
  }
  if (!channelEnabled) {
    console.log(
      `  ${YW}⚠${R} '${channelName}' channel was not marked enabled in baked openclaw.json after rebuild.`,
    );
    console.log(
      `    The bridge will not start. Re-run '${CLI_NAME} ${sandboxName} rebuild' or 'channels remove ${channelName}' and add again.`,
    );
    return;
  }
  // Match both the channel module's own breadcrumbs (`[<channel>] [default]`)
  // and the channel-guard preloads' aggregated form (`[channels] [<channel>]`).
  // The Slack guard writes "[channels] [slack] provider failed to start..."
  // when a token is rejected; ignoring that line here would leave the user
  // with a generic "no breadcrumb" warning instead of the actionable cause.
  const logProbe = executeSandboxExecCommand(
    sandboxName,
    `tail -n 400 /tmp/gateway.log 2>/dev/null | grep -E "^\\[${channelName}\\] |^\\[channels\\] \\[${channelName}\\]" || true`,
    10000,
  );
  const lines = (logProbe?.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    console.log(
      `  ${YW}⚠${R} '${channelName}' bridge did not log a startup breadcrumb in /tmp/gateway.log yet.`,
    );
    console.log(
      `    Tail it with 'openshell sandbox exec --name ${sandboxName} -- tail -f /tmp/gateway.log' if the channel stays silent.`,
    );
    return;
  }
  const credentialWarnings = lines.filter((line) =>
    /credential placeholder|Bot API rejected|startup probe (?:failed|returned)|provider failed to start|bridge did not start within|invalid_auth|token_revoked|token_expired/i.test(
      line,
    ),
  );
  if (credentialWarnings.length > 0) {
    console.log(`  ${YW}⚠${R} '${channelName}' bridge logged credential/startup warnings:`);
    for (const line of credentialWarnings.slice(0, 3)) {
      console.log(`    ${line}`);
    }
    console.log(
      `    Verify the OpenShell provider for ${channelName} holds a valid credential and re-run '${CLI_NAME} ${sandboxName} rebuild' if needed.`,
    );
    return;
  }
  // Treat the channel as observably started only when we see a positive
  // startup signal from the bridge module itself ("starting provider" /
  // "provider ready"). Otherwise the grep above matched a tangential
  // breadcrumb (e.g. a stale "no startup detected" line) and a green
  // "startup detected" message would be misleading.
  const positiveStartup = lines.some((line) =>
    /\bstarting provider\b|\bprovider ready\b/.test(line),
  );
  if (positiveStartup) {
    console.log(`  ${G}✓${R} '${channelName}' bridge startup detected in sandbox runtime log.`);
    if (channelName === "telegram") {
      printTelegramDirectMessageAllowlistWarning(channelBlock, console.log, `${YW}⚠${R}`);
    }
    return;
  }
  console.log(
    `  ${YW}⚠${R} '${channelName}' bridge log lines found but no startup confirmation yet.`,
  );
  console.log(
    `    Tail it with 'openshell sandbox exec --name ${sandboxName} -- tail -f /tmp/gateway.log' if the channel stays silent.`,
  );
}

async function planSandboxChannelAdd(
  sandboxName: string,
  channelId: string,
  agent: AgentDefinition,
): Promise<SandboxMessagingPlan> {
  const planner = new MessagingWorkflowPlanner(
    messagingManifestRegistry,
    createBuiltInMessagingHookRegistry(),
    createBuiltInRenderTemplateResolver(),
  );
  const availableChannels = availableManifestChannelsForAgent(agent);
  const supportedChannelIds = availableChannels.map((manifest) => manifest.id);

  hydrateAddChannelEnvFromSession(sandboxName, channelId);

  try {
    const plan = await planner.buildChannelAddPlanFromSandboxEntry({
      sandboxName,
      agent: toMessagingAgentId(agent),
      isInteractive: !isNonInteractive(),
      channelId,
      sandboxEntry: registry.getSandbox(sandboxName),
      supportedChannelIds,
      credentialAvailability: buildCredentialAvailability([channelId]),
    });
    MessagingSetupApplier.writePlanToEnv(plan);
    return plan;
  } catch (error) {
    console.error(`  Failed to plan messaging channel '${channelId}'.`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function persistManifestChannelDisabledPlan(
  sandboxName: string,
  channelId: string,
  disabled: boolean,
): Promise<boolean> {
  const entry = registry.getSandbox(sandboxName);
  if (!entry?.messaging?.plan) return false;
  const agent = resolveAgentForSandbox(sandboxName);
  const planner = new MessagingWorkflowPlanner(messagingManifestRegistry);
  const context = {
    sandboxName,
    agent: toMessagingAgentId(agent),
    channelId,
    sandboxEntry: entry,
    supportedChannelIds: availableManifestChannelsForAgent(agent).map((manifest) => manifest.id),
  };
  const plan = disabled
    ? await planner.buildChannelStopPlanFromSandboxEntry(context)
    : await planner.buildChannelStartPlanFromSandboxEntry(context);
  return plan ? MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan) : false;
}

async function persistManifestChannelRemovePlan(
  sandboxName: string,
  channelId: string,
): Promise<boolean> {
  const entry = registry.getSandbox(sandboxName);
  if (!entry) return false;
  const agent = resolveAgentForSandbox(sandboxName);
  const planner = new MessagingWorkflowPlanner(messagingManifestRegistry);
  const plan = await planner.buildChannelRemovePlanFromSandboxEntry({
    sandboxName,
    agent: toMessagingAgentId(agent),
    channelId,
    sandboxEntry: entry,
    supportedChannelIds: availableManifestChannelsForAgent(agent).map((manifest) => manifest.id),
  });
  if (!plan) return !entry.messaging?.plan;
  return MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan);
}

function buildCredentialAvailability(channelIds: readonly string[]): Record<string, boolean> {
  const availability: Record<string, boolean> = {};
  for (const channelId of channelIds) {
    const manifest = messagingManifestRegistry.get(channelId);
    if (!manifest) continue;
    for (const input of manifest.inputs) {
      if (input.kind !== "secret" || !input.envKey) continue;
      if (!getMessagingToken(input.envKey)) continue;
      availability[input.id] = true;
      availability[`${manifest.id}.${input.id}`] = true;
      availability[input.envKey] = true;
    }
  }
  return availability;
}

function collectManifestCredentials(manifest: ChannelManifest): Record<string, string> {
  const acquired: Record<string, string> = {};
  for (const credential of manifest.credentials) {
    const value = getMessagingToken(credential.providerEnvKey);
    if (value) acquired[credential.providerEnvKey] = value;
  }
  return acquired;
}

function assertAddChannelPlanActive(
  sandboxName: string,
  manifest: ChannelManifest,
  plan: SandboxMessagingPlan,
): SandboxMessagingChannelPlan {
  const channelPlan = plan.channels.find((channel) => channel.channelId === manifest.id);
  if (channelPlan?.active) return channelPlan;

  const missing =
    channelPlan?.inputs.filter((input) => input.required && !inputAvailable(input)) ?? [];
  if (missing.length > 0) {
    console.error(
      `  Missing required input(s) for channel '${manifest.id}': ${missing
        .map(formatMissingInput)
        .join(", ")}.`,
    );
    if (
      manifest.auth.mode === "host-qr" &&
      getMessagingToken(manifest.credentials[0]?.providerEnvKey)
    ) {
      console.error(
        `  Run '${CLI_NAME} ${sandboxName} channels remove ${manifest.id}' then '${CLI_NAME} ${sandboxName} channels add ${manifest.id}' to capture fresh account metadata.`,
      );
    } else if (isNonInteractive()) {
      console.error(
        `  Set the required environment values or run '${CLI_NAME} ${sandboxName} channels add ${manifest.id}' interactively.`,
      );
    }
  } else {
    console.error(`  Channel '${manifest.id}' was skipped during manifest enrollment.`);
  }
  process.exit(1);
}

function inputAvailable(input: SandboxMessagingChannelPlan["inputs"][number]): boolean {
  if (input.kind === "secret") return input.credentialAvailable === true;
  if (input.value === undefined) return false;
  return typeof input.value === "string" ? input.value.trim().length > 0 : true;
}

function formatMissingInput(input: SandboxMessagingChannelPlan["inputs"][number]): string {
  return input.sourceEnv ? `${input.inputId} (${input.sourceEnv})` : input.inputId;
}

function hydrateAddChannelEnvFromSession(sandboxName: string, channelId: string): void {
  if (channelId !== "wechat") return;
  const savedSession = safeLoadOnboardSession();
  const savedWechat =
    savedSession?.sandboxName === sandboxName ? (savedSession.wechatConfig ?? null) : null;
  if (!savedWechat) return;
  if (savedWechat.accountId && !process.env.WECHAT_ACCOUNT_ID) {
    process.env.WECHAT_ACCOUNT_ID = savedWechat.accountId;
  }
  if (savedWechat.baseUrl && !process.env.WECHAT_BASE_URL) {
    process.env.WECHAT_BASE_URL = savedWechat.baseUrl;
  }
  if (savedWechat.userId && !process.env.WECHAT_USER_ID) {
    process.env.WECHAT_USER_ID = savedWechat.userId;
  }
}

function persistManifestAddState(sandboxName: string, manifest: ChannelManifest): void {
  if (manifest.id === "wechat") persistWechatConfigFromEnv(sandboxName);
}

function persistWechatConfigFromEnv(sandboxName: string): void {
  const captured = {
    accountId: normalizeEnvValue(process.env.WECHAT_ACCOUNT_ID),
    baseUrl: normalizeEnvValue(process.env.WECHAT_BASE_URL),
    userId: normalizeEnvValue(process.env.WECHAT_USER_ID),
  };
  if (!captured.accountId && !captured.baseUrl && !captured.userId) return;
  const session = safeLoadOnboardSession();
  if (session?.sandboxName !== sandboxName) return;
  try {
    onboardSession.updateSession((current) => {
      const prior = current.wechatConfig;
      current.wechatConfig = {
        accountId: captured.accountId || prior?.accountId,
        baseUrl: captured.baseUrl || prior?.baseUrl,
        userId: captured.userId || prior?.userId,
      };
      return current;
    });
  } catch {
    // The channel remains usable for an immediate rebuild; deferred rebuilds
    // can be recovered by re-running channels add for the same sandbox.
  }
}

function safeLoadOnboardSession(): ReturnType<typeof onboardSession.loadSession> {
  try {
    return onboardSession.loadSession();
  } catch {
    return null;
  }
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\r/g, "").trim();
  return normalized || undefined;
}

export async function addSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const rawChannelArg = options.channel;
  if (!rawChannelArg) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> channels add <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownManifestChannelNames().join(", ")}`);
    process.exit(1);
  }

  const manifest = resolveChannelManifest(rawChannelArg);
  if (!manifest) {
    console.error(`  Unknown channel '${rawChannelArg}'.`);
    console.error(`  Valid channels: ${knownManifestChannelNames().join(", ")}`);
    process.exit(1);
  }
  const canonical = manifest.id;

  const agent = resolveAgentForSandbox(sandboxName);
  if (!channelSupportedByAgent(canonical, agent)) {
    console.error(
      `  Channel '${canonical}' is not supported by agent '${agent.name}' for sandbox '${sandboxName}'.`,
    );
    console.error(`  Supported channels: ${agent.messagingPlatforms.join(", ") || "(none)"}`);
    process.exit(1);
  }

  const presetContent = policies.loadPreset(canonical);
  const presetPolicyKeys =
    presetContent === null ? [] : policies.parsePresetPolicyKeys(presetContent);
  if (presetContent === null || presetPolicyKeys.length === 0) {
    if (presetContent !== null && presetPolicyKeys.length === 0) {
      console.error(
        `  Preset YAML for channel '${canonical}' has no parseable entries under 'network_policies:'.`,
      );
    }
    console.error(
      `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels add ${canonical}`,
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(`  --dry-run: would enable channel '${canonical}' for '${sandboxName}'.`);
    return;
  }

  const plan = await planSandboxChannelAdd(sandboxName, canonical, agent);
  const acquired = collectManifestCredentials(manifest);
  if (!(await checkChannelAddConflict(sandboxName, canonical, acquired, force))) {
    return; // user aborted; nothing registered or widened
  }
  // Credential axis passed; now the gateway-scoped Slack Socket Mode axis (#4953)
  // catches the distinct-token, same-gateway case the credential check cannot.
  if (!(await checkSlackSocketModeGatewayConflict(sandboxName, canonical, force))) {
    return; // user aborted; nothing registered or widened
  }
  assertAddChannelPlanActive(sandboxName, manifest, plan);

  // QR-paired channels that own their session inside the sandbox have no
  // host-side credential to acquire; register the bridge now and let the
  // operator complete pairing after rebuild.
  if (manifest.auth.mode === "in-sandbox-qr") {
    if (!applyChannelPresetIfAvailable(sandboxName, canonical)) {
      process.exit(1);
    }
    await applyChannelAddToGatewayAndRegistry(sandboxName, canonical, {});
    persistManifestAddState(sandboxName, manifest);
    if (!MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan)) {
      console.error(`  ${YW}⚠${R} Could not persist messaging plan for '${sandboxName}'.`);
      process.exit(1);
    }
    console.log("");
    const help = manifest.enrollmentHelp ?? manifest.inputs[0]?.prompt?.help;
    if (help) console.log(`  ${help}`);
    console.log(
      `  ${G}✓${R} Enabled ${canonical} channel. Complete QR pairing from inside the sandbox after rebuild.`,
    );
    // Show post-pair guidance (e.g. the channels status hint for WhatsApp)
    // here because the in-sandbox QR branch returns before the shared note
    // loop the non-QR branches use.
    for (const line of manifest.enrollmentNotes ?? []) {
      console.log(`  ${line}`);
    }
    const rebuilt = await promptAndRebuild(sandboxName, `add '${canonical}'`);
    if (rebuilt) verifyChannelBridgeAfterRebuild(sandboxName, canonical);
    return;
  }

  const channelDef = getChannelDef(canonical);
  if (!channelDef) {
    console.error(`  Unknown channel '${canonical}'.`);
    process.exit(1);
  }
  const priorEntry = registry.getSandbox(sandboxName);
  const wasAlreadyEnabled = registry
    .getConfiguredMessagingChannelsFromEntry(priorEntry)
    .includes(canonical);
  const channelTokenKeys = getChannelTokenKeys(channelDef);
  const priorCreds: Record<string, string> = {};
  for (const key of channelTokenKeys) {
    const existing = getCredential(key);
    if (existing != null) priorCreds[key] = existing;
  }
  persistChannelTokens(acquired);
  // Push to the gateway and update the registry NOW so that answering
  // "rebuild later" (or running non-interactively) does not silently
  // discard the change. Pre-fix this was safe because saveCredential()
  // wrote credentials.json; with env-only persistence, exiting before
  // the rebuild used to drop the queued token.
  await applyChannelAddToGatewayAndRegistry(sandboxName, canonical, acquired);
  console.log(`  ${G}✓${R} Registered ${canonical} bridge with the OpenShell gateway.`);

  if (!applyChannelPresetIfAvailable(sandboxName, canonical)) {
    await rollbackChannelAdd(sandboxName, channelDef, canonical, {
      wasAlreadyEnabled,
      priorCreds,
    });
    process.exit(1);
  }

  persistManifestAddState(sandboxName, manifest);
  if (!MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan)) {
    console.error(`  ${YW}⚠${R} Could not persist messaging plan for '${sandboxName}'.`);
    console.error(
      "  Earlier gateway or policy side effects may already have run, but durable channel state was not saved.",
    );
    process.exit(1);
  }

  const rebuilt = await promptAndRebuild(sandboxName, `add '${canonical}'`);
  if (rebuilt) verifyChannelBridgeAfterRebuild(sandboxName, canonical);
}

async function rollbackChannelAdd(
  sandboxName: string,
  channel: ChannelDef,
  canonical: string,
  snapshot: {
    wasAlreadyEnabled: boolean;
    priorCreds: Record<string, string>;
  },
): Promise<{ ok: boolean; residual: string[] }> {
  if (snapshot.wasAlreadyEnabled) {
    console.error(
      `  ${YW}⚠${R} Restoring prior '${canonical}' configuration; new token rotation aborted.`,
    );
    clearChannelTokens(channel);
    if (Object.keys(snapshot.priorCreds).length > 0) {
      persistChannelTokens(snapshot.priorCreds);
    }
    const residual: string[] = ["gateway-providers"];
    console.error(
      `  ${YW}⚠${R} Rollback could not fully clean ${residual.join(", ")}; run '${CLI_NAME} ${sandboxName} channels remove ${canonical}' once the gateway is reachable.`,
    );
    if (Object.keys(snapshot.priorCreds).length > 0) {
      try {
        const priorTokenDefs = Object.entries(snapshot.priorCreds).map(([envKey, token]) => ({
          name: bridgeProviderName(sandboxName, canonical, envKey),
          envKey,
          token,
        }));
        onboardProviders.upsertMessagingProviders(priorTokenDefs, runOpenshell, {
          bestEffort: true,
        });
      } catch (err) {
        console.error(
          `  ${YW}⚠${R} Failed to restore gateway providers for '${canonical}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { ok: false, residual };
  }

  console.error(
    `  ${YW}⚠${R} Rolling back '${canonical}' bridge registration to keep messaging plan and policy state aligned.`,
  );
  clearChannelTokens(channel);
  const result = await applyChannelRemoveToGatewayAndRegistry(
    sandboxName,
    canonical,
    getChannelTokenKeys(channel),
    { bestEffort: true },
  );
  if (!result.ok) {
    console.error(
      `  ${YW}⚠${R} Rollback could not fully clean ${result.residual.join(", ")}; run '${CLI_NAME} ${sandboxName} channels remove ${canonical}' once the gateway is reachable.`,
    );
  }
  return result;
}

export function applyChannelPresetIfAvailable(sandboxName: string, channelName: string): boolean {
  try {
    const applied = policies.applyPreset(sandboxName, channelName);
    if (!applied) {
      console.error(
        `  ${YW}⚠${R} Cannot enable channel '${channelName}': policy preset failed to apply.`,
      );
      console.error(
        `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels add ${channelName}`,
      );
      return false;
    }
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "add");
    refreshSandboxPolicyContextFile(sandboxName);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to apply '${channelName}' policy preset: ${msg}`);
    console.error(
      `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels add ${channelName}`,
    );
    return false;
  }
}

function getSandboxChannelStatePaths(agent: AgentDefinition, channelName: string): string[] {
  const configDir = agent.configPaths.dir;
  const stateDirs = new Set(agent.stateDirs);
  if (stateDirs.has("platforms")) {
    return [`${configDir}/platforms/${channelName}`];
  }
  if (stateDirs.has(channelName)) {
    return [`${configDir}/${channelName}`];
  }
  return [];
}

function isSafeChannelStatePath(p: string): boolean {
  if (!p.startsWith("/sandbox/.")) return false;
  if (p.includes("..")) return false;
  return /^\/sandbox\/\.[A-Za-z0-9_./-]+$/.test(p);
}

const CHANNEL_CLEAR_SENTINEL = "NEMOCLAW_CHANNEL_CLEAR_OK";

// Wipe the durable per-channel state inside the sandbox before rebuild so
// the state_dirs backup does not restore an auth blob the operator just
// asked NemoClaw to forget. Returns true when no cleanup was needed OR
// when the in-sandbox rm produced our success sentinel; false otherwise.
// Tries `openshell sandbox exec` first and falls back to SSH for transient
// wrapper hiccups (mirrors the pattern in process-recovery.ts:286-296).
// Fixes #3998.
function clearSandboxChannelDurableState(sandboxName: string, channelName: string): boolean {
  const agent = resolveAgentForSandbox(sandboxName);
  const paths = getSandboxChannelStatePaths(agent, channelName).filter(isSafeChannelStatePath);
  if (paths.length === 0) return true;

  const quoted = paths.map((p) => shellQuote(p)).join(" ");
  const cmd = `rm -rf -- ${quoted} && printf '%s\\n' ${shellQuote(CHANNEL_CLEAR_SENTINEL)}`;
  const sentinelSeen = (result: { stdout?: string | null } | null): boolean =>
    !!result && typeof result.stdout === "string" && result.stdout.includes(CHANNEL_CLEAR_SENTINEL);

  let result = executeSandboxExecCommand(sandboxName, cmd);
  if (!sentinelSeen(result)) {
    result = executeSandboxCommand(sandboxName, cmd);
  }
  if (!sentinelSeen(result)) {
    console.error(
      `  ${YW}⚠${R} Could not clear in-sandbox '${channelName}' channel state at ${paths.join(", ")}.`,
    );
    return false;
  }
  console.log(`  ${G}✓${R} Cleared in-sandbox '${channelName}' channel state.`);
  return true;
}

// Mirror a registry-side preset add/remove into `session.policyPresets`.
// Without this, a later `rebuild` re-enters onboard resume, reads the
// stale session, and narrows the preset back away — see #3437 follow-up.
// Best-effort: registry has already succeeded; failure paths log and
// swallow so the caller's flow is never broken by a session I/O error.
function syncSessionPolicyPresetsWithRegistry(
  sandboxName: string,
  presetName: string,
  action: "add" | "remove",
): void {
  let session: ReturnType<typeof onboardSession.loadSession>;
  try {
    session = onboardSession.loadSession();
  } catch {
    return;
  }
  // No session = nothing to sync. Foreign sandbox = leave its intent alone.
  if (!session) return;
  if (session.sandboxName !== sandboxName) return;

  const current = Array.isArray(session.policyPresets) ? session.policyPresets : [];
  const has = current.includes(presetName);
  // Skip the file write when the desired state already holds.
  if (action === "add" && has) return;
  if (action === "remove" && !has) return;

  try {
    onboardSession.updateSession((s) => {
      const arr = Array.isArray(s.policyPresets) ? [...s.policyPresets] : [];
      if (action === "add") {
        if (!arr.includes(presetName)) arr.push(presetName);
      } else {
        const idx = arr.indexOf(presetName);
        if (idx >= 0) arr.splice(idx, 1);
      }
      s.policyPresets = arr;
      return s;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `  ${YW}⚠${R} Could not record '${presetName}' preset ${action} in onboard session: ${msg}`,
    );
    console.error(
      `    Registry is consistent; rerun '${CLI_NAME} ${sandboxName} policy-${action === "add" ? "add" : "remove"} ${presetName}' after rebuild if needed.`,
    );
  }
}

// Mirror of applyChannelPresetIfAvailable. When the channel-named built-in
// preset is currently applied to the sandbox, un-apply it so `policy-list`
// no longer reports it active and the L7 proxy stops allow-listing the
// channel's upstream API (defense-in-depth: bridge is gone, egress to
// api.telegram.org / discord.com / slack.com should follow). Warns but does
// not abort the remove flow — the bridge teardown has already succeeded;
// the operator can run `policy-remove <channel>` manually if cleanup falters.
export function removeChannelPresetIfPresent(sandboxName: string, channelName: string): void {
  const builtinPresets = new Set(policies.listPresets().map((p) => p.name));
  if (!builtinPresets.has(channelName)) {
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
    return;
  }
  if (!policies.getAppliedPresets(sandboxName).includes(channelName)) {
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
    return;
  }
  try {
    const removed = policies.removePreset(sandboxName, channelName);
    if (!removed) {
      console.error(
        `  ${YW}⚠${R} Channel '${channelName}' bridge removed but its policy preset failed to un-apply.`,
      );
      console.error(
        `    Run manually after rebuild with: ${CLI_NAME} ${sandboxName} policy-remove ${channelName}`,
      );
    } else {
      syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
      refreshSandboxPolicyContextFile(sandboxName);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to remove '${channelName}' policy preset: ${msg}`);
    console.error(
      `    Run manually after rebuild with: ${CLI_NAME} ${sandboxName} policy-remove ${channelName}`,
    );
  }
}

export async function removeSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const rawChannelArg = options.channel;
  if (!rawChannelArg) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> channels remove <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(rawChannelArg);
  if (!channel) {
    console.error(`  Unknown channel '${rawChannelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }
  const canonical = rawChannelArg.trim().toLowerCase();

  if (dryRun) {
    console.log(`  --dry-run: would remove channel '${canonical}' for '${sandboxName}'.`);
    return;
  }

  clearChannelTokens(channel);
  const tokenKeys = getChannelTokenKeys(channel);
  const isQrChannel = channelUsesInSandboxQrPairing(channel);

  const registryEntry = registry.getSandbox(sandboxName);
  let sessionForSandbox: ReturnType<typeof onboardSession.loadSession> = null;
  try {
    sessionForSandbox = onboardSession.loadSession();
  } catch {
    sessionForSandbox = null;
  }
  const sessionPolicyPresets =
    sessionForSandbox?.sandboxName === sandboxName && Array.isArray(sessionForSandbox.policyPresets)
      ? sessionForSandbox.policyPresets
      : [];
  const hasChannelResidue =
    registry.getConfiguredMessagingChannelsFromEntry(registryEntry).includes(canonical) ||
    (registryEntry?.policies || []).includes(canonical) ||
    sessionPolicyPresets.includes(canonical) ||
    policies.getAppliedPresets(sandboxName).includes(canonical);

  // QR-paired channels store auth blobs inside the sandbox that survive a
  // rebuild via the state_dirs backup. Tear those down FIRST so a cleanup
  // failure leaves the registry/policy untouched — the operator can re-run
  // after starting the sandbox. Bailing here is the only way to keep
  // #3998 from recurring on cleanup error. Skip the cleanup attempt entirely
  // when the registry/policy show no residue — `channels remove` on a
  // never-configured/already-clean sandbox must remain a quiet no-op even
  // when the sandbox is stopped (#4001 review).
  if (
    isQrChannel &&
    hasChannelResidue &&
    !clearSandboxChannelDurableState(sandboxName, canonical)
  ) {
    console.error(
      `  Refusing to proceed: '${canonical}' session state is still inside the sandbox.`,
    );
    console.error(
      `    Start the sandbox, then re-run: ${CLI_NAME} ${sandboxName} channels remove ${canonical}`,
    );
    process.exit(1);
  }

  await applyChannelRemoveToGatewayAndRegistry(sandboxName, canonical, tokenKeys);
  if (tokenKeys.length > 0) {
    console.log(`  ${G}✓${R} Removed ${canonical} bridge from the OpenShell gateway.`);
  } else {
    console.log(`  ${G}✓${R} Removed ${canonical} channel.`);
  }

  removeChannelPresetIfPresent(sandboxName, canonical);
  if (!(await persistManifestChannelRemovePlan(sandboxName, canonical))) {
    console.error(`  ${YW}⚠${R} Could not persist messaging plan for '${sandboxName}'.`);
    process.exit(1);
  }

  // Token-based channels: best-effort tidy of any leftover dir. Token
  // revocation already prevents the bot from authenticating, so a
  // failure here is a warning, not a bail.
  if (!isQrChannel) {
    clearSandboxChannelDurableState(sandboxName, canonical);
  }

  await promptAndRebuild(sandboxName, `remove '${canonical}'`);
}

async function sandboxChannelsSetEnabled(
  sandboxName: string,
  options: ChannelMutationOptions,
  disabled: boolean,
): Promise<void> {
  const verb = disabled ? "stop" : "start";
  const dryRun = Boolean(options.dryRun);
  const channelArg = options.channel;
  if (!channelArg) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> channels ${verb} <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const registryEntry = registry.getSandbox(sandboxName);
  if (!registryEntry) {
    console.error(`  Sandbox '${sandboxName}' not found in the registry.`);
    process.exit(1);
  }

  const normalized = channelArg.trim().toLowerCase();
  const configuredChannels = registry.getConfiguredMessagingChannelsFromEntry(registryEntry);
  if (!configuredChannels.includes(normalized)) {
    console.error(`  Channel '${normalized}' is not configured for '${sandboxName}'.`);
    process.exit(1);
  }
  const alreadyDisabled = registry.getDisabledChannels(sandboxName).includes(normalized);
  if (alreadyDisabled === disabled) {
    console.log(
      `  Channel '${normalized}' is already ${disabled ? "disabled" : "enabled"} for '${sandboxName}'. Nothing to do.`,
    );
    return;
  }

  if (dryRun) {
    console.log(`  --dry-run: would ${verb} channel '${normalized}' for '${sandboxName}'.`);
    return;
  }

  if (!(await persistManifestChannelDisabledPlan(sandboxName, normalized, disabled))) {
    console.error(`  Could not persist messaging plan for '${sandboxName}'.`);
    process.exit(1);
  }
  const state = disabled ? "disabled" : "enabled";
  console.log(`  ${G}✓${R} Marked ${normalized} ${state} for '${sandboxName}'.`);
  await promptAndRebuild(sandboxName, `${verb} '${normalized}'`);
}

export async function stopSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, options, true);
}

export async function startSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, options, false);
}

export async function removeSandboxPolicy(
  sandboxName: string,
  options: PolicyRemoveOptions = {},
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const skipConfirm = Boolean(
    options.yes || options.force || process.env.NEMOCLAW_NON_INTERACTIVE === "1",
  );

  // Remove-able presets = built-in presets + custom presets applied via
  // --from-file / --from-dir (tracked in registry.customPolicies).
  const builtinPresets = policies.listPresets();
  const customPresets = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtinPresets, ...customPresets];
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = options.preset;
  let answer = null;
  if (presetArg) {
    const normalized = presetArg.trim().toLowerCase();
    const preset = allPresets.find((item: { name: string }) => item.name === normalized);
    if (!preset) {
      console.error(`  Unknown preset '${presetArg}'.`);
      console.error(
        `  Valid presets: ${allPresets.map((item: { name: string }) => item.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }
    if (!applied.includes(preset.name)) {
      console.error(`  Preset '${preset.name}' is not applied.`);
      process.exit(1);
    }
    answer = preset.name;
  } else {
    if (process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
      console.error("  Non-interactive mode requires a preset name.");
      console.error(`  Usage: ${CLI_NAME} <sandbox> policy-remove <preset> [--yes] [--dry-run]`);
      process.exit(1);
    }
    answer = await policies.selectForRemoval(allPresets, { applied });
  }
  if (!answer) return;

  // Resolve preset content: built-in first, then custom (persisted in
  // registry). Needed only for the endpoint preview below — removePreset()
  // itself re-resolves on the library side.
  let presetContent: string | null = policies.loadPreset(answer);
  if (!presetContent) {
    const entry = customPresets.find((p: { name: string }) => p.name === answer);
    if (entry) {
      const persisted = registry
        .getCustomPolicies(sandboxName)
        .find((p: { name: string }) => p.name === answer);
      presetContent = persisted ? persisted.content : null;
    }
  }
  if (!presetContent) return;

  const endpoints = policies.getPresetEndpoints(presetContent);
  if (endpoints.length > 0) {
    console.log(`  Endpoints that would be removed: ${endpoints.join(", ")}`);
  }

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (!skipConfirm) {
    const confirm = await askPrompt(`  Remove '${answer}' from sandbox '${sandboxName}'? [Y/n]: `);
    if (confirm.trim().toLowerCase().startsWith("n")) return;
  }

  if (!policies.removePreset(sandboxName, answer)) {
    process.exit(1);
  }
  syncSessionPolicyPresetsWithRegistry(sandboxName, answer, "remove");
  refreshSandboxPolicyContextFile(sandboxName);
}
