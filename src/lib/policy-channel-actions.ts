// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess policy/channel tests. */

import fs from "node:fs";
import path from "node:path";

import { CLI_DISPLAY_NAME, CLI_NAME } from "./branding";
import { hashCredential } from "./credential-hash";
import { getCredential, prompt as askPrompt } from "./credentials";
import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";
const { isNonInteractive } = require("./onboard") as { isNonInteractive: () => boolean };
const onboardProviders = require("./onboard-providers");
import * as policies from "./policies";
import * as registry from "./registry";
import { runOpenshell } from "./openshell-runtime";
import { rebuildSandbox } from "./sandbox-runtime-actions";
import {
  KNOWN_CHANNELS,
  clearChannelTokens,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  persistChannelTokens,
} from "./sandbox-channels";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const D = useColor ? "\x1b[2m" : "";
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
export async function addSandboxPolicy(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") ||
    args.includes("-y") ||
    args.includes("--force") ||
    process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  const fromFileIdx = args.indexOf("--from-file");
  const fromDirIdx = args.indexOf("--from-dir");

  if (fromFileIdx >= 0 && fromDirIdx >= 0) {
    console.error("  --from-file and --from-dir are mutually exclusive.");
    process.exit(1);
  }

  if (fromFileIdx >= 0) {
    const filePath = args[fromFileIdx + 1];
    if (!filePath || filePath.startsWith("--")) {
      console.error("  --from-file requires a path argument.");
      process.exit(1);
    }
    const ok = await applyExternalPreset(sandboxName, filePath, { dryRun, yes: skipConfirm });
    if (!ok) process.exit(1);
    return;
  }

  if (fromDirIdx >= 0) {
    const dirPath = args[fromDirIdx + 1];
    if (!dirPath || dirPath.startsWith("--")) {
      console.error("  --from-dir requires a directory path.");
      process.exit(1);
    }
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

  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
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

  if (dryRun) {
    console.log("  --dry-run: no changes applied.");
    return;
  }

  if (!skipConfirm) {
    const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
    if (confirm.trim().toLowerCase().startsWith("n")) return;
  }

  policies.applyPreset(sandboxName, answer);
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
    console.log("  ⚠ Could not query gateway — showing local state only.");
  }
  console.log("");
}

// ── Messaging channels ───────────────────────────────────────────

export function listSandboxChannels(sandboxName: string) {
  console.log("");
  console.log(`  Known messaging channels for sandbox '${sandboxName}':`);
  for (const [name, channel] of Object.entries(KNOWN_CHANNELS)) {
    console.log(`    ${name} — ${channel.description}`);
  }
  console.log("");
}

// Map a channel + token-env-key to the OpenShell provider name onboarding
// uses for it. Mirrors the names in src/lib/onboard.ts:3201-3221 so a
// channels-add upsert collides with (i.e. updates) the same provider that
// a later rebuild would have created from scratch.
function bridgeProviderName(sandboxName: string, channelName: string, envKey: string): string {
  if (channelName === "slack" && envKey === "SLACK_APP_TOKEN") {
    return `${sandboxName}-slack-app`;
  }
  return `${sandboxName}-${channelName}-bridge`;
}

