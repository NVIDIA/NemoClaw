// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
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

function buildTavilyEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-X",
    "POST",
    "https://api.tavily.com/search",
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-H",
    "Content-Type: application/json",
    "--data",
    JSON.stringify({ query: "NVIDIA", max_results: 1 }),
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function buildTavilyBodyEgressProbeCommand(apiKey: string): string {
  return [
    "curl",
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "-X",
    "POST",
    "https://api.tavily.com/search",
    "-H",
    "Content-Type: application/json",
    "--data",
    JSON.stringify({ api_key: apiKey, query: "NVIDIA", max_results: 1 }),
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
  ]
    .map(shellQuote)
    .join(" ");
}

function hasTavilyResult(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.results) && parsed.results.length > 0;
  } catch {
    return false;
  }
}

/**
 * Post-creation probe: verify web search is actually functional inside the
 * sandbox. Hermes silently ignores unknown web.backend values, so config
 * inspection is paired with a real egress request.
 *
 * For Hermes: checks the configured Tavily backend, then proves body credential
 * rewriting and egress with a real search request.
 * For OpenClaw: checks the tools.web.search block, then proves provider egress.
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
      // Hermes v2026.6.19 `dump` does not expose web.backend. Inspect the
      // generated config directly, then prove that the configured body
      // placeholder is rewritten on a real request.
      const configText = deps.runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "cat", "/sandbox/.hermes/config.yaml"],
        {
          ignoreError: true,
          timeout: 10_000,
        },
      );
      if (!configText) {
        warn("  ⚠ Could not read Hermes config to verify Tavily Search.");
        return;
      }
      let config: { web?: { backend?: unknown } };
      try {
        config = YAML.parse(configText) as { web?: { backend?: unknown } };
      } catch {
        warn("  ⚠ Could not parse Hermes config to verify Tavily Search.");
        return;
      }
      if (config?.web?.backend !== "tavily") {
        warn(
          "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
        );
        warn("    The agent may not have accepted the web search configuration.");
        warn(
          `    Check: ${deps.cliName()} ${sandboxName} exec -- cat /sandbox/.hermes/config.yaml`,
        );
        return;
      }

      const placeholder = "openshell:resolve:env:TAVILY_API_KEY";
      const probe = deps.runCaptureOpenshell(
        [
          "sandbox",
          "exec",
          "-n",
          sandboxName,
          "--",
          "sh",
          "-lc",
          buildTavilyBodyEgressProbeCommand(placeholder),
        ],
        { ignoreError: true, timeout: 30_000 },
      );
      if (!probe) {
        warn("  ⚠ Tavily Search config exists, but the egress verification request failed.");
        return;
      }
      const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
      const status = statusMatch?.[1] || "unknown";
      const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
      if (status === "200" && hasTavilyResult(body)) {
        log("  ✓ Tavily Search egress verified inside sandbox");
      } else {
        warn(`  ⚠ Tavily Search config exists, but egress verification returned HTTP ${status}.`);
      }
    } else if (agentName === "openclaw") {
      // OpenClaw: verify tools.web.search exists, then prove the selected
      // provider placeholder works at egress through its credential header.
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
        const provider = search.provider;
        if (provider !== "brave" && provider !== "tavily") {
          warn(`  ⚠ Web search provider '${String(provider)}' cannot be verified.`);
          return;
        }
        const providerLabel = provider === "tavily" ? "Tavily Search" : "Brave Search";
        // Current OpenClaw schema keeps the provider-owned apiKey under
        // plugins.entries.<provider>.config.webSearch; older configs carried
        // it inline on tools.web.search. Accept both so the probe keeps
        // working across schema generations.
        const pluginApiKey = parsed?.plugins?.entries?.[search.provider]?.config?.webSearch?.apiKey;
        const apiKey = typeof pluginApiKey === "string" ? pluginApiKey : search.apiKey;
        if (typeof apiKey !== "string" || apiKey.trim() === "") {
          warn(`  ⚠ ${providerLabel} is enabled but openclaw.json has no API key placeholder.`);
          return;
        }
        // Refuse to interpolate raw secrets into the curl argv. The probe
        // only proves the L7 proxy rewrites a placeholder, so a literal key
        // would expose itself in host/sandbox process listings without
        // testing the thing we care about.
        if (!/^openshell:resolve:env:[A-Za-z0-9_]+$/.test(apiKey.trim())) {
          warn(
            `  ⚠ ${providerLabel} apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.`,
          );
          return;
        }
        const probeCommand =
          provider === "tavily"
            ? buildTavilyEgressProbeCommand(apiKey)
            : buildBraveEgressProbeCommand(apiKey);
        const probe = deps.runCaptureOpenshell(
          ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", probeCommand],
          { ignoreError: true, timeout: 30_000 },
        );
        if (!probe) {
          warn(`  ⚠ ${providerLabel} config exists, but the egress verification request failed.`);
          return;
        }
        const statusMatch = probe.match(/(?:^|\n)HTTP_STATUS:(\d{3})(?:\n|$)/);
        const status = statusMatch?.[1] || "unknown";
        const body = probe.replace(/(?:^|\n)HTTP_STATUS:\d{3}\s*$/m, "").trim();
        const hasResult = provider === "tavily" ? hasTavilyResult(body) : hasBraveResult(body);
        if (status === "200" && hasResult) {
          log(`  ✓ ${providerLabel} egress verified inside sandbox`);
        } else {
          warn(
            `  ⚠ ${providerLabel} config exists, but egress verification returned HTTP ${status}.`,
          );
          if (provider === "brave" && (status === "401" || status === "403")) {
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
