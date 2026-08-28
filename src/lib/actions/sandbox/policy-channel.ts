// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { runOpenshell } from "../../adapters/openshell/runtime";
import { type AgentDefinition, loadAgent } from "../../agent/defs";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { isNonInteractiveEnv, isNonInteractiveSession } from "../../core/non-interactive";
import {
  prompt as askPrompt,
  getCredential,
  normalizeCredentialValue,
} from "../../credentials/store";
import {
  type PolicyAddOptions,
  type PolicyBaselineOptions,
  type PolicyRemoveOptions,
  parsePolicyAddOptions,
} from "../../domain/policy-channel";
import { recoverNamedGatewayRuntime } from "../../gateway-runtime-action";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import {
  type ChannelManifest,
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  createMessagingPreEnableHookInputs,
  formatSupportedMessagingAgentIds,
  getMessagingManifestAvailabilityContext,
  isMessagingChannelSupportedByAgent,
  isMessagingHookConflictError,
  MessagingHostStateApplier,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  runMessagingHook,
  type SandboxMessagingChannelPlan,
  type SandboxMessagingPlan,
  toMessagingAgentId,
  tryGetMessagingAgentId,
} from "../../messaging";
import { findChannelConflicts } from "../../messaging/applier/conflict-detection/registry";
import type { GooglechatNonInteractiveAudienceCapability } from "../../messaging/channels/googlechat/hooks/tunnel-audience-gate";
import { hydrateMessagingChannelConfig } from "../../messaging-channel-config";
import { filterSetupPolicyPresetsForAgent } from "../../onboard/agent-policy-presets";
import {
  bridgeProviderNamesForChannel,
  bridgeSecretEnvsForChannel,
  collectMessagingBridgeTokenDefs,
  staticMessagingProviderTypeForChannel,
} from "../../onboard/messaging-bridge-provider";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import type { MessagingTokenDef } from "../../onboard/messaging-prep";
import { getMessagingToken } from "../../onboard/messaging-token";
import * as policies from "../../policy";
import {
  digestBaselineEntry,
  getBaselineExclusionFeatureImpact,
  isProtectedBaselineExclusionKey,
  listBaselineEntryKeys,
  renderBaselineEntryScope,
} from "../../policy/baseline-exclusion";
import { formatPolicyListPresetRow } from "../../policy/policy-list-display";
import type { PolicyObject } from "../../policy/preset-parsing";
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
import { hashCredential } from "../../security/credential-hash";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { policyChannelDependencies } from "./policy-channel-dependencies";
import { refreshSandboxPolicyContextFile } from "./policy-context-refresh";
import { executeSandboxCommand, executeSandboxExecCommand } from "./process-recovery";

const isNonInteractive = () => isNonInteractiveSession();

/**
 * Report that `NEMOCLAW_NON_INTERACTIVE=1` leaves no interactive picker, and
 * exit non-zero.
 */
function exitPresetNameRequired(usage: string): never {
  console.error("  Non-interactive mode requires a preset name.");
  console.error(`  Usage: ${usage}`);
  process.exit(1);
}

/**
 * Report that no picker can run in this session, and exit non-zero.
 *
 * Separate from `exitPresetNameRequired` because the conditions differ. That
 * one means the operator set `NEMOCLAW_NON_INTERACTIVE=1`. This one means
 * stdin is not a terminal, or closed, while that variable was unset, so naming
 * the variable would misdirect whoever reads the boot-unit log.
 */
function exitPromptStdinClosed(usage: string): never {
  console.error("  No input available on stdin, so the preset picker cannot prompt.");
  console.error(`  Usage: ${usage}`);
  process.exit(1);
}

/**
 * Await an interactive preset picker and convert a prompt EOF into exit 1.
 *
 * A boot unit that pipes or closes stdin without setting
 * `NEMOCLAW_NON_INTERACTIVE=1` reaches the picker, and the prompt then hits
 * EOF. Before #7418 the picker promise never settled, so the command exited 0
 * having changed nothing. Automation could not distinguish an applied preset
 * from a no-op. Any other failure propagates unchanged.
 */
async function pickPresetOrExit(
  pick: () => Promise<string | null>,
  usage: string,
): Promise<string | null> {
  try {
    return await pick();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EOF") throw error;
    exitPromptStdinClosed(usage);
  }
}

type ChannelMutationOptions = {
  channel?: string;
  dryRun?: boolean;
  force?: boolean;
};

function withSandboxMutationLockUnlessPreview<T>(
  sandboxName: string,
  dryRun: boolean | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (dryRun) return operation();
  return withSandboxMutationLock(sandboxName, operation);
}

/**
 * Internal composition dependencies for channel mutation.
 *
 * The Google Chat capability is intentionally absent from the public CLI
 * composition. The channels stop/start live E2E helper supplies it directly so environment
 * variables and predictable sandbox names cannot enable non-interactive
 * audience enrollment in ordinary production execution.
 */
export interface AddSandboxChannelDependencies {
  readonly googlechatNonInteractiveAudienceCapability?: GooglechatNonInteractiveAudienceCapability;
}

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
 * rolled back). Naming an already-applied preset compares the preset content
 * against the live policy: a match is a successful no-op, while drift (an
 * edited preset file) re-applies the preset through the normal path (#7323).
 * Names owned by a custom (--from-file) preset are refused; re-apply those
 * with `--from-file`.
 */
export async function addSandboxPolicy(
  sandboxName: string,
  options: PolicyAddOptions = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    addSandboxPolicyUnlocked(sandboxName, options),
  );
}