// Push channel tokens to the OpenShell gateway and add the channel to the
// sandbox registry's messagingChannels list. Done eagerly at `channels
// add` time (not deferred to rebuild) because the host-side credential
// helpers are env-only after the fix — without an immediate gateway
// upsert plus registry update, a "rebuild later" answer would drop the
// queued change since process.env disappears when the CLI exits.
async function applyChannelAddToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  acquired: Record<string, string>,
): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (!recovery.recovered) {
    console.error(
      `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway. Tokens were staged`,
    );
    console.error("  in env for this run only — re-run after starting the gateway, or run");
    console.error("  'openshell gateway start --name nemoclaw' manually.");
    process.exit(1);
  }
  const tokenDefs = Object.entries(acquired).map(([envKey, token]) => ({
    name: bridgeProviderName(sandboxName, channelName, envKey),
    envKey,
    token,
  }));
  // upsertMessagingProviders handles create-or-update and process.exits on
  // failure, so reaching the next line means every entry is registered.
  onboardProviders.upsertMessagingProviders(tokenDefs, runOpenshell);

  // Persist the enabled-channels list in the registry so a deferred
  // `nemoclaw <sandbox> rebuild` knows the channel set without needing
  // tokens on disk.
  const entry = registry.getSandbox(sandboxName);
  if (entry) {
    const enabled = new Set(entry.messagingChannels || []);
    enabled.add(channelName);
    const disabled = (entry.disabledChannels || []).filter((c: string) => c !== channelName);
    const providerCredentialHashes = { ...(entry.providerCredentialHashes || {}) };
    for (const [envKey, token] of Object.entries(acquired)) {
      const hash = hashCredential(token);
      if (hash) providerCredentialHashes[envKey] = hash;
    }
    registry.updateSandbox(sandboxName, {
      messagingChannels: Array.from(enabled).sort(),
      disabledChannels: disabled,
      providerCredentialHashes:
        Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    });
  }
}

// Remove a channel's bridge providers from the gateway and drop it from the
// registry's messagingChannels list. Mirrors applyChannelAddToGatewayAndRegistry.
async function applyChannelRemoveToGatewayAndRegistry(
  sandboxName: string,
  channelName: string,
  channelTokenKeys: string[],
): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (!recovery.recovered) {
    console.error(
      `  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway to delete the bridge.`,
    );
    console.error(
      "  Re-run after starting the gateway, or run 'openshell gateway start --name nemoclaw'.",
    );
    process.exit(1);
  }
  // Capture each delete's outcome. If any non-NotFound failure surfaces
  // we must NOT update the registry — otherwise NemoClaw would record
  // the channel as removed locally while the bridge is still live in
  // the gateway, which produces a half-configured sandbox the user
  // can't easily recover.
  const failed: string[] = [];
  for (const envKey of channelTokenKeys) {
    const name = bridgeProviderName(sandboxName, channelName, envKey);
    const result = runOpenshell(["provider", "delete", name], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      // Treat "not found" as success-equivalent — a previous run may
      // have already deleted the provider.
      if (!/\bNotFound\b|not found/i.test(output)) {
        failed.push(name);
      }
    }
  }
  if (failed.length > 0) {
    console.error(
      `  Failed to delete bridge provider(s) from the OpenShell gateway: ${failed.join(", ")}.`,
    );
    console.error("  Registry not updated; re-run after resolving the gateway error.");
    process.exit(1);
  }

  const entry = registry.getSandbox(sandboxName);
  if (entry) {
    const enabled = (entry.messagingChannels || []).filter((c: string) => c !== channelName);
    const providerCredentialHashes = { ...(entry.providerCredentialHashes || {}) };
    for (const envKey of channelTokenKeys) {
      delete providerCredentialHashes[envKey];
    }
    registry.updateSandbox(sandboxName, {
      messagingChannels: enabled,
      providerCredentialHashes:
        Object.keys(providerCredentialHashes).length > 0 ? providerCredentialHashes : undefined,
    });
  }
}

async function promptAndRebuild(sandboxName: string, actionDesc: string): Promise<void> {
  if (isNonInteractive()) {
    console.log("");
    console.log(
      `  Change queued. Run '${CLI_NAME} ${sandboxName} rebuild' to apply (${actionDesc}).`,
    );
    return;
  }
  const answer = (await askPrompt(`  Rebuild '${sandboxName}' now to apply? [Y/n]: `))
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") {
    console.log(
      `  Run '${CLI_NAME} ${sandboxName} rebuild' when you are ready to apply (${actionDesc}).`,
    );
    return;
  }
  await rebuildSandbox(sandboxName, ["--yes"]);
}

