// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { shellQuote } from "../core/shell-quote";

export type WebSearchVerifyProvider = "brave" | "tavily";

export type WebSearchVerifyAgent =
  | {
      name?: string | null;
    }
  | null
  | undefined;

export type WebSearchVerifyDeps = {
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
  cliName: () => string;
  webSearchEnvFor: (provider: WebSearchVerifyProvider) => string;
  webSearchLabelFor: (provider: WebSearchVerifyProvider) => string;
  log?: (message?: string) => void;
  warn?: (message?: string) => void;
};

export type WebSearchEnvBoundary = "absent" | "placeholder" | "raw-secret" | "unknown";

// Unique marker prefixing the sentinel so the host can extract it even when a
// shell prints unrelated text; the marker cannot appear in incidental output.
const WEB_SEARCH_ENV_BOUNDARY_MARKER = "__nemoclaw_wsenv__";
const WEB_SEARCH_ENV_BOUNDARY_PATTERN = /__nemoclaw_wsenv__:(absent|placeholder|raw-secret)/;

/**
 * Shell that classifies a web-search provider's credential env var *inside* the
 * sandbox and prints only a marked sentinel — never the value. This keeps the
 * guard from pulling the very credential it is checking back across the host
 * boundary. The profile-backed provider keeps the key gateway-side and rewrites
 * it at egress, so the sandbox env is unset (`absent`) or carries the
 * `openshell:resolve:env:<NAME>` reference (`placeholder`); a `generic`-typed
 * provider instead injects the plaintext credential (`raw-secret`), which the
 * agent can read and print (#7425).
 */
function buildWebSearchEnvBoundaryScript(envKey: string): string {
  const marker = WEB_SEARCH_ENV_BOUNDARY_MARKER;
  return [
    `v="$(printenv ${envKey} 2>/dev/null || true)"`,
    'case "$v" in',
    `  '') printf '${marker}:absent' ;;`,
    `  openshell:resolve:env:*) printf '${marker}:placeholder' ;;`,
    `  *) printf '${marker}:raw-secret' ;;`,
    "esac",
  ].join("\n");
}

/**
 * Extract the typed boundary state from the marked sentinel. The marker match
 * ignores any surrounding shell noise, so login banners cannot mask a real
 * `raw-secret` result as `absent`. A missing or malformed marker is `unknown`;
 * finalization must not report a security boundary as safe when it could not
 * inspect it.
 */
export function classifyWebSearchEnvBoundary(
  probeOutput: string | null | undefined,
): WebSearchEnvBoundary {
  const match = (probeOutput ?? "").match(WEB_SEARCH_ENV_BOUNDARY_PATTERN);
  return (match?.[1] as WebSearchEnvBoundary) ?? "unknown";
}

/**
 * Runtime secret-boundary guard: assert the live sandbox container env does not
 * expose the web-search provider's raw credential. `openclaw.json` inspection
 * alone misses this — the key leaks through the process environment, not the
 * config file. Classification runs in-sandbox and only a marked sentinel
 * returns, so the raw value never reaches the host. It surfaces a prominent,
 * actionable alert for a raw-secret exposure or an unverifiable result. Returns
 * true for either unsafe state so finalization can refuse a successful handoff.
 */
async function runSandboxCommand(
  deps: WebSearchVerifyDeps,
  sandboxName: string,
  command: readonly string[],
  timeoutMilliseconds: number,
): Promise<string | null> {
  const completed = await deps.commandExecutor.runBuffered({
    sandboxName,
    target: selectedOpenShellGateway(),
    command,
    timeoutMilliseconds,
  });
  return completed.outcome.kind === "completed" && completed.outcome.exitCode === 0
    ? completed.stdout
    : null;
}

