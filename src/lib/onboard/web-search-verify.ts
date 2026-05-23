// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchVerifyAgent = {
  name?: string | null;
} | null | undefined;

export type WebSearchVerifyDeps = {
  runCaptureOpenshell: (args: string[], options: { ignoreError: true; timeout: number }) => string | null;
  cliName: () => string;
  log?: (message?: string) => void;
  warn?: (message?: string) => void;
};

/**
 * Post-creation probe: verify web search is actually functional inside the
 * sandbox. Hermes silently ignores unknown web.backend values, so checking
 * the config file alone is insufficient — we need to ask the runtime.
 *
 * For Hermes: runs `hermes dump` and checks for an active web backend.
 * For OpenClaw: checks that the tools.web.search block is present in the config.
 *
 * This is a best-effort warning — it does not abort onboarding.
 */
export function verifyWebSearchInsideSandbox(
  sandboxName: string,
  agent: WebSearchVerifyAgent,
  deps: WebSearchVerifyDeps,
): void {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const agentName = agent?.name || "openclaw";
  try {
    if (agentName === "hermes") {
      // `hermes dump` outputs config_overrides and active toolsets.
      // Look for the web backend in its output.
      const dump = deps.runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "hermes", "dump"],
        {
          ignoreError: true,
          timeout: 10_000,
        },
      );
      if (!dump) {
        warn("  ⚠ Could not verify web search config inside sandbox (hermes dump failed).");
        return;
      }
      // A working web backend shows as an explicit config override or active-toolset entry.
      // Avoid broad /web.*search/ matching so warning text never looks like success.
      const hasWebBackend =
        /^\s*web\.backend:\s*\S+/m.test(dump) ||
        /^\s*active toolsets:\s*.*\bweb\b/im.test(dump) ||
        /^\s*toolsets:\s*.*\bweb\b/im.test(dump);
      if (!hasWebBackend) {
        warn("  ⚠ Web search was configured but Hermes does not report an active web backend.");
        warn("    The agent may not have accepted the web search configuration.");
        warn(`    Check: ${deps.cliName()} ${sandboxName} exec hermes dump`);
      } else {
        log("  ✓ Web search is active inside sandbox");
      }
    } else if (agentName === "openclaw") {
      // OpenClaw: verify tools.web.search block exists in the baked config.
      const configCheck = deps.runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "cat", "/sandbox/.openclaw/openclaw.json"],
        { ignoreError: true, timeout: 10_000 },
      );
      if (!configCheck) {
        warn("  ⚠ Could not verify web search config inside sandbox.");
        return;
      }
      try {
        const parsed = JSON.parse(configCheck);
        if (parsed?.tools?.web?.search?.enabled) {
          log("  ✓ Web search is active inside sandbox");
        } else {
          warn("  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.");
        }
      } catch {
        warn("  ⚠ Could not parse openclaw.json to verify web search config.");
      }
    } else {
      warn(`  ⚠ Web search verification is not implemented for agent '${agentName}'.`);
    }
  } catch {
    // Best-effort — don't let probe failures derail onboarding.
    warn("  ⚠ Web search verification probe failed (non-fatal).");
  }
}
