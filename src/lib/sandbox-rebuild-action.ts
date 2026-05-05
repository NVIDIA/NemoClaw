// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess rebuild tests. */

import { CLI_NAME } from "./branding";
import { prompt as askPrompt } from "./credentials";
const { hydrateCredentialEnv } = require("./onboard") as {
  hydrateCredentialEnv: (name: string) => string | null;
};
const { LOCAL_INFERENCE_PROVIDERS, REMOTE_PROVIDER_CONFIG } = require("./onboard-providers") as {
  LOCAL_INFERENCE_PROVIDERS: string[];
  REMOTE_PROVIDER_CONFIG: Record<string, { providerName: string; credentialEnv: string | null }>;
};
import * as nim from "./nim";
import * as onboardSession from "./onboard-session";
import type { Session } from "./onboard-session";
import { captureOpenshell, runOpenshell } from "./openshell-runtime";
import * as policies from "./policies";
import * as registry from "./registry";
import { resolveOpenshell } from "./resolve-openshell";
import { parseLiveSandboxNames } from "./runtime-recovery";
import { getSandboxDeleteOutcome, removeSandboxRegistryEntry } from "./sandbox-destroy-action";
import { executeSandboxCommand } from "./sandbox-process-recovery-action";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "./sandbox-session-state";
import * as sandboxState from "./sandbox-state";
import * as sandboxVersion from "./sandbox-version";
import { B, D, G, R, RD as _RD, YW } from "./terminal-style";

const agentRuntime = require("../../bin/lib/agent-runtime");

function _rebuildLog(msg: string) {
  console.error(`  ${D}[rebuild ${new Date().toISOString()}] ${msg}${R}`);
}

function getRebuildCredentialEnvFromRegistry(provider: string | null | undefined): string | null {
  if (!provider || LOCAL_INFERENCE_PROVIDERS.includes(provider)) {
    return null;
  }
  const remoteConfig =
    provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
  return remoteConfig?.credentialEnv || null;
}