async function checkWebSearchEnvSecretBoundary(
  sandboxName: string,
  provider: WebSearchVerifyProvider,
  deps: WebSearchVerifyDeps,
  warn: (message?: string) => void,
): Promise<boolean> {
  const envKey = deps.webSearchEnvFor(provider);
  let probe: string | null = null;
  try {
    probe = await runSandboxCommand(
      deps,
      sandboxName,
      // `sh -c` (not `-lc`): no login profiles run, so their output cannot
      // contaminate the sentinel the host classifies.
      ["sh", "-c", buildWebSearchEnvBoundaryScript(envKey)],
      10_000,
    );
  } catch {
    // The missing sentinel below is handled as an unsafe, unknown boundary.
  }
  const boundary = classifyWebSearchEnvBoundary(probe);
  if (boundary === "absent" || boundary === "placeholder") return false;

  const label = deps.webSearchLabelFor(provider);
  warn("");
  if (boundary === "unknown") {
    warn(`  ✗ SECURITY: could not verify the ${label} credential isolation boundary.`);
    warn(`    The ${envKey} probe inside sandbox '${sandboxName}' returned no valid sentinel, so`);
    warn("    NemoClaw cannot confirm that the agent is unable to read the raw credential.");
    warn("    Retry onboarding after checking sandbox health. If the probe still fails, recreate");
    warn("    the sandbox before using web search:");
    warn(`      ${deps.cliName()} onboard --recreate-sandbox`);
    return true;
  }

  warn(`  ✗ SECURITY: the ${label} credential is exposed in the sandbox environment.`);
  warn(`    ${envKey} holds a raw key inside sandbox '${sandboxName}', so the agent can read and`);
  warn("    print it when asked to list environment variables or API keys.");
  warn("    The credential should stay gateway-side and be resolved only at egress; a raw value");
  warn("    means the provider was attached without the profile-backed rewrite. Recreate the");
  warn("    sandbox to re-attach the profile-backed provider:");
  warn(`      ${deps.cliName()} onboard --recreate-sandbox`);
  return true;
}

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

const HERMES_TAVILY_PROBE_MARKER = "__nemoclaw_tavily__:";

function buildTavilyBodyEgressProbeCommand(): string[] {
  const script = [
    "import json, os, re",
    "def probe():",
    "    import httpx",
    "    from dotenv import dotenv_values",
    "    issued = os.environ.get('TAVILY_API_KEY', '')",
    "    saved = dotenv_values('/sandbox/.hermes/.env').get('TAVILY_API_KEY')",
    "    effective = issued if saved is None else saved",
    "    if any(value and not value.startswith('openshell:resolve:env:') for value in (issued, effective)):",
    "        return {'kind': 'raw-secret'}",
    "    if not re.fullmatch(r'openshell:resolve:env:v[0-9]{1,20}_TAVILY_API_KEY', issued):",
    "        return {'kind': 'unavailable'}",
    "    if effective != issued:",
    "        return {'kind': 'overridden'}",
    "    response = httpx.post('https://api.tavily.com/search', json={'api_key': issued, 'query': 'NVIDIA', 'max_results': 1}, timeout=20)",
    "    body = response.json() if response.status_code == 200 else {}",
    "    results = body.get('results') if isinstance(body, dict) else None",
    "    return {'kind': 'response', 'status': response.status_code, 'has_results': isinstance(results, list) and bool(results)}",
    "try:",
    "    result = probe()",
    "except Exception:",
    "    result = {'kind': 'request-failed'}",
    `print('${HERMES_TAVILY_PROBE_MARKER}' + json.dumps(result))`,
  ].join("\n");
  return ["/opt/hermes/.venv/bin/python", "-I", "-c", script];
}