export async function addSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
  if (!channelArg) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> channels add <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`  --dry-run: would enable channel '${channelArg}' for '${sandboxName}'.`);
    return;
  }

  const tokenKeys = getChannelTokenKeys(channel);
  const acquired: Record<string, string> = {};
  for (const envKey of tokenKeys) {
    const isPrimary = envKey === channel.envKey;
    const help = isPrimary ? channel.help : channel.appTokenHelp;
    const label = isPrimary ? channel.label : channel.appTokenLabel;
    const existing = getCredential(envKey);
    if (existing) {
      acquired[envKey] = existing;
      continue;
    }
    if (isNonInteractive()) {
      console.error(`  Missing ${envKey} for channel '${channelArg}'.`);
      console.error(
        `  Set ${envKey} in the environment or via '${CLI_NAME} credentials' before running in non-interactive mode.`,
      );
      process.exit(1);
    }
    console.log("");
    console.log(`  ${help}`);
    const token = (await askPrompt(`  ${label}: `, { secret: true })).trim();
    if (!token) {
      console.error(`  Aborted — no value entered for ${envKey}.`);
      process.exit(1);
    }
    acquired[envKey] = token;
  }

  persistChannelTokens(acquired);
  // Push to the gateway and update the registry NOW so that answering
  // "rebuild later" (or running non-interactively) does not silently
  // discard the change. Pre-fix this was safe because saveCredential()
  // wrote credentials.json; with env-only persistence, exiting before
  // the rebuild used to drop the queued token.
  await applyChannelAddToGatewayAndRegistry(sandboxName, channelArg, acquired);
  console.log(`  ${G}✓${R} Registered ${channelArg} bridge with the OpenShell gateway.`);
  await promptAndRebuild(sandboxName, `add '${channelArg}'`);
}

export async function removeSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
  if (!channelArg) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> channels remove <channel> [--dry-run]`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  const channel = getChannelDef(channelArg);
  if (!channel) {
    console.error(`  Unknown channel '${channelArg}'.`);
    console.error(`  Valid channels: ${knownChannelNames().join(", ")}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`  --dry-run: would remove channel '${channelArg}' for '${sandboxName}'.`);
    return;
  }

  clearChannelTokens(channel);
  // Same rationale as channels-add: tear down the gateway providers and
  // drop the channel from the registry NOW so a deferred rebuild does
  // not leave a stale bridge running against a token NemoClaw has
  // already "removed" from the user's perspective.
  await applyChannelRemoveToGatewayAndRegistry(
    sandboxName,
    channelArg,
    getChannelTokenKeys(channel),
  );
  console.log(`  ${G}✓${R} Removed ${channelArg} bridge from the OpenShell gateway.`);
  await promptAndRebuild(sandboxName, `remove '${channelArg}'`);
}

async function sandboxChannelsSetEnabled(
  sandboxName: string,
  args: string[],
  disabled: boolean,
): Promise<void> {
  const verb = disabled ? "stop" : "start";
  const dryRun = args.includes("--dry-run");
  const channelArg = args.find((arg) => !arg.startsWith("-"));
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

  const normalized = channelArg.trim().toLowerCase();
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

  if (!registry.setChannelDisabled(sandboxName, normalized, disabled)) {
    console.error(`  Sandbox '${sandboxName}' not found in the registry.`);
    process.exit(1);
  }
  const state = disabled ? "disabled" : "enabled";
  console.log(`  ${G}✓${R} Marked ${normalized} ${state} for '${sandboxName}'.`);
  await promptAndRebuild(sandboxName, `${verb} '${normalized}'`);
}

export async function stopSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, args, true);
}

export async function startSandboxChannel(sandboxName: string, args: string[] = []): Promise<void> {
  await sandboxChannelsSetEnabled(sandboxName, args, false);
}


export async function removeSandboxPolicy(sandboxName: string, args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm =
    args.includes("--yes") ||
    args.includes("-y") ||
    args.includes("--force") ||
    process.env.NEMOCLAW_NON_INTERACTIVE === "1";

  // Remove-able presets = built-in presets + custom presets applied via
  // --from-file / --from-dir (tracked in registry.customPolicies).
  const builtinPresets = policies.listPresets();
  const customPresets = policies.listCustomPresets(sandboxName);
  const allPresets = [...builtinPresets, ...customPresets];
  const applied = policies.getAppliedPresets(sandboxName);

  const presetArg = args.find((arg) => !arg.startsWith("-"));
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
}