async function addSandboxPolicyUnlocked(
  sandboxName: string,
  options: PolicyAddOptions,
): Promise<void> {
  const {
    dryRun,
    skipConfirm,
    source,
    presetArg,
    trustedPrivateHosts,
    commandTrustedPrivateHosts,
  } = parsePolicyAddOptions(options);

  if (source.kind === "error") {
    console.error(`  ${source.message}`);
    process.exit(1);
  }

  if (source.kind === "file") {
    const prepared = await prepareExternalPolicyPresets(
      [source.path],
      trustedPrivateHosts,
      commandTrustedPrivateHosts,
    );
    if (!prepared) {
      process.exit(1);
      return;
    }
    const ok = await applyExternalPreset(sandboxName, prepared[0], {
      dryRun,
      yes: skipConfirm,
    });
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
    if (commandTrustedPrivateHosts.length === 0) {
      for (const file of files) {
        const prepared = await prepareExternalPolicyPresets([file], trustedPrivateHosts, []);
        const preset = prepared?.[0];
        if (
          !preset ||
          !(await applyExternalPreset(sandboxName, preset, { dryRun, yes: skipConfirm }))
        ) {
          console.error(`  Aborting --from-dir: ${file} failed. Remaining presets not applied.`);
          process.exit(1);
          return;
        }
      }
      return;
    }

    // Command-line declarations are strict and must be consumed exactly once
    // across the whole directory. Prepare that batch before mutating policy so
    // an unused or duplicate declaration cannot partially apply the directory.
    const prepared = await prepareExternalPolicyPresets(files, trustedPrivateHosts, [
      ...commandTrustedPrivateHosts,
    ]);
    if (!prepared) {
      process.exit(1);
      return;
    }
    for (const preset of prepared) {
      if (!(await applyExternalPreset(sandboxName, preset, { dryRun, yes: skipConfirm }))) {
        console.error(
          `  Aborting --from-dir: ${preset.filePath} failed. Remaining presets not applied.`,
        );
        process.exit(1);
        return;
      }
    }
    return;
  }

  const sandboxAgent = registry.getSandbox(sandboxName)?.agent ?? null;
  const allPresets = filterSetupPolicyPresetsForAgent(
    policies.listPresets({ agent: sandboxAgent }),
    sandboxAgent,
  );
  const applied = policies.getAppliedPresets(sandboxName);

  let answer = null;
  let reapplyState: policies.PresetPolicyState | null = null;
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
      // #7323: the registry name alone must not block a re-add. Users edit
      // preset files in place (for example to add `tls: skip` endpoints), so
      // compare the preset content against the live gateway policy and fall
      // through to a normal re-apply when it drifted.
      const customNames = registry
        .getCustomPolicies(sandboxName)
        .map((entry: { name: string }) => entry.name);
      if (customNames.includes(preset.name)) {
        // A custom preset owns this name, so the built-in content is the
        // wrong comparison baseline; re-applying it would clobber the custom
        // policy and double-register the name.
        console.error(`  Preset '${preset.name}' was applied as a custom preset (--from-file).`);
        console.error(
          `  Edit and re-apply it with --from-file, or run '${CLI_NAME} ${sandboxName} policy remove ${preset.name}' first.`,
        );
        process.exit(1);
      }
      const appliedContent = policies.loadPresetForSandbox(sandboxName, preset.name);
      if (!appliedContent) {
        console.error(`  Could not read the content of preset '${preset.name}'.`);
        process.exit(1);
      }
      const appliedState = policies.getPresetContentGatewayState(sandboxName, appliedContent);
      if (appliedState === "match") {
        const needsOpenClawNpmCheck =
          preset.name === "npm" && (sandboxAgent === null || sandboxAgent === "openclaw");
        const npmCompatibilityState = needsOpenClawNpmCheck
          ? policies.getOpenClawNpmCompatibilityState(sandboxName)
          : "match";
        if (npmCompatibilityState === "repair") {
          reapplyState = "drift";
          console.log(
            "  Preset 'npm' matches the live policy, but its OpenClaw compatibility overlay requires repair.",
          );
        } else if (npmCompatibilityState === "drift" || npmCompatibilityState === null) {
          console.error(
            npmCompatibilityState === null
              ? "  Could not verify the live OpenClaw npm compatibility overlay."
              : "  The live OpenClaw npm compatibility overlay has drifted from its reviewed state.",
          );
          console.error(
            "  No policy changes were made; inspect the live npm policy before retrying.",
          );
          process.exit(1);
        } else {
          // The desired state already holds: exit 0 so converging scripts can
          // call `policy add` idempotently, mirroring how applyPreset treats a
          // byte-identical re-application as a successful no-op.
          console.log(
            `  Preset '${preset.name}' is already applied and matches the live policy; nothing to do.`,
          );
          return;
        }
      }
      if (appliedState === null) {
        // Live policy unreadable: drift is unverifiable, so refuse rather
        // than guess.
        console.error(`  Preset '${preset.name}' is already applied.`);
        console.error(
          "  Could not read the live sandbox policy to compare (is the sandbox gateway running?).",
        );
        process.exit(1);
      }
      if (appliedState !== "match") {
        // State-only notice: the downstream flow reports the dry-run,
        // confirmation, and apply outcomes.
        reapplyState = appliedState;
        console.log(
          appliedState === "drift"
            ? `  Preset '${preset.name}' no longer matches the live policy.`
            : `  Preset '${preset.name}' is recorded as applied but missing from the live policy.`,
        );
      }
    }
    answer = preset.name;
  } else {
    const usage = `${CLI_NAME} <sandbox> policy add <preset> [--yes] [--dry-run]`;
    if (isNonInteractiveEnv()) {
      exitPresetNameRequired(usage);
    }
    if (isNonInteractive()) {
      exitPromptStdinClosed(usage);
    }
    answer = await pickPresetOrExit(() => policies.selectFromList(allPresets, { applied }), usage);
  }
  if (!answer) return;

  const presetContent = policies.loadPresetForSandbox(sandboxName, answer);
  if (!presetContent) return;

  if (reapplyState) {
    // A re-add replaces the recorded entries, so use the state-aware heading
    // instead of the fresh-add "would be opened" preview.
    policies.logPresetScopeForState(answer, presetContent, reapplyState);
  } else {
    policies.logPresetScope(presetContent);
  }
  const needsOpenClawNpmDisclosure =
    answer === "npm" && (sandboxAgent === null || sandboxAgent === "openclaw");
  const npmBaselineExcluded =
    needsOpenClawNpmDisclosure &&
    registry.getBaselineExclusions(sandboxName).some((entry) => entry.key === "npm_registry");
  if (needsOpenClawNpmDisclosure && !npmBaselineExcluded) {
    policies.logOpenClawNpmCompatibilityDisclosure();
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

  if (!policies.applyPreset(sandboxName, answer, { suppressDisclosure: true })) {
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
async function prepareExternalPolicyPresets(
  filePaths: readonly string[],
  trustedPrivateHosts: readonly string[],
  commandTrustedPrivateHosts: readonly string[],
): Promise<policies.ExternalPolicyPreset[] | null> {
  const loaded: policies.ExternalPolicyPreset[] = [];
  for (const filePath of filePaths) {
    let preset;
    try {
      preset = policies.loadPresetFromFile(filePath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Failed to load preset ${filePath}: ${message}`);
      return null;
    }
    if (!preset) return null;
    loaded.push({ filePath, ...preset });
  }
  try {
    return await policies.prepareTrustedPrivatePolicyPresets(loaded, trustedPrivateHosts, {
      requiredDeclarations: commandTrustedPrivateHosts,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to prepare trusted private policy endpoints: ${message}`);
    return null;
  }
}

async function applyExternalPreset(
  sandboxName: string,
  loaded: policies.ExternalPolicyPreset,
  { dryRun, yes }: { dryRun: boolean; yes: boolean },
): Promise<boolean> {
  const scopeLines = policies.renderPresetScope(loaded.content);
  if (scopeLines.length > 0) {
    console.log(`  [${loaded.presetName}]`);
    for (const line of scopeLines) console.log(line);
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
      `  Apply '${loaded.presetName}' from ${loaded.filePath} to sandbox '${sandboxName}'? [Y/n]: `,
    );
    if (confirm.trim().toLowerCase().startsWith("n")) return true; // user-cancel counts as success (no abort)
  }

  try {
    const result = policies.applyPresetContent(sandboxName, loaded.presetName, loaded.content, {
      custom: {
        sourcePath: path.resolve(loaded.filePath),
        ...(loaded.trustedPrivatePinCapability
          ? { trustedPrivatePinCapability: loaded.trustedPrivatePinCapability }
          : {}),
      },
      suppressDisclosure: true,
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
  const sandboxEntry = registry.getSandbox(sandboxName);
  const builtin = policies.listPresets({ agent: sandboxEntry?.agent ?? null });
  const custom = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtin, ...custom];
  const registryPresets = policies.getAppliedPresets(sandboxName);

  // getGatewayPresets returns null when gateway is unreachable, or an
  // array of matched preset names when reachable (possibly empty).
  const gatewayPresets = policies.getGatewayPresets(sandboxName);

  const provenanceContext = {
    tierName: sandboxEntry?.policyTier ?? null,
    agentName: sandboxEntry?.agent ?? null,
  };

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p: { name: string; description: string }) => {
    const inRegistry = registryPresets.includes(p.name);
    const inGateway = gatewayPresets ? gatewayPresets.includes(p.name) : null;
    console.log(
      formatPolicyListPresetRow({
        preset: p,
        provenanceContext,
        inRegistry,
        inGateway,
      }),
    );
  });

  const exclusions = registry.getBaselineExclusions(sandboxName);
  const exclusionTransition = registry.getBaselineExclusionTransition(sandboxName);
  if (exclusions.length > 0 || exclusionTransition) {
    console.log("");
    console.log("  Baseline exclusions (unsupported egress removed):");
    const listed = new Map(exclusions.map((exclusion) => [exclusion.key, exclusion]));
    if (exclusionTransition) {
      listed.set(exclusionTransition.exclusion.key, exclusionTransition.exclusion);
    }
    for (const exclusion of listed.values()) {
      const isPending = exclusionTransition?.exclusion.key === exclusion.key;
      // A repair command must remain visible even if the current agent
      // baseline cannot be loaded. Resolving that baseline is part of the
      // explicit retry, not a prerequisite for displaying the journal.
      let currentDigest: string | null | undefined;
      if (isPending) {
        currentDigest = null;
      } else {
        try {
          currentDigest = policies.getSandboxBaselineEntryDigest(sandboxName, exclusion.key);
        } catch {
          currentDigest = undefined;
        }
      }
      const status = isPending
        ? `${YW}repair required — interrupted ${exclusionTransition.operation}; rebuild blocked${R}`
        : currentDigest === undefined
          ? `${YW}release baseline unreadable — inspection required${R}`
          : currentDigest === null
            ? `${YW}baseline entry removed — restore to clear${R}`
            : currentDigest === exclusion.digest
              ? "active"
              : `${YW}baseline changed — re-review required${R}`;
      console.log(`    - ${exclusion.key} (${status})`);
      if (isPending) {
        console.log(
          `      Re-run: ${CLI_NAME} ${sandboxName} policy ${exclusionTransition.operation} ${exclusion.key}`,
        );
      }
    }
  }

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
  return messagingManifestRegistry.listAvailable(
    getMessagingManifestAvailabilityContext(agent, messagingManifestRegistry.list()),
  );
}

function channelSupportedByAgent(manifest: ChannelManifest, agent: AgentDefinition): boolean {
  return isMessagingChannelSupportedByAgent(manifest, agent);
}

export function listSandboxChannels(sandboxName: string) {
  const agent = resolveAgentForSandbox(sandboxName);
  const availableChannels = availableManifestChannelsForAgent(agent);
  console.log("");
  console.log(`  Known messaging channels for sandbox '${sandboxName}':`);
  if (availableChannels.length === 0) {
    console.log(`    (none supported by agent '${agent.name}')`);
  }
  for (const manifest of availableChannels) {
    console.log(`    ${manifest.id} — ${manifest.description ?? manifest.displayName}`);
  }
  console.log("");
}

function formatAvailableChannelsForAgent(agent: AgentDefinition): string {
  return (
    availableManifestChannelsForAgent(agent)
      .map((manifest) => manifest.id)
      .join(", ") || "(none)"
  );
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
    console.error(
      `  Aborting: resolve the messaging channel conflict check for ${channelName} or re-run with --force.`,
    );
    process.exit(1);
  }
  if (conflicts.length === 0) return true;

  for (const { channel, sandbox, reason } of conflicts) {
    const detail =
      reason === "matching-token"
        ? `uses the same ${channel} credential`
        : `already has ${channel} enabled, but its credential hash is unavailable`;
    const message = `Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect.`;
    if (!force) {
      console.error(`  Conflict: ${message}`);
    } else {
      console.log(
        `  ${YW}⚠${R} ${message} Continuing may break both bridges (e.g. Telegram getUpdates 409).`,
      );
    }
  }

  if (force) {
    console.log(`  --force: proceeding despite the messaging channel conflict above.`);
    return true;
  }
  console.error(
    `  Aborting: resolve the messaging channel conflict above, run \`${CLI_NAME} <sandbox> channels remove ${channelName}\` on the other sandbox, or re-run with --force.`,
  );
  process.exit(1);
}

// Channel-owned pre-enable checks run after `checkChannelAddConflict` so the
// shared credential axis is reported first. Hook failure policy controls
// whether registry read failures or detected conflicts require --force.
async function checkMessagingPreEnableHooks(
  sandboxName: string,
  channelName: string,
  plan: SandboxMessagingPlan,
  force: boolean,
): Promise<boolean> {
  const requests = MessagingSetupApplier.listPreEnableChecks(plan);
  if (requests.length === 0) return true;
  const abortOnFailure = requests.some((request) => (request.onFailure ?? "abort") === "abort");

  let registryEntries: ReturnType<typeof registry.listSandboxes>["sandboxes"];
  try {
    registryEntries = registry.listSandboxes().sandboxes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (abortOnFailure && !force) {
      console.error(`  Could not verify messaging pre-enable checks: ${message}`);
      console.error(
        `  Aborting: resolve the messaging pre-enable check for ${channelName} or re-run with --force.`,
      );
      process.exit(1);
    }
    console.log(`  ${YW}⚠${R} Could not verify messaging pre-enable checks: ${message}`);
    return true;
  }

  const hookRegistry = createBuiltInMessagingHookRegistry();
  const currentGatewayName = getSandboxTargetGatewayName(sandboxName);
  const additionalInputs = createMessagingPreEnableHookInputs({
    currentSandbox: sandboxName,
    currentGatewayName,
    registryEntries,
  });

  try {
    await MessagingSetupApplier.applyPreEnableChecks(plan, {
      additionalInputs,
      runHook: (request) =>
        runMessagingHook(
          {
            id: request.hookId,
            phase: request.phase,
            handler: request.handler,
            inputs: request.inputKeys,
            outputs: request.outputs,
            onFailure: request.onFailure,
          },
          hookRegistry,
          {
            channelId: request.channelId,
            isInteractive: !isNonInteractive(),
            inputs: request.inputs,
          },
        ),
    });
  } catch (err) {
    if (!isMessagingHookConflictError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const failedHookAborts = err.onFailure === "abort";
    for (const line of message.split("\n").filter((line) => line.trim().length > 0)) {
      if (failedHookAborts && !force) {
        console.error(`  Conflict: ${line}`);
      } else {
        console.log(`  ${YW}⚠${R} ${line}`);
      }
    }
    if (failedHookAborts && !force) {
      console.error(
        `  Aborting: resolve the messaging pre-enable conflict above, run \`${CLI_NAME} <sandbox> channels remove ${channelName}\` on the other sandbox, or re-run with --force.`,
      );
      process.exit(1);
    }
    if (force) {
      console.log("  --force: proceeding despite the messaging pre-enable conflict above.");
      return true;
    }
    if (isNonInteractive()) {
      console.error(
        `  Aborting: resolve the messaging pre-enable conflict above, run \`${CLI_NAME} <sandbox> channels remove ${channelName}\` on the other sandbox, or re-run with --force.`,
      );
      process.exit(1);
    }
    const answer = (await askPrompt("  Continue anyway? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    console.log("  Aborting channel add.");
    return false;
  }

  return true;
}

// Push channel tokens to the OpenShell gateway. Durable channel state is
// written separately as a compiled messaging plan.
async function applyChannelAddToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  acquired: Record<string, string>,
  applyPolicyAfterAttachment?: () => boolean,
): Promise<boolean | null> {
  const sandboxAgent = registry.getSandbox(sandboxName)?.agent;
  const staticProviderType = staticMessagingProviderTypeForChannel(channelName, sandboxAgent);
  const tokenDefs: MessagingTokenDef[] = Object.entries(acquired).map(([envKey, token]) => ({
    name: bridgeProviderName(sandboxName, channelName, envKey),
    envKey,
    token,
    providerType: staticProviderType ?? MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  }));
  // Bridge channels declare no manifest credentials, so the loop above yields
  // nothing for them. Their provider must be created HERE (same seam onboarding
  // uses): the pasted secret is env-only and gone once this process exits, so a
  // deferred rebuild cannot configure it.
  const bridgeDefs = collectMessagingBridgeTokenDefs({
    sandboxName,
    // Unnormalized: the bridge profile filter owns the unset default and rejects
    // an agent no profile declares.
    agent: sandboxAgent,
    enabledChannels: [channelName],
    disabledChannelNames: new Set<string>(),
    getCredential,
    env: process.env,
    // Env-map values (string | undefined) fit the store helper's input union.
    normalizeCredentialValue: (value) => normalizeCredentialValue(value as string | undefined),
  });
  if (
    bridgeDefs.length === 0 &&
    bridgeProviderNamesForChannel(sandboxName, channelName).length > 0
  ) {
    const secretEnvs = bridgeSecretEnvsForChannel(channelName);
    console.error(
      `  ✗ ${channelName} mints its outbound token gateway-side and needs ${secretEnvs.join(", ")} to configure it.`,
    );
    console.error(
      "  Paste the secret at the enrollment prompt or export the env var, then re-run.",
    );
    process.exit(1);
  }
  tokenDefs.push(...bridgeDefs);
  if (tokenDefs.length === 0) return false;

  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const recovery = await recoverNamedGatewayRuntime({ gatewayName });
  if (!recovery.recovered) {
    console.error(
      `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway. Tokens were staged`,
    );
    console.error("  in env for this run only. Rerun after starting the gateway.");
    console.error(`  ${gatewayStartGuidance(gatewayName)}`);
    process.exit(1);
  }
  policyChannelDependencies.revalidateChannelProviderPolicyAuthority(sandboxName, gatewayName);
  try {
    // bestEffort: failures throw (instead of process.exit inside the helper)
    // so a partial add can be torn down below before exiting.
    const providerNames = policyChannelDependencies.upsertMessagingProviders(
      tokenDefs,
      gatewayName,
      {
        bestEffort: true,
        requireExactBindings: true,
      },
    );
    for (const providerName of providerNames) {
      revalidateMessagingProviderAttachmentTarget(sandboxName, gatewayName);
      const attached = runOpenshell(
        ["sandbox", "provider", "attach", "-g", gatewayName, sandboxName, providerName],
        { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (attached.status !== 0) {
        throw new Error(
          `OpenShell did not attach messaging provider '${providerName}' to sandbox '${sandboxName}'.`,
        );
      }
      revalidateMessagingProviderAttachmentTarget(sandboxName, gatewayName);
    }
    if (applyPolicyAfterAttachment && !applyPolicyAfterAttachment()) {
      return null;
    }
  } catch (err) {
    console.error(
      `  ✗ Failed to register '${channelName}' providers with the gateway: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (
      policyChannelDependencies.isMessagingProviderBindingConflict(err) ||
      policyChannelDependencies.isMessagingProviderMutationFailure(err)
    ) {
      const createdProviderNames = [...(err.createdProviderNames ?? [])];
      const createdProviders = new Set(createdProviderNames);
      const cleanupFailures = createdProviderNames.filter((providerName) => {
        const result = policyChannelDependencies.runGatewayOpenshell(
          gatewayName,
          ["provider", "delete", providerName],
          { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        const output = `${result.stdout || ""}${result.stderr || ""}`;
        return result.status !== 0 && !/\bNotFound\b|not found/i.test(output);
      });
      const updatedProviderNames = err.mutatedProviderNames.filter(
        (providerName) => !createdProviders.has(providerName),
      );
      if (updatedProviderNames.length > 0) {
        console.error(
          `  ${YW}⚠${R} Updated provider state remains for ${updatedProviderNames.join(", ")}; resolve the conflicting provider, then rerun '${CLI_NAME} ${sandboxName} channels add ${channelName}'.`,
        );
      }
      if (cleanupFailures.length > 0) {
        console.error(
          `  ${YW}⚠${R} Could not remove newly created providers ${cleanupFailures.join(", ")}; rerun '${CLI_NAME} ${sandboxName} channels remove ${channelName}'.`,
        );
      }
      process.exit(1);
    }
    const teardown = await applyChannelRemoveToGatewayAndRegistry(
      sandboxName,
      channelName,
      Object.keys(acquired),
      { bestEffort: true },
    );
    if (!teardown.ok) {
      console.error(
        `  ${YW}⚠${R} Partial provider state may remain; run '${CLI_NAME} ${sandboxName} channels remove ${channelName}' once the gateway is reachable.`,
      );
    }
    process.exit(1);
  }
  return true;
}

export function revalidateMessagingProviderAttachmentTarget(
  sandboxName: string,
  gatewayName: string,
): void {
  const expected = registry.getSandbox(sandboxName);
  const lifecycleGeneration = expected?.lifecycleGeneration;
  const expectedFingerprint = expected?.lifecycleLiveIdentityFingerprint;
  if (
    !expected ||
    typeof lifecycleGeneration !== "string" ||
    typeof expectedFingerprint !== "string" ||
    (expected.gatewayName && expected.gatewayName !== gatewayName)
  ) {
    throw new Error(
      `Sandbox '${sandboxName}' has incomplete lifecycle identity for messaging provider attachment.`,
    );
  }
  const liveFingerprint = policyChannelDependencies.inspectMessagingProviderAttachmentTarget(
    sandboxName,
    gatewayName,
  );
  const confirmed = registry.getSandbox(sandboxName);
  if (
    liveFingerprint !== expectedFingerprint ||
    confirmed?.lifecycleGeneration !== lifecycleGeneration ||
    confirmed.lifecycleLiveIdentityFingerprint !== expectedFingerprint ||
    (confirmed.gatewayName && confirmed.gatewayName !== gatewayName)
  ) {
    throw new Error(
      `Sandbox '${sandboxName}' changed before messaging provider attachment completed.`,
    );
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

  // Providers to tear down: the per-credential providers PLUS the gateway-minted
  // bridge provider for a bridge-backed channel (which has no channelTokenKeys, so
  // it would otherwise be left dangling — still minting/rotating a token for a
  // removed channel). Discovery is generic (bridge module), by convention.
  const providerNames = [
    ...new Set([
      ...channelTokenKeys.map((envKey) => bridgeProviderName(sandboxName, channelName, envKey)),
      ...bridgeProviderNamesForChannel(sandboxName, channelName),
    ]),
  ];
  const gatewayName = getSandboxTargetGatewayName(sandboxName);

  if (providerNames.length > 0) {
    const recovery = await recoverNamedGatewayRuntime({ gatewayName });
    if (!recovery.recovered) {
      console.error(
        `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway to delete the bridge.`,
      );
      console.error(`  ${gatewayStartGuidance(gatewayName)} Then rerun this command.`);
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
    for (const name of providerNames) {
      const result = policyChannelDependencies.runGatewayOpenshell(
        gatewayName,
        ["sandbox", "provider", "detach", sandboxName, name],
        {
          ignoreError: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
    for (const name of providerNames) {
      if (detachFailedSet.has(name)) continue;
      const result = policyChannelDependencies.deleteMessagingProviderWithRecovery(
        name,
        sandboxName,
        gatewayName,
      );
      if (!result.ok) {
        const output = `${result.stdout}${result.stderr}`;
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
  await policyChannelDependencies.rebuildSandbox(sandboxName, ["--yes"]);
  return true;
}

// Run manifest-owned post-rebuild health hooks.
// Failures remain best-effort warnings because the rebuild has already
// succeeded; this phase surfaces likely channel startup issues without making
// channel ownership leak back into this action.
async function runMessagingHealthChecksAfterRebuild(
  sandboxName: string,
  plan: SandboxMessagingPlan,
): Promise<void> {
  if (MessagingSetupApplier.listHealthChecks(plan).length === 0) return;

  const hookRegistry = createBuiltInMessagingHookRegistry({
    openclawBridgeHealth: {
      sandboxName,
      executeSandboxCommand: (command, timeoutMs) =>
        executeSandboxExecCommand(sandboxName, command, timeoutMs),
    },
  });
  try {
    await MessagingSetupApplier.applyHealthChecks(plan, {
      runHook: (request) =>
        runMessagingHook(
          {
            id: request.hookId,
            phase: request.phase,
            handler: request.handler,
            inputs: request.inputKeys,
            outputs: request.outputs,
            onFailure: request.onFailure,
          },
          hookRegistry,
          {
            channelId: request.channelId,
            isInteractive: !isNonInteractive(),
            inputs: request.inputs,
          },
        ),
    });
  } catch (err) {
    console.log(`  ${YW}⚠${R} Messaging health check failed: ${formatErrorMessage(err)}`);
  }
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function planSandboxChannelAdd(
  sandboxName: string,
  channelId: string,
  agent: AgentDefinition,
  dependencies: AddSandboxChannelDependencies,
): Promise<SandboxMessagingPlan> {
  const planner = new MessagingWorkflowPlanner(
    messagingManifestRegistry,
    createBuiltInMessagingHookRegistry({
      googlechat: {
        tunnelAudienceGate: {
          nonInteractiveAudienceCapability: dependencies.googlechatNonInteractiveAudienceCapability,
        },
        tunnelRuntime: policyChannelDependencies.googlechatTunnelRuntime(sandboxName),
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
  const availableChannels = availableManifestChannelsForAgent(agent);
  const supportedChannelIds = availableChannels.map((manifest) => manifest.id);

  hydrateAddChannelEnvFromStoredState(sandboxName);

  try {
    const plan = await planner.buildChannelAddPlanFromSandboxEntry({
      sandboxName,
      agent: toMessagingAgentId(agent, messagingManifestRegistry.list()),
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

export async function persistManifestChannelDisabledPlan(
  sandboxName: string,
  channelId: string,
  disabled: boolean,
): Promise<SandboxMessagingPlan | null> {
  const entry = registry.getSandbox(sandboxName);
  if (!entry?.messaging?.plan) return null;
  const agent = resolveAgentForSandbox(sandboxName);
  const agentId = tryGetMessagingAgentId(agent, messagingManifestRegistry.list());
  if (agentId === null) return null;
  const planner = new MessagingWorkflowPlanner(
    messagingManifestRegistry,
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  const context = {
    sandboxName,
    agent: agentId,
    channelId,
    sandboxEntry: entry,
    supportedChannelIds: availableManifestChannelsForAgent(agent).map((manifest) => manifest.id),
  };
  const plan = disabled
    ? await planner.buildChannelStopPlanFromSandboxEntry(context)
    : await planner.buildChannelStartPlanFromSandboxEntry(context);
  if (!plan) return null;
  return MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan) ? plan : null;
}

export async function persistManifestChannelRemovePlan(
  sandboxName: string,
  channelId: string,
): Promise<boolean> {
  const entry = registry.getSandbox(sandboxName);
  if (!entry) return false;
  const agent = resolveAgentForSandbox(sandboxName);
  const agentId = tryGetMessagingAgentId(agent, messagingManifestRegistry.list());
  if (agentId === null) {
    if (entry.messaging?.plan) {
      return registry.updateSandbox(sandboxName, { messaging: undefined });
    }
    return true;
  }
  const planner = new MessagingWorkflowPlanner(
    messagingManifestRegistry,
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  const plan = await planner.buildChannelRemovePlanFromSandboxEntry({
    sandboxName,
    agent: agentId,
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

function hydrateAddChannelEnvFromStoredState(sandboxName: string): void {
  const savedSession = safeLoadOnboardSession();
  hydrateMessagingChannelConfig(getStoredMessagingChannelConfig(sandboxName, savedSession));
}

function discloseChannelPresetScope(
  sandboxName: string,
  presetName: string,
  presetContent: string,
): policies.PresetPolicyState | null {
  const gatewayState = policies.getPresetContentGatewayState(sandboxName, presetContent);
  policies.logPresetScopeForState(presetName, presetContent, gatewayState);
  return gatewayState;
}

function loadValidateAndDiscloseChannelPreset(
  sandboxName: string,
  channelName: string,
  verb: "add" | "start",
): policies.PresetPolicyState | null {
  const presetContent = policies.loadPresetForSandbox(sandboxName, channelName);
  const presetPolicyKeys =
    presetContent === null ? [] : policies.parsePresetPolicyKeys(presetContent);
  if (presetContent === null || presetPolicyKeys.length === 0) {
    if (presetContent === null) {
      console.error(`  Cannot load policy preset for channel '${channelName}'.`);
    } else {
      console.error(
        `  Preset YAML for channel '${channelName}' has no parseable entries under 'network_policies:'.`,
      );
    }
    console.error(
      `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels ${verb} ${channelName}`,
    );
    process.exit(1);
  }
  return discloseChannelPresetScope(sandboxName, channelName, presetContent);
}

function safeLoadOnboardSession(): ReturnType<typeof onboardSession.loadSession> {
  try {
    return onboardSession.loadSession();
  } catch {
    return null;
  }
}

export async function addSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
  dependencies: AddSandboxChannelDependencies = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    addSandboxChannelUnlocked(sandboxName, options, dependencies),
  );
}

async function addSandboxChannelUnlocked(
  sandboxName: string,
  options: ChannelMutationOptions,
  dependencies: AddSandboxChannelDependencies,
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
  if (!channelSupportedByAgent(manifest, agent)) {
    console.error(
      `  Channel '${canonical}' does not support agent '${agent.name}' for sandbox '${sandboxName}'.`,
    );
    console.error(
      `  Channel-supported agents: ${formatSupportedMessagingAgentIds(manifest.supportedAgents)}.`,
    );
    console.error(
      `  Channels supported by agent '${agent.name}': ${formatAvailableChannelsForAgent(agent)}.`,
    );
    process.exit(1);
  }

  // Disclose before credential collection, conflict prompts, or any gateway /
  // registry mutation. The core apply path rechecks immediately before set.
  const disclosedPresetState = loadValidateAndDiscloseChannelPreset(sandboxName, canonical, "add");

  if (dryRun) {
    console.log(`  --dry-run: would enable channel '${canonical}' for '${sandboxName}'.`);
    return;
  }

  const plan = await planSandboxChannelAdd(sandboxName, canonical, agent, dependencies);
  const acquired = collectManifestCredentials(manifest);
  if (!(await checkChannelAddConflict(sandboxName, canonical, acquired, force))) {
    return; // user aborted; nothing registered or widened
  }
  // Credential axis passed; now channel-owned pre-enable hooks can catch
  // channel-specific conflicts before provider/policy mutation.
  if (!(await checkMessagingPreEnableHooks(sandboxName, canonical, plan, force))) {
    return; // user aborted; nothing registered or widened
  }
  assertAddChannelPlanActive(sandboxName, manifest, plan);

  // QR-paired channels that own their session inside the sandbox have no
  // host-side credential to acquire; register the bridge now and let the
  // operator complete pairing after rebuild.
  if (manifest.auth.mode === "in-sandbox-qr") {
    if (
      !applyChannelPresetIfAvailable(sandboxName, canonical, "add", {
        disclosedPresetState,
      })
    ) {
      process.exit(1);
    }
    await applyChannelAddToGatewayAndRegistry(sandboxName, canonical, {});
    if (!MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan)) {
      console.error(`  ${YW}⚠${R} Could not persist messaging plan for '${sandboxName}'.`);
      removeChannelPresetIfPresent(sandboxName, canonical);
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
    if (rebuilt) {
      ensureMessagingHostForwardAfterRebuild(sandboxName, plan);
      await runMessagingHealthChecksAfterRebuild(sandboxName, plan);
    }
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
  // Register providers before credentials or durable channel state are saved.
  // OpenShell requires credential providers to be attached before their policy
  // bindings can be applied, so rollback both effects when policy application fails.
  const registeredBridge = await applyChannelAddToGatewayAndRegistry(
    sandboxName,
    canonical,
    acquired,
    () =>
      applyChannelPresetIfAvailable(sandboxName, canonical, "add", {
        disclosedPresetState,
      }),
  );
  if (registeredBridge === null) {
    await rollbackChannelAdd(sandboxName, channelDef, canonical, {
      wasAlreadyEnabled,
      priorCreds,
    });
    process.exit(1);
  }
  if (registeredBridge) {
    console.log(`  ${G}✓${R} Registered ${canonical} bridge with the OpenShell gateway.`);
  }
  persistChannelTokens(acquired);

  if (!MessagingHostStateApplier.applyPlanToRegistry(sandboxName, plan)) {
    console.error(`  ${YW}⚠${R} Could not persist messaging plan for '${sandboxName}'.`);
    await rollbackChannelAdd(sandboxName, channelDef, canonical, {
      wasAlreadyEnabled,
      priorCreds,
    });
    process.exit(1);
  }

  const rebuilt = await promptAndRebuild(sandboxName, `add '${canonical}'`);
  if (rebuilt) {
    ensureMessagingHostForwardAfterRebuild(sandboxName, plan);
    await runMessagingHealthChecksAfterRebuild(sandboxName, plan);
  }
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
    // The prior bridge secret is env-only and gone — the failed re-add already
    // overwrote the gateway's refresh material, so a restore is impossible.
    if (bridgeProviderNamesForChannel(sandboxName, canonical).length > 0) {
      console.error(
        `  ${YW}⚠${R} The gateway bridge provider keeps the newly configured key material; re-run '${CLI_NAME} ${sandboxName} channels add ${canonical}' to converge.`,
      );
    }
    if (Object.keys(snapshot.priorCreds).length > 0) {
      try {
        const priorTokenDefs = Object.entries(snapshot.priorCreds).map(([envKey, token]) => ({
          name: bridgeProviderName(sandboxName, canonical, envKey),
          envKey,
          token,
          providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        }));
        policyChannelDependencies.upsertMessagingProviders(
          priorTokenDefs,
          getSandboxTargetGatewayName(sandboxName),
          {
            bestEffort: true,
          },
        );
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
  removeChannelPresetIfPresent(sandboxName, canonical);
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

export function applyChannelPresetIfAvailable(
  sandboxName: string,
  channelName: string,
  retryAction: "add" | "start" = "add",
  options: { disclosedPresetState?: policies.PresetPolicyState | null } = {},
): boolean {
  try {
    const applied = Object.prototype.hasOwnProperty.call(options, "disclosedPresetState")
      ? policies.applyPreset(sandboxName, channelName, {
          disclosedPresetState: options.disclosedPresetState,
          includeMessagingCredentialBindings: true,
        })
      : policies.applyPreset(sandboxName, channelName, {
          includeMessagingCredentialBindings: true,
        });
    if (!applied) {
      console.error(
        `  ${YW}⚠${R} Cannot enable channel '${channelName}': policy preset failed to apply.`,
      );
      console.error(
        `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels ${retryAction} ${channelName}`,
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
      `    Restore the preset YAML and re-run: ${CLI_NAME} ${sandboxName} channels ${retryAction} ${channelName}`,
    );
    return false;
  }
}

function getSandboxChannelStatePaths(agent: AgentDefinition, channelName: string): string[] {
  const configDir = agent.configPaths.dir;
  const stateDirs = new Set(agent.stateDirs);
  const paths: string[] = [];
  const isHermesWhatsapp = agent.name === "hermes" && channelName === "whatsapp";
  if (stateDirs.has("platforms")) {
    paths.push(`${configDir}/platforms/${channelName}`);
  }
  if (isHermesWhatsapp && stateDirs.has("profiles")) {
    paths.push(`${configDir}/profiles/dashboard-home/platforms/whatsapp/session`);
  }
  // Retain cleanup for the pre-profile Dashboard home while Hermes startup
  // still treats it as migration input. This prevents legacy credentials from
  // being migrated back into the canonical profile during a later rebuild.
  if (isHermesWhatsapp && stateDirs.has("dashboard-home")) {
    paths.push(`${configDir}/dashboard-home/platforms/whatsapp/session`);
  }
  if (paths.length === 0 && stateDirs.has(channelName)) {
    paths.push(`${configDir}/${channelName}`);
  }
  return paths;
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
// channel's upstream API. Removal marks the channel disabled before this
// policy release, so a later provider failure remains retryable.
export function removeChannelPresetIfPresent(sandboxName: string, channelName: string): boolean {
  const builtinPresets = new Set(policies.listPresets().map((p) => p.name));
  if (!builtinPresets.has(channelName)) {
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
    return true;
  }
  if (!policies.getAppliedPresets(sandboxName).includes(channelName)) {
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
    return true;
  }
  try {
    const removed = policies.removePreset(sandboxName, channelName);
    if (!removed) {
      console.error(`  ${YW}⚠${R} Channel '${channelName}' policy preset failed to un-apply.`);
      console.error(
        `    Run manually after rebuild with: ${CLI_NAME} ${sandboxName} policy remove ${channelName}`,
      );
      return false;
    }
    syncSessionPolicyPresetsWithRegistry(sandboxName, channelName, "remove");
    refreshSandboxPolicyContextFile(sandboxName);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to remove '${channelName}' policy preset: ${msg}`);
    console.error(
      `    Run manually after rebuild with: ${CLI_NAME} ${sandboxName} policy remove ${channelName}`,
    );
    return false;
  }
}

export async function removeSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    removeSandboxChannelUnlocked(sandboxName, options),
  );
}

async function removeSandboxChannelUnlocked(
  sandboxName: string,
  options: ChannelMutationOptions,
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

  // The public Google Chat endpoint must stop before credentials, providers,
  // policy, or durable plan state change. Otherwise a partial teardown leaves
  // a live webhook with no retryable channel record. Attempt this even when
  // registry residue is absent so `channels remove` can recover an orphaned
  // endpoint from an earlier interrupted cleanup.
  if (canonical === "googlechat") {
    try {
      policyChannelDependencies.stopGooglechatWebhookTunnel(sandboxName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${YW}⚠${R} Could not stop the Google Chat webhook tunnel: ${message}`);
      console.error(
        `  No channel configuration or credentials were changed; fix the tunnel teardown and re-run: ${CLI_NAME} ${sandboxName} channels remove ${canonical}`,
      );
      process.exit(1);
    }
  }

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

  const configuredChannels = registry.getConfiguredMessagingChannelsFromEntry(registryEntry);
  if (
    registryEntry?.messaging?.plan &&
    configuredChannels.includes(canonical) &&
    !registry.getDisabledChannels(sandboxName).includes(canonical)
  ) {
    const disabledPlan = await persistManifestChannelDisabledPlan(sandboxName, canonical, true);
    if (!disabledPlan) {
      console.error(`  Could not mark '${canonical}' disabled before removing it.`);
      process.exit(1);
    }
  }

  if (!removeChannelPresetIfPresent(sandboxName, canonical)) {
    console.error(
      `  ${YW}⚠${R} Channel '${canonical}' remains disabled while policy cleanup is incomplete.`,
    );
    console.error(
      `  Resolve the policy error, then re-run: ${CLI_NAME} ${sandboxName} channels remove ${canonical}`,
    );
    process.exit(1);
  }
  const teardown = await applyChannelRemoveToGatewayAndRegistry(sandboxName, canonical, tokenKeys, {
    bestEffort: true,
  });
  if (!teardown.ok) {
    console.error(
      `  ${YW}⚠${R} Channel '${canonical}' remains disabled while ${teardown.residual.join(", ")} cleanup is incomplete.`,
    );
    console.error(
      `  Resolve the gateway error, then re-run: ${CLI_NAME} ${sandboxName} channels remove ${canonical}`,
    );
    process.exit(1);
  }
  clearChannelTokens(channel);
  if (tokenKeys.length > 0) {
    console.log(`  ${G}✓${R} Removed ${canonical} bridge from the OpenShell gateway.`);
  } else {
    console.log(`  ${G}✓${R} Removed ${canonical} channel.`);
  }

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

  const manifest = resolveChannelManifest(channelArg);
  if (!manifest) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownManifestChannelNames().join(", ")}`);
    process.exit(1);
  }

  const registryEntry = registry.getSandbox(sandboxName);
  if (!registryEntry) {
    console.error(`  Sandbox '${sandboxName}' not found in the registry.`);
    process.exit(1);
  }

  const canonical = manifest.id;
  const agent = resolveAgentForSandbox(sandboxName);
  const availableChannels = availableManifestChannelsForAgent(agent);
  if (!availableChannels.some((candidate) => candidate.id === canonical)) {
    console.error(
      `  Channel '${canonical}' does not support agent '${agent.name}' for sandbox '${sandboxName}'.`,
    );
    console.error(
      `  Channel-supported agents: ${formatSupportedMessagingAgentIds(manifest.supportedAgents)}.`,
    );
    console.error(
      `  Channels supported by agent '${agent.name}': ${formatAvailableChannelsForAgent(agent)}.`,
    );
    process.exit(1);
  }

  const configuredChannels = registry.getConfiguredMessagingChannelsFromEntry(registryEntry);
  if (!configuredChannels.includes(canonical)) {
    console.error(`  Channel '${canonical}' is not configured for '${sandboxName}'.`);
    process.exit(1);
  }
  const alreadyDisabled = registry.getDisabledChannels(sandboxName).includes(canonical);
  if (alreadyDisabled === disabled) {
    console.log(
      `  Channel '${canonical}' is already ${disabled ? "disabled" : "enabled"} for '${sandboxName}'. Nothing to do.`,
    );
    return;
  }

  if (!disabled) {
    loadValidateAndDiscloseChannelPreset(sandboxName, canonical, "start");
  }

  if (dryRun) {
    console.log(`  --dry-run: would ${verb} channel '${canonical}' for '${sandboxName}'.`);
    return;
  }

  const plan = await persistManifestChannelDisabledPlan(sandboxName, canonical, disabled);
  if (!plan) {
    console.error(`  Could not persist messaging plan for '${sandboxName}'.`);
    process.exit(1);
  }
  // A rebuild that disabled every channel can leave its providers on the
  // gateway but detached from the current sandbox. The enabled plan carries
  // the preset into rebuild, where sandbox creation attaches each provider
  // before OpenShell accepts its credential-bound policy.
  const state = disabled ? "disabled" : "enabled";
  console.log(`  ${G}✓${R} Marked ${canonical} ${state} for '${sandboxName}'.`);
  const rebuilt = await promptAndRebuild(sandboxName, `${verb} '${canonical}'`);
  if (rebuilt && !disabled) {
    ensureMessagingHostForwardAfterRebuild(sandboxName, plan);
  }
}

export async function stopSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  await withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    sandboxChannelsSetEnabled(sandboxName, options, true),
  );
}

export async function startSandboxChannel(
  sandboxName: string,
  options: ChannelMutationOptions = {},
): Promise<void> {
  await withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    sandboxChannelsSetEnabled(sandboxName, options, false),
  );
}

export async function removeSandboxPolicy(
  sandboxName: string,
  options: PolicyRemoveOptions = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    removeSandboxPolicyUnlocked(sandboxName, options),
  );
}