async function verifyHermesTavilyEgress(
  sandboxName: string,
  deps: WebSearchVerifyDeps,
  log: (message?: string) => void,
  warn: (message?: string) => void,
): Promise<boolean> {
  const probe = await runSandboxCommand(
    deps,
    sandboxName,
    buildTavilyBodyEgressProbeCommand(),
    30_000,
  );
  let result: { kind?: unknown; status?: unknown; has_results?: unknown } | null = null;
  try {
    const line = probe?.split("\n").find((value) => value.startsWith(HERMES_TAVILY_PROBE_MARKER));
    result = JSON.parse(line?.slice(HERMES_TAVILY_PROBE_MARKER.length) ?? "null");
  } catch {
    result = null;
  }
  if (result?.kind === "raw-secret") {
    warn("  SECURITY: Hermes Tavily environment contains a raw credential; refusing handoff.");
    return false;
  }
  if (result?.kind === "overridden") {
    warn(
      "  Hermes Tavily dotenv overrides the gateway-issued credential reference; rebuild the sandbox with the current NemoClaw version.",
    );
    return true;
  }
  if (result?.kind === "unavailable") {
    warn("  No current versioned Tavily credential reference is available in the Hermes runtime.");
    return true;
  }
  const status =
    result?.kind === "response" &&
    typeof result.status === "number" &&
    Number.isInteger(result.status) &&
    result.status >= 100 &&
    result.status <= 599
      ? result.status
      : null;
  if (status === 200 && result?.has_results === true) {
    log("  ✓ Tavily Search egress verified inside sandbox");
  } else if (status !== null) {
    warn(`  ⚠ Tavily Search config exists, but egress verification returned HTTP ${status}.`);
  } else {
    warn("  ⚠ Tavily Search config exists, but the egress verification request failed.");
  }
  return true;
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
 * Configuration and egress failures remain best-effort warnings. A confirmed
 * raw credential or an unverifiable isolation result returns false so onboarding
 * cannot report the sandbox as ready.
 */
export async function verifyWebSearchInsideSandbox(
  sandboxName: string,
  agent: WebSearchVerifyAgent,
  provider: WebSearchVerifyProvider,
  deps: WebSearchVerifyDeps,
): Promise<boolean> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const agentName = agent?.name || "openclaw";
  if (await checkWebSearchEnvSecretBoundary(sandboxName, provider, deps, warn)) return false;

  try {
    if (agentName === "hermes") {
      // Hermes v2026.6.19 `dump` does not expose web.backend. Inspect the
      // generated config directly, then prove that the configured body
      // placeholder is rewritten on a real request.
      const configText = await runSandboxCommand(
        deps,
        sandboxName,
        ["cat", "/sandbox/.hermes/config.yaml"],
        10_000,
      );
      if (!configText) {
        warn("  ⚠ Could not read Hermes config to verify Tavily Search.");
        return true;
      }
      let config: { web?: { backend?: unknown } };
      try {
        config = YAML.parse(configText) as { web?: { backend?: unknown } };
      } catch {
        warn("  ⚠ Could not parse Hermes config to verify Tavily Search.");
        return true;
      }
      if (config?.web?.backend !== "tavily") {
        warn(
          "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
        );
        warn("    The agent may not have accepted the web search configuration.");
        warn(
          `    Check: ${deps.cliName()} ${sandboxName} exec -- cat /sandbox/.hermes/config.yaml`,
        );
        return true;
      }

      return await verifyHermesTavilyEgress(sandboxName, deps, log, warn);
    } else if (agentName === "openclaw") {
      // OpenClaw: verify tools.web.search exists, then prove the selected
      // provider placeholder works at egress through its credential header.
      const configCheck = await runSandboxCommand(
        deps,
        sandboxName,
        ["cat", "/sandbox/.openclaw/openclaw.json"],
        10_000,
      );
      if (!configCheck) {
        warn("  ⚠ Could not verify web search config inside sandbox.");
        return true;
      }
      try {
        const parsed = JSON.parse(configCheck);
        const search = parsed?.tools?.web?.search;
        if (!search?.enabled) {
          warn(
            "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
          );
          return true;
        }
        const provider = search.provider;
        if (provider !== "brave" && provider !== "tavily") {
          warn(`  ⚠ Web search provider '${String(provider)}' cannot be verified.`);
          return true;
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
          return true;
        }
        // Refuse to interpolate raw secrets into the curl argv. The probe
        // only proves the L7 proxy rewrites a placeholder, so a literal key
        // would expose itself in host/sandbox process listings without
        // testing the thing we care about.
        if (!/^openshell:resolve:env:[A-Za-z0-9_]+$/.test(apiKey.trim())) {
          warn(
            `  ⚠ ${providerLabel} apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.`,
          );
          return true;
        }
        const probeCommand =
          provider === "tavily"
            ? buildTavilyEgressProbeCommand(apiKey)
            : buildBraveEgressProbeCommand(apiKey);
        const probe = await runSandboxCommand(
          deps,
          sandboxName,
          ["sh", "-lc", probeCommand],
          30_000,
        );
        if (!probe) {
          warn(`  ⚠ ${providerLabel} config exists, but the egress verification request failed.`);
          return true;
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
  return true;
}