export async function rebuildSandbox(
  sandboxName: string,
  args: string[] = [],
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  const verbose =
    args.includes("--verbose") ||
    args.includes("-v") ||
    process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
  const log: (msg: string) => void = verbose ? _rebuildLog : () => {};
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  // When called from upgradeSandboxes in a loop, throwOnError prevents
  // process.exit from aborting the entire batch on the first failure.
  const bail = opts.throwOnError
    ? (msg: string, _code = 1) => {
        throw new Error(msg);
      }
    : (_msg: string, code = 1) => process.exit(code);

  // Active session detection — enrich the confirmation prompt if sessions are active
  let rebuildActiveSessionCount = 0;
  const opsBinRebuild = resolveOpenshell();
  if (opsBinRebuild) {
    try {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinRebuild));
      if (sessionResult.detected) {
        rebuildActiveSessionCount = sessionResult.sessions.length;
      }
    } catch {
      /* non-fatal */
    }
  }

  const sb = registry.getSandbox(sandboxName) as any;
  if (!sb) {
    console.error(`  Sandbox '${sandboxName}' not found in registry.`);
    bail(`Sandbox '${sandboxName}' not found in registry.`);
    return;
  }

  // Multi-agent guard (temporary — until swarm lands)
  if (sb.agents && sb.agents.length > 1) {
    console.error("  Multi-agent sandbox rebuild is not yet supported.");
    console.error(`  Back up state manually and recreate with \`${CLI_NAME} onboard\`.`);
    bail("Multi-agent sandbox rebuild is not yet supported.");
    return;
  }

  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);

  // Version check — show what's changing
  const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
  console.log("");
  console.log(`  ${B}Rebuild sandbox '${sandboxName}'${R}`);
  if (versionCheck.sandboxVersion) {
    console.log(`    Current:  ${agentName} v${versionCheck.sandboxVersion}`);
  }
  if (versionCheck.expectedVersion) {
    console.log(`    Target:   ${agentName} v${versionCheck.expectedVersion}`);
  }
  console.log("");

  let rebuildConfirmed = false;
  if (!skipConfirm) {
    if (rebuildActiveSessionCount > 0) {
      const plural = rebuildActiveSessionCount > 1 ? "sessions" : "session";
      console.log(
        `  ${YW}⚠  Active SSH ${plural} detected (${rebuildActiveSessionCount} connection${rebuildActiveSessionCount > 1 ? "s" : ""})${R}`,
      );
      console.log(
        `  Rebuilding will terminate ${rebuildActiveSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
      );
      console.log("");
    }
    console.log("  This will:");
    console.log("    1. Back up workspace state");
    console.log("    2. Destroy and recreate the sandbox with the current image");
    console.log("    3. Restore workspace state into the new sandbox");
    console.log("");
    const answer = await askPrompt("  Proceed? [y/N]: ");
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
    rebuildConfirmed = true;
  }

  // Step 0: Preflight — verify recreate preconditions BEFORE destroying
  // anything.  The most common rebuild failure is a missing provider
  // credential when onboard runs in non-interactive mode.  Checking now
  // lets us abort with the sandbox still intact.  See #2273.
  const session = onboardSession.loadSession();
  let rebuildCredentialEnv: string | null = null;
  if (session && session.sandboxName && session.sandboxName !== sandboxName) {
    // Session belongs to a different sandbox — its credentialEnv may be
    // wrong (e.g. hermes session while rebuilding openclaw). Resolve the
    // target sandbox provider from the registry instead so destructive
    // operations still get a credential preflight for the sandbox being rebuilt.
    rebuildCredentialEnv = getRebuildCredentialEnvFromRegistry(sb.provider);
    log(
      `Preflight warning: session belongs to '${session.sandboxName}', not '${sandboxName}' — using registry credential env ${rebuildCredentialEnv || "(none)"}`,
    );
    console.log(
      `  ${D}Note: onboard session belongs to '${session.sandboxName}', not '${sandboxName}'. ` +
        `Using the '${sandboxName}' registry entry for credential preflight.${R}`,
    );
  } else {
    rebuildCredentialEnv = session?.credentialEnv || null;
  }
  // Legacy migration: pre-fix local-inference sandboxes (GH #2519) recorded
  // credentialEnv="OPENAI_API_KEY" in onboard-session.json even though the
  // sandbox does not actually need a host OpenAI key (ollama-local uses an
  // auth proxy with an internal token; vllm-local accepts a static dummy
  // bearer). Treat the legacy value as null so rebuild does not demand a
  // credential that was never actually used.
  if (
    (session?.provider === "ollama-local" || session?.provider === "vllm-local") &&
    rebuildCredentialEnv === "OPENAI_API_KEY"
  ) {
    console.log(
      `  ${D}Note: migrating ${session.provider} sandbox off OPENAI_API_KEY (GH #2519). ` +
        `Local inference does not require a host API key.${R}`,
    );
    log(
      `Preflight: legacy ${session.provider} sandbox detected (credentialEnv=OPENAI_API_KEY) — clearing for rebuild`,
    );
    rebuildCredentialEnv = null;
  }
  if (rebuildCredentialEnv) {
    // hydrateCredentialEnv migrates any pre-fix legacy credentials.json
    // into process.env once, so users upgrading from a release that wrote
    // the plaintext file can still rebuild without re-entering keys.
    const credentialValue = hydrateCredentialEnv(rebuildCredentialEnv);
    log(
      `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
    );
    if (!credentialValue) {
      console.error("");
      console.error(`  ${_RD}Rebuild preflight failed:${R} provider credential not found.`);
      console.error(`  The non-interactive recreate step requires ${rebuildCredentialEnv},`);
      console.error("  but it is not set in the environment.");
      console.error("");
      console.error("  To fix, do one of:");
      console.error(`    export ${rebuildCredentialEnv}=<your-key>`);
      console.error(`    ${CLI_NAME} onboard          # re-enter the key interactively`);
      console.error("");
      console.error("  Sandbox is untouched — no data was lost.");
      bail(`Missing credential: ${rebuildCredentialEnv}`);
      return;
    }
  } else {
    // No credentialEnv in session — local inference (Ollama/vLLM) or
    // session was lost.  Either way, skip the credential preflight;
    // onboard will handle it.
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
  }

  // Step 1: Ensure sandbox is live for backup
  log("Checking sandbox liveness: openshell sandbox list");
  const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  log(
    `openshell sandbox list exit=${isLive.status}, output=${(isLive.output || "").substring(0, 200)}`,
  );
  const liveNames = parseLiveSandboxNames(isLive.output || "");
  log(`Live sandboxes: ${Array.from(liveNames).join(", ") || "(none)"}`);
  if (!liveNames.has(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' is not running. Cannot back up state.`);
    console.error(`  Start it first or recreate with \`${CLI_NAME} onboard --recreate-sandbox\`.`);
    bail(`Sandbox '${sandboxName}' is not running.`);
    return;
  }

  // Step 2: Backup
  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = sandboxState.backupSandboxState(sandboxName);
  log(
    `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}; files=${backup.backedUpFiles.join(",")}, failed=${backup.failedDirs.join(",")}; failedFiles=${backup.failedFiles.join(",")}`,
  );
  const hasAnyBackup = backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0;
  if (!backup.success && !hasAnyBackup) {
    // Total failure — nothing was backed up at all.
    console.error("  Failed to back up sandbox state.");
    if (backup.failedDirs.length > 0) {
      console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    }
    if (backup.failedFiles.length > 0) {
      console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
    }
    console.error("  Aborting rebuild to prevent data loss.");
    bail("Failed to back up sandbox state.");
    return;
  }
  const backupManifest = backup.manifest;
  if (!backupManifest) {
    console.error("  Failed to record backup metadata.");
    console.error("  Aborting rebuild to prevent data loss.");
    bail("Failed to record backup metadata.");
    return;
  }
  if (!backup.success) {
    // Partial backup — some state succeeded, some failed (e.g. root-owned
    // files caused tar permission errors).  Proceed with a warning so the
    // rebuild isn't blocked by a handful of inaccessible files (#2727).
    console.warn(
      `  ${YW}⚠${R} Partial backup: ${backup.backedUpDirs.length} dirs and ` +
        `${backup.backedUpFiles.length} files OK; ${backup.failedDirs.length} dirs and ` +
        `${backup.failedFiles.length} files failed`,
    );
    if (backup.failedDirs.length > 0) {
      console.warn(`    Failed dirs: ${backup.failedDirs.join(", ")}`);
    }
    if (backup.failedFiles.length > 0) {
      console.warn(`    Failed files: ${backup.failedFiles.join(", ")}`);
    }
    console.warn("    Rebuild will continue — failed state could not be preserved.");
  } else {
    console.log(
      `  ${G}\u2713${R} State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
    );
  }
  console.log(`    Backup: ${backupManifest.backupPath}`);

  // Step 3: Delete sandbox without tearing down gateway or session.
  // sandboxDestroy() cleans up the gateway when it's the last sandbox and
  // nulls session.sandboxName — both break the immediate onboard --resume.
  console.log("  Deleting old sandbox...");
  const sbMeta = registry.getSandbox(sandboxName);
  log(
    `Registry entry: agent=${sbMeta?.agent}, agentVersion=${sbMeta?.agentVersion}, nimContainer=${sbMeta?.nimContainer}`,
  );
  if (sbMeta && sbMeta.nimContainer) {
    log(`Stopping NIM container: ${sbMeta.nimContainer}`);
    nim.stopNimContainerByName(sbMeta.nimContainer);
  } else {
    // Best-effort cleanup — see comment in sandboxDestroy.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

  log(`Running: openshell sandbox delete ${sandboxName}`);
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  log(`Delete result: exit=${deleteResult.status}, alreadyGone=${alreadyGone}`);
  if (deleteResult.status !== 0 && !alreadyGone) {
    console.error("  Failed to delete sandbox. Aborting rebuild.");
    console.error("  State backup is preserved at: " + backupManifest.backupPath);
    bail("Failed to delete sandbox.", deleteResult.status || 1);
    return;
  }
  removeSandboxRegistryEntry(sandboxName);
  log(
    `Registry after remove: ${JSON.stringify(registry.listSandboxes().sandboxes.map((s: { name: string }) => s.name))}`,
  );
  console.log(`  ${G}\u2713${R} Old sandbox deleted`);

  // Step 4: Recreate via onboard --resume
  console.log("");
  console.log("  Creating new sandbox with current image...");

  // Force the sandbox name so onboard recreates with the same name.
  // Mark session resumable and point at this sandbox; set env var as fallback.
  const sessionBefore = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionBefore?.sandboxName === sandboxName;
  log(
    `Session before update: sandboxName=${sessionBefore?.sandboxName}, status=${sessionBefore?.status}, resumable=${sessionBefore?.resumable}, provider=${sessionBefore?.provider}, model=${sessionBefore?.model}, sessionMatch=${sessionMatchesSandbox}`,
  );

  // Sync the session's agent field with the registry so onboard --resume
  // rebuilds the correct sandbox type.  Without this, a stale session.agent
  // from a previous onboard of a *different* agent type would be picked up
  // by resolveAgentName() and the wrong Dockerfile would be used.  (#2201)
  const rebuildAgent = sb.agent || null;
  onboardSession.updateSession((s: Session) => {
    s.sandboxName = sandboxName;
    s.resumable = true;
    s.status = "in_progress";
    s.agent = rebuildAgent;
    // Persist inference selection from the about-to-be-removed registry entry
    // so onboard --resume can recreate with the same provider/model in
    // non-interactive mode. Without this the registry is gone by the time
    // setupNim runs, leaving no recovery source. Assign explicitly (with a
    // null fallback) so a missing registry value doesn't silently leave a
    // stale session entry from an earlier sandbox in place.
    s.provider = sb.provider ?? null;
    s.model = sb.model ?? null;
    s.nimContainer = sb.nimContainer ?? null;
    return s;
  });
  process.env.NEMOCLAW_SANDBOX_NAME = sandboxName;

  const sessionAfter = onboardSession.loadSession();
  log(
    `Session after update: sandboxName=${sessionAfter?.sandboxName}, status=${sessionAfter?.status}, resumable=${sessionAfter?.resumable}, provider=${sessionAfter?.provider}, model=${sessionAfter?.model}`,
  );
  log(
    `Env: NEMOCLAW_SANDBOX_NAME=${process.env.NEMOCLAW_SANDBOX_NAME}, NEMOCLAW_RECREATE_SANDBOX=${process.env.NEMOCLAW_RECREATE_SANDBOX}`,
  );

  // Forward the stored --from Dockerfile path so onboard --resume uses the
  // same custom image.  Without this, the conflict check rejects the resume
  // because requestedFrom (null) !== recordedFrom (the stored path).  (#2301)
  // Only read from the session when it belongs to this sandbox to avoid
  // using config from a different sandbox's onboard run.
  const storedFromDockerfile = sessionMatchesSandbox
    ? sessionAfter?.metadata?.fromDockerfile || null
    : null;
  log(
    `Calling onboard({ resume: true, nonInteractive: true, recreateSandbox: true, fromDockerfile: ${storedFromDockerfile} })`,
  );

  // Intercept process.exit during onboard so we can attempt rollback
  // instead of dying with the sandbox destroyed.  onboard() has ~87
  // process.exit() calls that would otherwise kill the process with no
  // chance to recover.  See #2273.
  //
  // NOTE: Throwing from the overridden process.exit unwinds onboard's
  // call stack, which skips process.once("exit") listeners (lock
  // release, build context cleanup, session failure marking).  We
  // manually release the lock and mark the session failed in the
  // onboardFailed block below.
  const { onboard } = require("./onboard");
  let onboardFailed = false;
  let onboardExitCode = 1;
  const _savedExit = process.exit;
  process.exit = ((code) => {
    onboardFailed = true;
    onboardExitCode = typeof code === "number" ? code : 1;
    // Throw a sentinel to unwind the onboard call stack.
    // The catch block below handles it.
    const err = new Error(`onboard exited with code ${onboardExitCode}`);
    err.name = "RebuildOnboardExit";
    throw err;
  }) as typeof process.exit;

  try {
    await onboard({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      agent: rebuildAgent,
      fromDockerfile: storedFromDockerfile,
      // Reaching here means the user already consented to the destructive
      // rebuild (either via --yes/--force or by answering "y" at the prompt).
      // Propagate that consent so the size-confirm gate inside the
      // non-interactive onboard does not abort after the old sandbox has
      // been deleted (#2639 follow-up).
      autoYes: skipConfirm || rebuildConfirmed,
    });
    log("onboard() returned successfully");
  } catch (err) {
    onboardFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    if (name !== "RebuildOnboardExit") {
      log(`onboard() threw: ${message}`);
    }
  } finally {
    process.exit = _savedExit;
  }

  if (onboardFailed) {
    // Clean up onboard's internal state that normally runs in
    // process.once("exit") listeners — those never fire because we
    // threw from the overridden process.exit instead of actually
    // exiting.  Without this the onboard lock file stays on disk and
    // blocks the next onboard/rebuild invocation.
    try {
      onboardSession.releaseOnboardLock();
    } catch {
      /* best effort */
    }
    try {
      const failedStep = onboardSession.loadSession()?.lastStepStarted;
      if (failedStep) {
        onboardSession.markStepFailed(failedStep, "Rebuild recreate failed");
      }
    } catch {
      /* best effort */
    }

    console.error("");
    console.error(`  ${_RD}Recreate failed after sandbox was destroyed.${R}`);
    console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
    console.error("");
    console.error("  To recover manually:");
    console.error(`    1. Fix the issue above (missing credential, Docker problem, etc.)`);
    console.error(`    2. Run: ${CLI_NAME} onboard --resume`);
    console.error(`       This will recreate sandbox '${sandboxName}'.`);
    console.error(`    3. Then restore your workspace state:`);
    console.error(
      `       ${CLI_NAME} ${sandboxName} snapshot restore "${backupManifest.timestamp}"`,
    );
    console.error("");
    bail(
      `Recreate failed (sandbox destroyed). Backup: ${backupManifest.backupPath}`,
      onboardExitCode,
    );
    return;
  }

  // Step 5: Restore
  console.log("");
  console.log("  Restoring workspace state...");
  log(`Restoring from: ${backupManifest.backupPath} into sandbox: ${sandboxName}`);
  const restore = sandboxState.restoreSandboxState(sandboxName, backupManifest.backupPath);
  log(
    `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}`,
  );
  if (!restore.success) {
    console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
    console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
    if (restore.failedFiles.length > 0) {
      console.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
    }
    console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
  } else {
    console.log(
      `  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
    );
  }

  // Step 5.5: Restore policy presets (#1952)
  // Policy presets live in the gateway policy engine, not the sandbox filesystem.
  // They are lost when the sandbox is destroyed and recreated. Re-apply any
  // presets that were captured in the backup manifest.
  const savedPresets = backupManifest.policyPresets || [];
  if (savedPresets.length > 0) {
    console.log("");
    console.log("  Restoring policy presets...");
    log(`Policy presets to restore: [${savedPresets.join(",")}]`);
    const restoredPresets: string[] = [];
    const failedPresets: string[] = [];
    for (const presetName of savedPresets) {
      try {
        log(`Applying preset: ${presetName}`);
        const applied = policies.applyPreset(sandboxName, presetName);
        if (applied) {
          restoredPresets.push(presetName);
        } else {
          failedPresets.push(presetName);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Failed to apply preset '${presetName}': ${errorMessage}`);
        failedPresets.push(presetName);
      }
    }
    if (restoredPresets.length > 0) {
      console.log(`  ${G}\u2713${R} Policy presets restored: ${restoredPresets.join(", ")}`);
    }
    if (failedPresets.length > 0) {
      console.error(`  ${YW}\u26a0${R} Failed to restore presets: ${failedPresets.join(", ")}`);
      console.error(`    Re-apply manually with: ${CLI_NAME} ${sandboxName} policy-add`);
    }
  }

  // Step 6: Post-restore agent-specific migration
  const rebuiltAgent = agentRuntime.getSessionAgent(sandboxName);
  const rebuiltAgentName = agentRuntime.getAgentDisplayName(rebuiltAgent);
  const agentDef = rebuiltAgent
    ? require("./agent-defs").loadAgent(rebuiltAgent.name)
    : require("./agent-defs").loadAgent("openclaw");
  if (agentDef.name === "openclaw") {
    // openclaw doctor --fix validates and repairs directory structure.
    // Idempotent and safe — catches structural changes between OpenClaw versions
    // (new symlinks, new data dirs, etc.) that the restored state may be missing.
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
    log(
      `doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`,
    );
    if (doctorResult && doctorResult.status === 0) {
      console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
    } else {
      console.log(
        `  ${D}Post-upgrade structure check skipped (doctor returned ${doctorResult?.status ?? "null"})${R}`,
      );
    }
  }
  // Hermes: no explicit post-restore step needed. Hermes's SessionDB._init_schema()
  // auto-migrates state.db (SQLite) on first connection via sequential ALTER TABLE
  // migrations (idempotent, schema_version tracked). ensure_hermes_home() repairs
  // missing directories implicitly. The NemoClaw plugin's skill cache refreshes on
  // on_session_start. Gateway startup is non-fatal if state.db migration fails.

  // Step 7: Update registry with new version
  registry.updateSandbox(sandboxName, {
    agentVersion: agentDef.expectedVersion || null,
  });
  log(`Registry updated: agentVersion=${agentDef.expectedVersion}`);

  console.log("");
  if (restore.success) {
    console.log(`  ${G}\u2713${R} Sandbox '${sandboxName}' rebuilt successfully`);
    if (versionCheck.expectedVersion) {
      console.log(`    Now running: ${rebuiltAgentName} v${versionCheck.expectedVersion}`);
    }
  } else {
    console.log(
      `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but state restore was incomplete`,
    );
    console.log(`    Backup available at: ${backupManifest.backupPath}`);
  }
}
