// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import fs from "node:fs";
import path from "node:path";
import { dockerCapture, dockerInspect } from "../../adapters/docker";
import { captureOpenshell, getOpenshellBinary, runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import * as policies from "../../policy";
import { ROOT, run, shellQuote, validateName } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as shields from "../../shields";
import { isGatewayHealthy } from "../../state/gateway";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import { cleanupShieldsDestroyArtifacts, removeSandboxRegistryEntry } from "./destroy";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = useColor ? "\x1b[1m" : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";

export type SnapshotRequest =
  | { kind: "help" }
  | { kind: "create"; name?: string }
  | { kind: "list" }
  | {
      kind: "restore";
      selector?: string;
      to?: string;
      /** #3756: required when `to` names an existing sandbox. Deletes the
       * destination first, then recreates it from the source's image. */
      force?: boolean;
      /** Skip the --force interactive confirmation. Implied by
       * NEMOCLAW_NON_INTERACTIVE=1. */
      yes?: boolean;
    };

export class SnapshotCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[] = [], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n") || `Snapshot command failed with exit ${exitCode}`);
    this.name = "SnapshotCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function snapshotExit(exitCode = 1): never {
  throw new SnapshotCommandError([], exitCode);
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

// Resolve the running src pod's image. Docker- and VM-driver sandboxes don't
// have the legacy cluster container — trust the registered imageTag and fail
// fast if it's missing. Only the "kubernetes" driver falls back to the
// kubectl probe inside the gateway container.
function resolveSrcPodImage(srcName: string, srcEntry?: SandboxEntry | { name: string }): string | null {
  const registeredImage = (srcEntry as { imageTag?: string | null } | undefined)?.imageTag;
  const registeredDriver = (srcEntry as { openshellDriver?: string | null } | undefined)
    ?.openshellDriver;
  if (usesGatewayMetadataProbe(registeredDriver)) {
    return registeredImage ?? null;
  }

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
// Returns true on success; on failure, logs and throws SnapshotCommandError.
async function autoCreateSandboxFromSource(
  srcName: string,
  dstName: string,
  srcEntry: SandboxEntry | { name: string },
): Promise<void> {
  const sandboxCreateStream = require("../../sandbox/create-stream");
  const { isSandboxReady } = require("../../state/gateway");
  const basePolicy = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const openshellBin = getOpenshellBinary();

  const fromImage = resolveSrcPodImage(srcName, srcEntry);
  if (!fromImage) {
    console.error(`  Cannot auto-create '${dstName}': could not resolve '${srcName}' pod image.`);
    console.error(`  Create '${dstName}' manually with '${CLI_NAME} onboard'.`);
    snapshotExit(1);
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
    snapshotExit(1);
  }

  // Double-check Ready after stream exit.
  const verify = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (verify.status !== 0 || !isSandboxReady(verify.output || "", dstName)) {
    console.error(`  Sandbox '${dstName}' did not reach Ready state after create.`);
    snapshotExit(1);
  }

  // DNS proxy is only meaningful for the kubernetes driver (matches onboard.ts).
  const dnsScript = path.join(ROOT, "scripts", "setup-dns-proxy.sh");
  const srcDriver = (srcEntry as { openshellDriver?: string | null }).openshellDriver;
  if (srcDriver === "kubernetes" && fs.existsSync(dnsScript)) {
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
    // No CUDA proof has run for dst (this auto-create path passes no GPU flags),
    // so clear src's proof rather than inheriting it — otherwise dst could show
    // `Sandbox GPU: enabled (CUDA verified)` based on another sandbox's run (#4231).
    sandboxGpuProof: null,
  });

  console.log(`  ${G}\u2713${R} Sandbox '${dstName}' created`);
}

// Delete an existing destination sandbox so `snapshot restore --to <dst> --force`
// can recreate it from the source's image. Stops the destination's NIM
// container, runs `openshell sandbox delete`, performs the destination-only
// cleanups that `sandboxDestroy` does (PID dir, per-sandbox messaging
// providers, shields state), then drops the NemoClaw registry entry. Throws
// SnapshotCommandError on failure so the caller does not proceed into a
// partially-deleted target.
//
// Host-shared cleanups that destroy.ts performs \u2014 Ollama auth proxy
// (`killStaleProxy`), host services (`cleanupSandboxServices` with
// `stopHostServices`), Ollama model unload, gateway teardown \u2014 are
// deliberately skipped here because they can also affect the source sandbox
// we are about to clone from.
function deleteSandboxForRestore(name: string): void {
  const nim = require("../../inference/nim") as {
    stopNimContainer: (sandboxName: string, opts?: { silent?: boolean }) => void;
    stopNimContainerByName: (name: string) => void;
  };
  const sbMeta = registry.getSandbox(name);
  if (sbMeta?.nimContainer) {
    nim.stopNimContainerByName(sbMeta.nimContainer);
  } else {
    nim.stopNimContainer(name, { silent: true });
  }
  console.log(`  Deleting existing destination '${name}' before restore...`);
  const deleteResult = runOpenshell(["sandbox", "delete", name], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  if (deleteResult.status !== 0 && !alreadyGone) {
    console.error(`  Failed to delete '${name}' (exit ${deleteResult.status}). Aborting restore.`);
    snapshotExit(1);
  }
  // Destination-only cleanup so the recreated sandbox does not inherit stale
  // host-side state or hit provider-name conflicts (Codex #3796 P2):
  // - /tmp/nemoclaw-services-<name>: PID dir for this sandbox's services
  // - OpenShell providers named <name>-{telegram,discord,slack,wechat}-bridge
  //   and <name>-slack-app: per-sandbox messaging bridges
  // - shields-<name>.json + shields timer: per-sandbox shields artifacts
  try {
    fs.rmSync(`/tmp/nemoclaw-services-${name}`, { recursive: true, force: true });
  } catch {
    // PID dir may not exist \u2014 ignore.
  }
  for (const suffix of [
    "telegram-bridge",
    "discord-bridge",
    "slack-bridge",
    "slack-app",
    "wechat-bridge",
  ]) {
    runOpenshell(["provider", "delete", `${name}-${suffix}`], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  cleanupShieldsDestroyArtifacts(name);
  removeSandboxRegistryEntry(name);
  console.log(`  ${G}\u2713${R} '${name}' deleted`);
}

// Docker/VM-driver sandboxes do not expose the legacy cluster container, so
// verify gateway health through OpenShell metadata instead.
function probeGatewayMetadataHealth(): boolean {
  const status = captureOpenshell(["status"], { ignoreError: true, timeout: 10000 });
  const namedGatewayInfo = captureOpenshell(["gateway", "info", "-g", NEMOCLAW_GATEWAY_NAME], {
    ignoreError: true,
    timeout: 10000,
  });
  const activeGatewayInfo = captureOpenshell(["gateway", "info"], {
    ignoreError: true,
    timeout: 10000,
  });
  return isGatewayHealthy(
    status.output || "",
    namedGatewayInfo.output || "",
    activeGatewayInfo.output || "",
  );
}

function usesGatewayMetadataProbe(driver: string | null | undefined): boolean {
  return driver === "docker" || driver === "vm";
}

function probeGatewayRunning(sandboxName?: string): boolean {
  const entry = sandboxName ? registry.getSandbox(sandboxName) : null;
  if (usesGatewayMetadataProbe(entry?.openshellDriver)) {
    return probeGatewayMetadataHealth();
  }
  const container = `openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`;
  const result = dockerInspect(
    ["--type", "container", "--format", "{{.State.Running}}", container],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

function isSnapshotCreationAllowedByShields(sandboxName: string): boolean {
  // Snapshot creation is a shields/policy boundary. If a packaged or mocked
  // CommonJS interop surface ever omits the helper, fail closed before any
  // backup side effect instead of throwing an ambiguous TypeError.
  const isShieldsDown = shields.isShieldsDown;
  if (typeof isShieldsDown !== "function") {
    console.error("  Cannot verify shields state. Refusing to create snapshot.");
    return false;
  }
  return isShieldsDown(sandboxName);
}

export async function runSandboxSnapshot(
  sandboxName: string,
  request: SnapshotRequest = { kind: "help" },
) {
  switch (request.kind) {
    case "create": {
      if (!probeGatewayRunning(sandboxName)) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        snapshotExit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      if (!liveNames.has(sandboxName)) {
        console.error(`  Sandbox '${sandboxName}' is not running. Cannot create snapshot.`);
        snapshotExit(1);
      }
      if (!isSnapshotCreationAllowedByShields(sandboxName)) {
        console.error("  Cannot create snapshot while shields are up.");
        console.error(`  Run \`${CLI_NAME} ${sandboxName} shields down\` first, then retry.`);
        snapshotExit(1);
      }
      const label = request.name ? ` (--name ${request.name})` : "";
      console.log(`  Creating snapshot of '${sandboxName}'${label}...`);
      const result = sandboxState.backupSandboxState(sandboxName, { name: request.name ?? null });
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
        snapshotExit(1);
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
      const target = request.to ?? sandboxName;
      const targetSandbox =
        target === sandboxName ? sandboxName : validateName(target, "target sandbox name");
      if (!probeGatewayRunning(sandboxName)) {
        console.error("  Failed to query live sandbox state from OpenShell.");
        snapshotExit(1);
      }
      const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
      const liveNames = parseLiveSandboxNames(isLive.output || "");
      const isCrossSandboxRestore = targetSandbox !== sandboxName;
      const targetExists = liveNames.has(targetSandbox);

      // #3756 P1 preflight: resolve the snapshot selector AND the source pod
      // image before any destructive action. A bad selector, missing snapshot,
      // or unresolvable source image must not be allowed to delete the
      // destination first and only fail afterwards.
      const selector = request.selector ?? null;
      let backupPath: string;
      let resolvedSnapshot: ReturnType<typeof sandboxState.getLatestBackup>;
      if (selector) {
        const { match } = sandboxState.findBackup(sandboxName, selector);
        if (!match) {
          console.error(`  No snapshot matching '${selector}' found for '${sandboxName}'.`);
          console.error("  Selector must be an exact version (v<N>), name, or timestamp.");
          console.error(`  Run: ${CLI_NAME} ${sandboxName} snapshot list`);
          snapshotExit(1);
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
          snapshotExit(1);
        }
        backupPath = latest.backupPath;
        resolvedSnapshot = latest;
        const v = formatSnapshotVersion(latest);
        const nameSuffix = latest.name ? ` name=${latest.name}` : "";
        console.log(`  Using latest snapshot ${v}${nameSuffix} (${latest.timestamp})`);
      }

      if (!isCrossSandboxRestore) {
        // Self-restore: target is `sandboxName`. Cannot auto-create; the
        // source pod is the target, so it must already be live.
        if (!targetExists) {
          console.error(`  Sandbox '${targetSandbox}' is not running. Cannot restore snapshot.`);
          snapshotExit(1);
        }
      } else {
        // #3756: cross-sandbox restore into a destination that already exists
        // used to overlay onto the live filesystem silently. Refuse by default
        // *before* doing any source-side preflight, so the user sees the
        // precise "destination exists" error instead of a misleading
        // "source not found" or "cannot resolve image" message when both are
        // also broken.
        if (targetExists && !request.force) {
          console.error(`  Destination sandbox '${targetSandbox}' already exists.`);
          console.error(
            "  Restoring into an existing sandbox is unsupported because it would silently mutate its filesystem.",
          );
          console.error(
            `  Re-run with --force to delete '${targetSandbox}' and recreate it from the snapshot, or pick a different name.`,
          );
          snapshotExit(1);
        }
        // Cross-sandbox restore — whether dst exists (with --force) or not,
        // we must be able to clone the source's running pod image. Resolve it
        // upfront so a missing source / unresolvable image cannot delete the
        // destination first (#3756 P1).
        if (!liveNames.has(sandboxName)) {
          if (targetExists) {
            console.error(
              `  Cannot recreate '${targetSandbox}' from snapshot: source '${sandboxName}' not found.`,
            );
          } else {
            console.error(
              `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' not found.`,
            );
            console.error(`  Create '${targetSandbox}' manually with '${CLI_NAME} onboard'.`);
          }
          snapshotExit(1);
        }
        const srcEntry = registry.getSandbox(sandboxName) || { name: sandboxName };
        const fromImage = resolveSrcPodImage(sandboxName, srcEntry);
        if (!fromImage) {
          console.error(
            `  Cannot resolve image for source sandbox '${sandboxName}' — aborting before ` +
              (targetExists ? `deleting '${targetSandbox}'.` : `creating '${targetSandbox}'.`),
          );
          snapshotExit(1);
        }
        if (targetExists) {
          // --force confirmed above. Prompt for the destination name (unless
          // --yes or NEMOCLAW_NON_INTERACTIVE=1), then delete and recreate.
          const nonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE === "1";
          if (!request.yes && !nonInteractive) {
            const answer = (
              await askPrompt(
                `  This will DELETE sandbox '${targetSandbox}' and restore the snapshot into a fresh copy.\n` +
                  `  Type '${targetSandbox}' to confirm: `,
              )
            ).trim();
            if (answer !== targetSandbox) {
              console.error("  Confirmation did not match — aborting.");
              snapshotExit(1);
            }
          }
          deleteSandboxForRestore(targetSandbox);
        }
        await autoCreateSandboxFromSource(sandboxName, targetSandbox, srcEntry);
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
        snapshotExit(1);
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
      console.log(
        `    ${CLI_NAME} ${sandboxName} snapshot restore [selector] [--to <dst>] [--force] [--yes|-y]`,
      );
      console.log(
        `                                             Restore by version (v1), name, or timestamp.`,
      );
      console.log(
        `                                             Omit selector to restore the most recent.`,
      );
      console.log(
        `                                             Use --to to restore into another sandbox; <dst> is auto-created if missing.`,
      );
      console.log(
        `                                             When <dst> already exists, pass --force to delete it and recreate from the snapshot (prompts unless --yes).`,
      );
      break;
  }
}
