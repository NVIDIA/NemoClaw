// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess upgrade tests. */

import { CLI_NAME } from "./branding";
import { prompt as askPrompt } from "./credentials";
import { captureOpenshell } from "./openshell-runtime";
import * as registry from "./registry";
import { parseLiveSandboxNames } from "./runtime-recovery";
import { rebuildSandbox } from "./sandbox-rebuild-action";
import * as sandboxVersion from "./sandbox-version";
import { B, D, G, R, YW } from "./terminal-style";

// ── Upgrade sandboxes (#1904) ────────────────────────────────────
// Detect sandboxes running stale agent versions and offer to rebuild them.

export async function upgradeSandboxes(args: string[] = []): Promise<void> {
  const checkOnly = args.includes("--check");
  const auto = args.includes("--auto");
  const skipConfirm = auto || args.includes("--yes");

  const sandboxes = registry.listSandboxes().sandboxes;
  if (sandboxes.length === 0) {
    console.log("  No sandboxes found in the registry.");
    return;
  }

  // Query live sandboxes so we can tell the user which are running
  const liveResult = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveResult.status !== 0) {
    console.error("  Failed to query running sandboxes from OpenShell.");
    console.error("  Ensure OpenShell is running: openshell status");
    process.exit(liveResult.status || 1);
  }
  const liveNames = parseLiveSandboxNames(liveResult.output || "");

  // Classify sandboxes as stale, unknown, or current
  const stale = [];
  const unknown = [];
  for (const sb of sandboxes) {
    const versionCheck = sandboxVersion.checkAgentVersion(sb.name);
    if (versionCheck.isStale) {
      stale.push({
        name: sb.name,
        current: versionCheck.sandboxVersion,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sb.name),
      });
    } else if (versionCheck.detectionMethod === "unavailable") {
      unknown.push({
        name: sb.name,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sb.name),
      });
    }
  }

  if (stale.length === 0 && unknown.length === 0) {
    console.log("  All sandboxes are up to date.");
    return;
  }

  if (stale.length > 0) {
    console.log(`\n  ${B}Stale sandboxes:${R}`);
    for (const s of stale) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  v${s.current || "?"} → v${s.expected}  (${status})`);
    }
  }
  if (unknown.length > 0) {
    console.log(`\n  ${YW}Unknown version:${R}`);
    for (const s of unknown) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  v? → v${s.expected}  (${status})`);
    }
  }
  console.log("");

  if (checkOnly) {
    if (stale.length > 0) console.log(`  ${stale.length} sandbox(es) need upgrading.`);
    if (unknown.length > 0) {
      console.log(
        `  ${unknown.length} sandbox(es) could not be version-checked; start them and rerun, or rebuild manually.`,
      );
    }
    console.log(`  Run \`${CLI_NAME} upgrade-sandboxes\` to rebuild them.`);
    return;
  }

  const rebuildable = stale.filter((s: { running: boolean }) => s.running);
  const stopped = stale.filter((s: { running: boolean }) => !s.running);
  if (stopped.length > 0) {
    console.log(`  ${D}Skipping ${stopped.length} stopped sandbox(es) — start them first.${R}`);
  }
  if (rebuildable.length === 0) {
    console.log("  No running stale sandboxes to rebuild.");
    return;
  }

  let rebuilt = 0;
  let failed = 0;
  for (const s of rebuildable) {
    if (!skipConfirm) {
      const answer = await askPrompt(`  Rebuild '${s.name}'? [y/N]: `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        console.log(`  Skipped '${s.name}'.`);
        continue;
      }
    }
    try {
      await rebuildSandbox(s.name, ["--yes"], { throwOnError: true });
      rebuilt++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`  ${YW}⚠${R} Failed to rebuild '${s.name}': ${errorMessage}`);
      failed++;
    }
  }

  console.log("");
  if (rebuilt > 0) console.log(`  ${G}✓${R} ${rebuilt} sandbox(es) rebuilt.`);
  if (failed > 0) console.log(`  ${YW}⚠${R} ${failed} sandbox(es) failed — see errors above.`);
  if (failed > 0) process.exit(1);
}
