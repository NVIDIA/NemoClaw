// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess snapshot tests. */

import fs from "node:fs";
import path from "node:path";

import { CLI_NAME } from "./branding";
import { dockerCapture, dockerInspect } from "./docker";
import { parseLiveSandboxNames } from "./runtime-recovery";
import { ROOT, run, shellQuote, validateName } from "./runner";
import { captureOpenshell, getOpenshellBinary } from "./openshell-runtime";
import * as policies from "./policies";
import * as registry from "./registry";
import type { SandboxEntry } from "./registry";
import * as sandboxState from "./sandbox-state";

const { parseRestoreArgs } = sandboxState;

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = useColor ? "\x1b[1m" : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

function parseSnapshotCreateFlags(flags: string[]) {
  const opts: { name: string | null } = { name: null };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--name") {
      if (i + 1 >= flags.length || flags[i + 1].startsWith("--")) {
        console.error("  --name requires a value");
        process.exit(1);
      }
      opts.name = flags[++i];
    } else {
      console.error(`  Unknown flag: ${flag}`);
      process.exit(1);
    }
  }
  return opts;
}

function formatSnapshotVersion(b: unknown) {
  const snapshotVersion = (b as { snapshotVersion?: number }).snapshotVersion ?? 0;
  return `v${snapshotVersion}`;
}

