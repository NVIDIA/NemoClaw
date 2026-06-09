// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../core/shell-quote";

export type WebSearchVerifyAgent =
  | {
      name?: string | null;
    }
  | null
  | undefined;

export type WebSearchVerifyDeps = {
  runCaptureOpenshell: (
    args: string[],
    options: { ignoreError: true; timeout: number },
  ) => string | null;
  cliName: () => string;
  log?: (message?: string) => void;
  warn?: (message?: string) => void;
};

function buildBraveEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-G",
    "https://api.search.brave.com/res/v1/web/search",
    "--data-urlencode",
    "q=NVIDIA",
    "--data-urlencode",
    "count=1",
    "-H",
    `X-Subscription-Token: ${apiKey}`,
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function hasBraveResult(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.web?.results) && parsed.web.results.length > 0;
  } catch {
    return false;
  }
}

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
      // OpenClaw: verify tools.web.search block exists, then prove the
      // placeholder works at egress through Brave's X-Subscription-Token header.
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
        const search = parsed?.tools?.web?.search;
        if (!search?.enabled) {
          warn(
            "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
          );
          return;
        }
        if (search.provider !== "brave") {
          log("  ✓ Web search is active inside sandbox");
          return;
        }
        if (typeof search.apiKey !== "string" || search.apiKey.trim() === "") {
          warn("  ⚠ Brave Search is enabled but openclaw.json has no API key placeholder.");
          return;
        }
        // Refuse to interpolate raw secrets into the curl argv. The probe
        // only proves the L7 proxy rewrites a placeholder, so a literal key
        // would expose itself in host/sandbox process listings without
        // testing the thing we care about.
        if (!/^openshell:resolve:env:[A-Za-z0-9_]+$/.test(search.apiKey.trim())) {
          warn(
            "  ⚠ Brave Search apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.",
          );
          return;
        }
        const probe = deps.runCaptureOpenshell(
          [
            "sandbox",
            "exec",
            "-n",
            sandboxName,
            "--",
            "sh",
            "-lc",
            buildBraveEgressProbeCommand(search.apiKey),
          ],
          { ignoreError: true, timeout: 30_000 },
        );
        if (!probe) {
          warn("  ⚠ Brave Search config exists, but the egress verification request failed.");
          return;
        }
        const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
        const status = statusMatch?.[1] || "unknown";
        const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
        if (status === "200" && hasBraveResult(body)) {
          log("  ✓ Brave Search egress verified inside sandbox");
        } else {
          warn(`  ⚠ Brave Search config exists, but egress verification returned HTTP ${status}.`);
          if (status === "401" || status === "403") {
            // A 401/403 with the placeholder in the request typically means
            // the L7 proxy did not rewrite X-Subscription-Token. The most
            // common cause is a legacy `${sandbox}-brave-search` provider
            // still registered with the pre-fix `generic` type — `provider
            // update` cannot change the type, so a recreate is required.
            warn(
              `    Re-run onboarding with --recreate-sandbox to migrate the Brave provider to the new profile.`,
            );
          }
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