async function removeSandboxPolicyUnlocked(
  sandboxName: string,
  options: PolicyRemoveOptions,
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const skipConfirm = Boolean(options.yes || options.force || isNonInteractive());

  // Remove-able presets = built-in presets + custom presets applied via
  // --from-file / --from-dir (tracked in registry.customPolicies).
  const builtinPresets = policies.listPresets();
  const customPresets = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtinPresets, ...customPresets];
  // `policy list` reports a preset as active when either the registry or the
  // gateway holds it, so removal has to accept the same set. A preset the
  // gateway enforces but the registry never recorded is exactly the state
  // `policy list` flags as "active on gateway, missing from local state", and
  // removePreset() reconciles it without needing the registry entry. Null means
  // the gateway could not be queried, which is not evidence of absence. (#9295)
  const applied = policies.getAppliedPresets(sandboxName);
  const gatewayPresets = policies.getGatewayPresets(sandboxName);
  const removable = gatewayPresets ? [...new Set([...applied, ...gatewayPresets])] : applied;

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
    if (!removable.includes(preset.name)) {
      console.error(`  Preset '${preset.name}' is not applied.`);
      if (gatewayPresets === null) {
        console.error("  Could not query the gateway, so only local state was checked.");
      }
      process.exit(1);
    }
    answer = preset.name;
  } else {
    const usage = `${CLI_NAME} <sandbox> policy remove <preset> [--yes] [--dry-run]`;
    if (isNonInteractiveEnv()) {
      exitPresetNameRequired(usage);
    }
    if (isNonInteractive()) {
      exitPromptStdinClosed(usage);
    }
    answer = await pickPresetOrExit(
      () => policies.selectForRemoval(allPresets, { applied: removable }),
      usage,
    );
  }
  if (!answer) return;

  // Resolve preset content: built-in first, then custom (persisted in
  // registry). Needed only for the endpoint preview below — removePreset()
  // itself re-resolves on the library side.
  let presetContent: string | null = policies.loadPresetForSandbox(sandboxName, answer);
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