function renderSnapshotTable(
  backups: Array<{
    snapshotVersion: number;
    name?: string | null;
    timestamp: string;
    backupPath: string;
  }>,
) {
  const rows = backups.map((b) => ({
    version: formatSnapshotVersion(b),
    name: b.name || "",
    timestamp: b.timestamp,
    backupPath: b.backupPath,
  }));
  const widths = {
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    timestamp: Math.max(9, ...rows.map((r) => r.timestamp.length)),
    backupPath: Math.max(4, ...rows.map((r) => r.backupPath.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  console.log(
    `    ${B}${pad("Version", widths.version)}  ${pad("Name", widths.name)}  ${pad("Timestamp", widths.timestamp)}  ${pad("Path", widths.backupPath)}${R}`,
  );
  for (const r of rows) {
    console.log(
      `    ${pad(r.version, widths.version)}  ${pad(r.name, widths.name)}  ${pad(r.timestamp, widths.timestamp)}  ${D}${pad(r.backupPath, widths.backupPath)}${R}`,
    );
  }
}

// Query the running src pod's image reference via `kubectl` inside the
// gateway container. Returns null on any failure.
function resolveSrcPodImage(srcName: string): string | null {
  const gatewayContainer = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  try {
    const output = dockerCapture(
      [
        "exec",
        gatewayContainer,
        "kubectl",
        "get",
        "pod",
        srcName,
        "-n",
        "openshell",
        "-o",
        'jsonpath={.spec.containers[?(@.name=="agent")].image}',
      ],
      { ignoreError: true, timeout: 10000 },
    );
    const img = output.trim().split(/\s+/)[0];
    return img || null;
  } catch {
    return null;
  }
}

// Auto-create a sandbox that clones the image of an existing one.
// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Returns true on success; on failure, logs and calls process.exit(1).
async function autoCreateSandboxFromSource(
  srcName: string,
  dstName: string,
  srcEntry: SandboxEntry | { name: string },
): Promise<void> {
  const sandboxCreateStream = require("./lib/sandbox-create-stream");
  const { isSandboxReady } = require("./lib/gateway-state");
  const basePolicy = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const openshellBin = getOpenshellBinary();

  const fromImage = resolveSrcPodImage(srcName);
  if (!fromImage) {
    console.error(`  Cannot auto-create '${dstName}': could not resolve '${srcName}' pod image.`);
    console.error(`  Create '${dstName}' manually with '${CLI_NAME} onboard'.`);
    process.exit(1);
  }

  const cmdParts = [
    openshellBin,
    "sandbox",
    "create",
    "--name",
    dstName,
    "--from",
    fromImage,
    "--policy",
    basePolicy,
    "--auto-providers",
    "--",
    "nemoclaw-start",
  ].map((p) => shellQuote(p));
  const command = `${cmdParts.join(" ")} 2>&1`;

  console.log(`  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`);

  const createResult = await sandboxCreateStream.streamSandboxCreate(command, process.env, {
    // Use a pre-built image, so skip build+push and jump to pod creation.
    initialPhase: "create",
    // Wait until the sandbox actually reaches Ready state, not just appears in the list.
    readyCheck: () => {
      const list = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (list.status !== 0) return false;
      return isSandboxReady(list.output || "", dstName);
    },
  });

  if (createResult.status !== 0 && !createResult.forcedReady) {
    console.error(`  Failed to create sandbox '${dstName}' (exit ${createResult.status}).`);
    const tail = (createResult.output || "").slice(-600);
    if (tail) console.error(tail);
    process.exit(1);
  }

  // Double-check Ready after stream exit.
  const verify = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (verify.status !== 0 || !isSandboxReady(verify.output || "", dstName)) {
    console.error(`  Sandbox '${dstName}' did not reach Ready state after create.`);
    process.exit(1);
  }

  // Set up DNS proxy in the new pod (same step onboard runs after sandbox create).
  const dnsScript = path.join(ROOT, "scripts", "setup-dns-proxy.sh");
  if (fs.existsSync(dnsScript)) {
    run(["bash", dnsScript, NEMOCLAW_GATEWAY_NAME, dstName], { ignoreError: true });
  }

  // Register dst in the NemoClaw registry, cloning most fields from src.
  // Policies are cleared here — the caller replays them from the snapshot
  // manifest after the restore succeeds and writes them back into this entry.
  registry.registerSandbox({
    ...srcEntry,
    name: dstName,
    createdAt: new Date().toISOString(),
    policies: [],
    // dst has its own lifecycle; don't inherit src's local NIM container
    // reference, or destroying dst would stop src's NIM.
    nimContainer: null,
  });

  console.log(`  ${G}\u2713${R} Sandbox '${dstName}' created`);
}

// Returns true only when the gateway Docker container is confirmed running.
// `openshell sandbox list` reads a local registry and exits 0 even when the
// gateway is stopped (#2673), so we probe the container directly instead.
function probeGatewayRunning(): boolean {
  const container = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  const result = dockerInspect(
    ["--type", "container", "--format", "{{.State.Running}}", container],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

export async function runSandboxSnapshot(sandboxName: string, subArgs: string[]) {
  const subcommand = subArgs[0] || "help";
  switch (subcommand) {
    case "create": {
      const opts = parseSnapshotCreateFlags(subArgs.slice(1));
      if (!probeGatewayRunning()) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      if (!liveNames.has(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' is not running. Cannot create snapshot.`);
        process.exit(1);
      }
      const label = opts.name ? ` (--name ${opts.name})` : "";
      console.log(`  Creating snapshot of '${sandboxName}'${label}...`);
      const result = sandboxState.backupSandboxState(sandboxName, { name: opts.name });
      if (result.success) {
        // Virtual snapshotVersion is only assigned by listBackups, so re-resolve
        // the just-created snapshot by its timestamp to get a valid v<N>.
        const manifest = result.manifest!;
        const entry = sandboxState.findBackup(sandboxName, manifest.timestamp).match ?? manifest;
        const v = formatSnapshotVersion(entry);
        const nameSuffix = entry.name ? ` name=${entry.name}` : "";
        const itemSummary = `${result.backedUpDirs.length} directories, ${result.backedUpFiles.length} files`;
        console.log(
          `  ${G}\u2713${R} Snapshot ${v}${nameSuffix} created (${itemSummary})`,
        );
        console.log(`    ${manifest.backupPath}`);
      } else {
        if (result.error) {
          console.error(`  ${result.error}`);
        } else {
          console.error("  Snapshot failed.");
          if (result.failedDirs.length > 0) {
            console.error(`  Failed directories: ${result.failedDirs.join(", ")}`);
          }
          if (result.failedFiles.length > 0) {
            console.error(`  Failed files: ${result.failedFiles.join(", ")}`);
          }
        }
        process.exit(1);
      }
      break;
    }
    case "list": {
      const backups = sandboxState.listBackups(sandboxName);
      if (backups.length === 0) {
        console.log(`  No snapshots found for '${sandboxName}'.`);
        return;
      }
      console.log(`  Snapshots for '${sandboxName}':`);
      console.log("");
      renderSnapshotTable(backups);
      console.log("");
      console.log(`  ${backups.length} snapshot(s). Restore with:`);
      console.log(`    ${CLI_NAME} ${sandboxName} snapshot restore [version|name|timestamp]`);
      break;
    }
    case "restore": {
      // `--to <dst>` restores the snapshot from sandboxName into a different
      // sandbox. If `dst` is not yet live, it is auto-created by cloning the
      // source sandbox's baked image. Without `--to`, restore targets
      // sandboxName itself
      const parsed = parseRestoreArgs(sandboxName, subArgs);
      if (!parsed.ok) {
        console.error(`  ${parsed.error}`);
        process.exit(1);
      }
      const targetSandbox =
        parsed.targetSandbox === sandboxName
          ? sandboxName
          : validateName(parsed.targetSandbox, "target sandbox name");
      if (!probeGatewayRunning()) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        process.exit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      if (!liveNames.has(targetSandbox)) {
        // Self-restore: cannot auto-create, there is no source to clone from.
        if (targetSandbox === sandboxName) {
          console.error(`  Sandbox '${targetSandbox}' is not running. Cannot restore snapshot.`);
          process.exit(1);
        }
        // Cross-sandbox restore into a sandbox that doesn't exist yet:
        // auto-create it by cloning the source's running pod image. The
        // source must exist so we can probe its image via kubectl; the
        // registry entry is used to seed dst's agent/model/provider fields.
        if (!liveNames.has(sandboxName)) {
          console.error(
            `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' not found.`,
          );
          console.error(`  Create '${targetSandbox}' manually with '${CLI_NAME} onboard'.`);
          process.exit(1);
        }
        const srcEntry = registry.getSandbox(sandboxName) || { name: sandboxName };
        await autoCreateSandboxFromSource(sandboxName, targetSandbox, srcEntry);
      }
      const selector = parsed.selector;
      let backupPath;
      let resolvedSnapshot = null;
      if (selector) {
        const { match } = sandboxState.findBackup(sandboxName, selector);
        if (!match) {
          console.error(`  No snapshot matching '${selector}' found for '${sandboxName}'.`);
          console.error("  Selector must be an exact version (v<N>), name, or timestamp.");
          console.error(`  Run: ${CLI_NAME} ${sandboxName} snapshot list`);
          process.exit(1);
        }
        backupPath = match.backupPath;
        resolvedSnapshot = match;
        const v = formatSnapshotVersion(match);
        const nameSuffix = match.name ? ` name=${match.name}` : "";
        console.log(`  Using snapshot ${v}${nameSuffix} (${match.timestamp})`);
      } else {
        const latest = sandboxState.getLatestBackup(sandboxName);
        if (!latest) {
          console.error(`  No snapshots found for '${sandboxName}'.`);
          process.exit(1);
        }
        backupPath = latest.backupPath;
        resolvedSnapshot = latest;
        const v = formatSnapshotVersion(latest);
        const nameSuffix = latest.name ? ` name=${latest.name}` : "";
        console.log(`  Using latest snapshot ${v}${nameSuffix} (${latest.timestamp})`);
      }
      if (targetSandbox !== sandboxName) {
        console.log(`  Restoring snapshot from '${sandboxName}' into '${targetSandbox}'...`);
      } else {
        console.log(`  Restoring snapshot into '${sandboxName}'...`);
      }
      const result = sandboxState.restoreSandboxState(targetSandbox, backupPath);
      if (result.success) {
        console.log(
          `  ${G}\u2713${R} Restored ${result.restoredDirs.length} directories, ${result.restoredFiles.length} files`,
        );
      } else {
        console.error(`  Restore failed.`);
        if (result.restoredDirs.length > 0) {
          console.error(`  Partial: ${result.restoredDirs.join(", ")}`);
        }
        if (result.failedDirs.length > 0) {
          console.error(`  Failed: ${result.failedDirs.join(", ")}`);
        }
        if (result.failedFiles.length > 0) {
          console.error(`  Failed files: ${result.failedFiles.join(", ")}`);
        }
        process.exit(1);
      }
      // Reconcile the target's policy presets to match the snapshot manifest
      // exactly — add anything the snapshot recorded but the target is
      // missing, and remove anything the target has that the snapshot did
      // not. This mirrors how stateDirs are restored (full replacement, not
      // additive) so the command's semantics are consistent.
      //
      // When the snapshot predates the `policyPresets` field (undefined),
      // skip the reconcile entirely — we have no recorded state to match.
      if (resolvedSnapshot && Array.isArray(resolvedSnapshot.policyPresets)) {
        const snapshotPresets = resolvedSnapshot.policyPresets;
        const currentPresets = policies.getAppliedPresets(targetSandbox);
        const toRemove = currentPresets.filter((p: string) => !snapshotPresets.includes(p));
        const toAdd = snapshotPresets.filter((p: string) => !currentPresets.includes(p));

        if (toRemove.length > 0 || toAdd.length > 0) {
          const summary: string[] = [];
          if (toAdd.length > 0) summary.push(`add ${toAdd.join(", ")}`);
          if (toRemove.length > 0) summary.push(`remove ${toRemove.join(", ")}`);
          console.log(`  Reconciling policy presets on '${targetSandbox}': ${summary.join("; ")}`);

          const failed: string[] = [];
          for (const preset of toRemove) {
            try {
              if (!policies.removePreset(targetSandbox, preset)) {
                failed.push(`${preset} (remove failed)`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failed.push(`${preset} (remove: ${message})`);
            }
          }
          for (const preset of toAdd) {
            try {
              if (!policies.applyPreset(targetSandbox, preset)) {
                failed.push(`${preset} (apply failed)`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failed.push(`${preset} (apply: ${message})`);
            }
          }
          if (failed.length > 0) {
            console.warn(`  Warning: could not reconcile preset(s): ${failed.join("; ")}`);
          }
        }
      }
      break;
    }
    default:
      console.log(`  Usage:`);
      console.log(`    ${CLI_NAME} ${sandboxName} snapshot create [--name <name>]`);
      console.log(
        `                                             Create a snapshot (auto-versioned v1, v2, ...)`,
      );
      console.log(
        `    ${CLI_NAME} ${sandboxName} snapshot list            List available snapshots`,
      );
      console.log(`    ${CLI_NAME} ${sandboxName} snapshot restore [selector] [--to <dst>]`);
      console.log(
        `                                             Restore by version (v1), name, or timestamp.`,
      );
      console.log(
        `                                             Omit selector to restore the most recent.`,
      );
      console.log(
        `                                             Use --to to restore into another sandbox; <dst> is auto-created if missing.`,
      );
      break;
  }
}