function printBaselineEntryScope(prefix: string, key: string, entry: PolicyObject): void {
  console.log(prefix);
  for (const line of renderBaselineEntryScope(key, entry)) {
    console.log(line);
  }
}

export async function excludeSandboxBaseline(
  sandboxName: string,
  options: PolicyBaselineOptions = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    excludeSandboxBaselineUnlocked(sandboxName, options),
  );
}

async function excludeSandboxBaselineUnlocked(
  sandboxName: string,
  options: PolicyBaselineOptions,
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const explicitAck = Boolean(options.yes || options.force);
  const key = options.key?.trim();
  if (!key) {
    console.error("  A baseline key is required.");
    console.error(`  Usage: ${CLI_NAME} <sandbox> policy exclude <key> [--force] [--dry-run]`);
    process.exit(1);
  }

  const baseline = policies.resolveSandboxBaselinePolicy(sandboxName);
  if (!baseline) {
    console.error(`  Could not read the baseline policy for sandbox '${sandboxName}'.`);
    process.exit(1);
  }

  const entry = policies.getSandboxBaselineEntry(sandboxName, key);
  if (!entry) {
    console.error(`  Unknown baseline entry '${key}'.`);
    console.error(
      `  Valid baseline keys: ${listBaselineEntryKeys(baseline.content).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  if (isProtectedBaselineExclusionKey(key)) {
    console.error(
      `  Baseline entry '${key}' is required for managed inference and cannot be excluded.`,
    );
    process.exit(1);
  }

  const featureImpact = getBaselineExclusionFeatureImpact(baseline.agent, key);
  if (!featureImpact) {
    console.error(
      `  Baseline entry '${key}' has no supported-feature impact disclosure and cannot be excluded safely.`,
    );
    process.exit(1);
  }

  printBaselineEntryScope(
    `  Excluding baseline entry '${key}' from '${sandboxName}' removes:`,
    key,
    entry,
  );
  console.log(`  ${YW}Support impact: ${featureImpact}${R}`);

  const digest = digestBaselineEntry(entry);
  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (isNonInteractive() && !explicitAck) {
    console.error(
      "  Non-interactive exclusion requires explicit acknowledgement: pass --force (or --yes).",
    );
    process.exit(1);
  }
  if (!explicitAck) {
    const confirm = await askPrompt(`  Exclude '${key}' from sandbox '${sandboxName}'? [y/N]: `);
    if (!confirm.trim().toLowerCase().startsWith("y")) return;
  }

  if (!policies.excludeBaselineEntry(sandboxName, key, digest)) {
    // A failed cross-system mutation can leave a durable repair journal. Keep
    // the in-sandbox context aligned before returning the nonzero result.
    refreshSandboxPolicyContextFile(sandboxName);
    process.exit(1);
  }
  console.log(`  ${G}✓${R} Excluded baseline entry '${key}' for '${sandboxName}'.`);
  refreshSandboxPolicyContextFile(sandboxName);
}

export async function restoreSandboxBaseline(
  sandboxName: string,
  options: PolicyBaselineOptions = {},
): Promise<void> {
  return withSandboxMutationLockUnlessPreview(sandboxName, options.dryRun, () =>
    restoreSandboxBaselineUnlocked(sandboxName, options),
  );
}

async function restoreSandboxBaselineUnlocked(
  sandboxName: string,
  options: PolicyBaselineOptions,
): Promise<void> {
  const dryRun = Boolean(options.dryRun);
  const explicitAck = Boolean(options.yes || options.force);
  const key = options.key?.trim();
  const usage = `  Usage: ${CLI_NAME} <sandbox> policy restore <key> [--yes|-y] [--force] [--dry-run]`;
  if (!key) {
    console.error("  A baseline key is required.");
    console.error(usage);
    process.exit(1);
  }

  const isExcluded = registry.getBaselineExclusions(sandboxName).some((entry) => entry.key === key);
  const pendingTransition = registry.getBaselineExclusionTransition(sandboxName);
  const isPendingForKey = pendingTransition?.exclusion.key === key;
  if (!isExcluded && !isPendingForKey) {
    console.error(`  Baseline entry '${key}' is not excluded for '${sandboxName}'.`);
    process.exit(1);
  }

  const baseline = policies.resolveSandboxBaselinePolicy(sandboxName);
  if (!baseline) {
    console.error(`  Could not read the baseline policy for sandbox '${sandboxName}'.`);
    process.exit(1);
  }

  const entry = policies.getSandboxBaselineEntry(sandboxName, key);
  const expectedTargetDigest = entry ? digestBaselineEntry(entry) : null;
  if (entry) {
    printBaselineEntryScope(
      `  Restoring baseline entry '${key}' for '${sandboxName}' re-allows:`,
      key,
      entry,
    );
  } else {
    console.log(
      `  ${YW}⚠${R} The current baseline no longer defines '${key}'; clearing the exclusion record only.`,
    );
  }

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (isNonInteractive() && !explicitAck) {
    console.error(
      "  Non-interactive restore requires explicit acknowledgement: pass --force (or --yes).",
    );
    console.error(usage);
    process.exit(1);
  }
  if (!explicitAck) {
    let confirm: string;
    try {
      confirm = await askPrompt(`  Restore '${key}' for sandbox '${sandboxName}'? [y/N]: `);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EOF") throw error;
      console.error("  No input available on stdin, so policy restore cannot prompt.");
      console.error(usage);
      process.exit(1);
    }
    if (!confirm.trim().toLowerCase().startsWith("y")) {
      console.log("  Cancelled.");
      return;
    }
  }

  if (!policies.restoreBaselineEntry(sandboxName, key, { expectedTargetDigest })) {
    refreshSandboxPolicyContextFile(sandboxName);
    process.exit(1);
  }
  console.log(`  ${G}✓${R} Restored baseline entry '${key}' for '${sandboxName}'.`);
  refreshSandboxPolicyContextFile(sandboxName);
}
