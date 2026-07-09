// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * This keeps the contract real: onboarding a restricted OpenClaw
 * sandbox, mutating live OpenShell network policy from the NemoClaw CLI, and
 * probing egress from inside the sandbox. The prompt-driving helper is kept
 * separate so support tests can pin its command shape without live infra.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { isPrivateIp } from "../../../nemoclaw/src/blueprint/private-networks.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { pollDeniedReasonLog } from "./network-policy-denied-log.ts";
import { requireInferenceLocalCompletionText } from "./network-policy-inference.ts";
import {
  POLICY_ADD_EXPECT_SCRIPT,
  requirePolicyPresetNumber,
} from "./network-policy-interactive.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";
import {
  ensureDockerAvailable,
  runRestrictedOnboardWithRetry,
} from "./restricted-onboard-helpers.ts";

const PERMISSIVE_POLICY = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox-permissive.yaml",
);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-net-policy-${process.pid}`;
const SUPPRESSION_SANDBOX_NAME = `${SANDBOX_NAME}-suppression`;

const TEST_TIMEOUT_MS = 65 * 60_000;
const ONBOARD_TIMEOUT_MS = 15 * 60_000;
const SANDBOX_EXEC_TIMEOUT_MS = 120_000;
const PACKAGE_MANAGER_TIMEOUT_MS = 5 * 60_000;
const POLICY_SETTLE_MS =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 5_000 : 3_000;
const ONBOARD_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const DENIED_REASON_HOST = "nemoclaw-prr-repro-long-hostname-for-truncation-test.example.invalid";
const DENIED_REASON_ENDPOINT = `${DENIED_REASON_HOST}:443`;
const DENIED_REASON_URL = `https://${DENIED_REASON_HOST}/some/long/path`;
type NemoEnv = NodeJS.ProcessEnv;

function text(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function baseEnv(extra: NemoEnv = {}): NemoEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEvalArg(script: string): string {
  if (script.length === 0) {
    return "";
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `printf %s ${encoded} | base64 -d | sh`;
}

async function runNemoclaw(
  host: HostCliClient,
  args: string[],
  options: { artifactName: string; env?: NemoEnv; timeoutMs?: number; redactionValues?: string[] },
): Promise<ShellProbeResult> {
  return host.command("node", [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: options.env ?? baseEnv(),
    timeoutMs: options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS,
    redactionValues: options.redactionValues,
  });
}

async function sandboxBash(
  sandbox: SandboxClient,
  script: string,
  options: { artifactName: string; timeoutMs?: number } = { artifactName: "sandbox-bash" },
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(shellEvalArg(script)), {
    artifactName: options.artifactName,
    env: baseEnv(),
    timeoutMs: options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS,
  });
}

async function applyPreset(host: HostCliClient, preset: string): Promise<ShellProbeResult> {
  const result = await runNemoclaw(host, [SANDBOX_NAME, "policy-add", preset, "--yes"], {
    artifactName: `policy-add-${preset}`,
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  await sleep(POLICY_SETTLE_MS);
  return result;
}

async function applyPresetInteractively(
  host: HostCliClient,
  preset: string,
): Promise<ShellProbeResult> {
  const listResult = await host.command(
    "bash",
    [
      "-lc",
      'env NEMOCLAW_NON_INTERACTIVE= node "$NEMOCLAW_E2E_CLI" "$NEMOCLAW_E2E_SANDBOX" policy-add </dev/null',
    ],
    {
      artifactName: `policy-add-${preset}-interactive-list`,
      env: baseEnv({
        NEMOCLAW_E2E_CLI: CLI_ENTRYPOINT,
        NEMOCLAW_E2E_SANDBOX: SANDBOX_NAME,
      }),
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  const presetNumber = requirePolicyPresetNumber(text(listResult), preset);

  const result = await host.command("expect", ["-c", POLICY_ADD_EXPECT_SCRIPT], {
    artifactName: `policy-add-${preset}-interactive`,
    env: baseEnv({
      NEMOCLAW_E2E_CLI: CLI_ENTRYPOINT,
      NEMOCLAW_E2E_SANDBOX: SANDBOX_NAME,
      NEMOCLAW_E2E_PRESET_NUM: presetNumber,
    }),
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  await sleep(POLICY_SETTLE_MS);
  return result;
}

async function fetchStatus(
  sandbox: SandboxClient,
  url: string,
  artifactName: string,
): Promise<string> {
  const result = await sandboxBash(
    sandbox,
    `node -e "
fetch('${url}', {signal: AbortSignal.timeout(15000)})
  .then(async r => console.log('STATUS_' + r.status + ' ' + (await r.text()).slice(0, 120)))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
"`,
    { artifactName },
  );
  return text(result).trim();
}

async function curlStatus(
  sandbox: SandboxClient,
  url: string,
  artifactName: string,
  extraArgs = "",
): Promise<string> {
  const result = await sandboxBash(
    sandbox,
    `curl -sS -o /dev/null -w '%{http_code}' ${extraArgs} --max-time 20 ${url} 2>&1`,
    { artifactName },
  );
  return text(result).trim();
}

async function waitForDeniedReasonLog(host: HostCliClient) {
  return pollDeniedReasonLog({
    attempts: process.env.GITHUB_ACTIONS === "true" ? 12 : 8,
    endpoint: DENIED_REASON_ENDPOINT,
    readLogs: async (attempt) => {
      const logs = await runNemoclaw(host, [SANDBOX_NAME, "logs", "--tail", "50"], {
        artifactName: `tc-net-4760-logs-tail-50-attempt-${attempt}`,
        timeoutMs: 60_000,
      });
      expect(logs.exitCode, text(logs)).toBe(0);
      return text(logs);
    },
    settle: () => sleep(1_000),
  });
}

async function startMarkerServer(
  marker: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body>${marker}</body></html>\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("marker server did not expose a TCP port");
  }
  return { port: address.port, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeHostGatewayPolicy(artifacts: ArtifactSink, port: number): string {
  const target = artifacts.pathFor(`policies/host-gateway-${port}.yaml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `preset:
  name: e2e-host-gateway-web-fetch
  description: "Network-policy E2E host-gateway web_fetch probe"

network_policies:
  e2e_host_gateway_web_fetch:
    name: e2e_host_gateway_web_fetch
    endpoints:
      - host: host.openshell.internal
        port: ${port}
        protocol: rest
        enforcement: enforce
        allowed_ips:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
        rules:
          - allow: { method: GET, path: "/**" }
    binaries:
      - { path: /usr/local/bin/openclaw }
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
`,
    "utf8",
  );
  return target;
}

// A user-supplied preset that pins allowed_ips on a NON-bridge host. The guard
// must reject this on a real sandbox even though the host.openshell.internal
// exemption exists — the exemption must not become a blanket allowed_ips bypass
// (#6073). Mirrors the writeHostGatewayPolicy shape but targets an arbitrary
// private host.
function writeEvilAllowedIpsPolicy(artifacts: ArtifactSink): string {
  const target = artifacts.pathFor("policies/evil-allowed-ips.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `preset:
  name: e2e-evil-allowed-ips
  description: "Network-policy E2E allowed_ips SSRF-bypass rejection probe"

network_policies:
  e2e_evil_allowed_ips:
    name: e2e_evil_allowed_ips
    endpoints:
      - host: 10.200.0.2
        port: 18789
        protocol: rest
        enforcement: enforce
        allowed_ips:
          - 10.0.0.0/8
        rules:
          - allow: { method: GET, path: "/**" }
`,
    "utf8",
  );
  return target;
}

function buildWebFetchProbeScript(): string {
  return String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [approvedUrl, deniedUrl, marker, denyMarker] = process.argv.slice(2);
const distDir = "/usr/local/lib/node_modules/openclaw/dist";

function fail(code, detail) {
  console.log("E2E_FAIL_" + code + ": " + String(detail || "").slice(0, 1200));
  process.exitCode = 1;
}

function findDistFile(prefix) {
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".js"))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      "expected one " +
        prefix +
        "*.js file, found " +
        candidates.length +
        ": " +
        candidates.join(", "),
    );
  }
  return path.join(distDir, candidates[0]);
}

function summarize(value) {
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === "string" && inner.length > 1200) return inner.slice(0, 1200) + "...";
    return inner;
  });
}

async function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fetchConfig = config?.tools?.web?.fetch;
  if (fetchConfig?.useTrustedEnvProxy !== true) {
    fail(
      "CONFIG_MISSING_TRUSTED_ENV_PROXY",
      "tools.web.fetch.useTrustedEnvProxy=" + fetchConfig?.useTrustedEnvProxy,
    );
    return;
  }

  const mod = await import(pathToFileURL(findDistFile("openclaw-tools-")).href);
  const createOpenClawTools = mod.t || mod.createOpenClawTools;
  if (typeof createOpenClawTools !== "function") {
    fail("OPENCLAW_TOOLS_EXPORT_MISSING", Object.keys(mod).join(","));
    return;
  }

  const tools = createOpenClawTools({
    config,
    sandboxed: true,
    workspaceDir: "/sandbox/.openclaw/workspace-main",
    wrapBeforeToolCallHook: false,
    disablePluginTools: true,
    disableMessageTool: true,
  });
  const webFetch = tools.find((tool) => tool?.name === "web_fetch");
  if (!webFetch || typeof webFetch.execute !== "function") {
    fail("WEB_FETCH_TOOL_MISSING", tools.map((tool) => tool?.name).filter(Boolean).join(","));
    return;
  }

  let approvedRaw = "";
  try {
    const approved = await webFetch.execute("e2e-approved-host-gateway", {
      url: approvedUrl,
      extractMode: "text",
      maxChars: 2000,
    });
    approvedRaw = summarize(approved);
  } catch (error) {
    const detail = error && (error.stack || error.message) ? error.stack || error.message : error;
    if (/SsrFBlockedError|Blocked hostname|private\/internal\/special-use/i.test(String(detail))) {
      fail("SSRF_BLOCKED_HOST_GATEWAY_APPROVED", detail);
      return;
    }
    fail("APPROVED_FETCH_ERROR", detail);
    return;
  }
  if (!approvedRaw.includes(marker)) {
    fail("APPROVED_MARKER_MISSING", approvedRaw);
    return;
  }
  console.log("E2E_WEB_FETCH_APPROVED_OK");

  try {
    const denied = await webFetch.execute("e2e-denied-host-gateway", {
      url: deniedUrl,
      extractMode: "text",
      maxChars: 2000,
    });
    const deniedRaw = summarize(denied);
    if (deniedRaw.includes(denyMarker)) {
      fail("DENIED_PORT_REACHED", deniedRaw);
      return;
    }
    fail("DENIED_PORT_UNEXPECTED_SUCCESS", deniedRaw);
  } catch (error) {
    const detail = String(
      error && (error.stack || error.message) ? error.stack || error.message : error,
    );
    if (/SsrFBlockedError|Blocked hostname|private\/internal\/special-use/i.test(detail)) {
      fail("SSRF_BLOCKED_HOST_GATEWAY_DENIED", detail);
      return;
    }
    if (
      /Web fetch failed \(403\)|\b403\b|policy|denied|forbidden|fetch failed|ECONN|UND_ERR|proxy/i.test(
        detail,
      )
    ) {
      console.log("E2E_WEB_FETCH_DENIED_OK " + detail.split("\n")[0].slice(0, 300));
      return;
    }
    fail("DENIED_PORT_UNEXPECTED_ERROR", detail);
  }
}

main().catch((error) => {
  fail("UNCAUGHT", error && (error.stack || error.message) ? error.stack || error.message : error);
});
`;
}

test("network-policy: restricted sandbox enforces live allow/deny policy probes", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  await artifacts.target.declare({
    id: "network-policy",
    boundary: "live-sandbox-network-policy",
    contracts: [
      "deny-by-default egress",
      "OpenShell 0.0.72 preserves the full denied endpoint and policy disposition through nemoclaw logs --tail 50 (#4760)",
      "read-only preset allowlist behavior",
      "weather preset allows wttr.in GET and HEAD but denies POST and unrelated hosts",
      "live policy-add and dry-run behavior",
      "per-binary policy enforcement",
      "hot reload without sandbox restart",
      "inference.local exemption with direct-provider denial",
      "SSRF private-address rejection",
      "OpenClaw web_fetch host-gateway policy allow/deny",
      "permissive policy mode",
    ],
  });

  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-network-policy",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for network-policy live E2E: ${text(docker)}`);
    }
    skip("Docker is required for network-policy live E2E");
  }

  const openshellVersion = await host.command("openshell", ["--version"], {
    artifactName: "prereq-openshell-version-network-policy",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(openshellVersion.exitCode, text(openshellVersion)).toBe(0);
  expect(text(openshellVersion)).toContain("0.0.72");

  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  cleanup.add(`destroy network-policy sandbox ${SANDBOX_NAME}`, async () => {
    await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-network-policy",
      env: baseEnv(),
      timeoutMs: 120_000,
    });
    await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-network-policy",
      env: baseEnv(),
      timeoutMs: 60_000,
    });
  });

  await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "pre-cleanup-nemoclaw-destroy-network-policy",
    env: baseEnv(),
    timeoutMs: 120_000,
  });

  let onboard: ShellProbeResult | null = null;
  for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: `pre-cleanup-nemoclaw-destroy-network-policy-attempt-${attempt}`,
        env: baseEnv(),
        timeoutMs: 120_000,
      });
    }

    onboard = await runNemoclaw(
      host,
      ["onboard", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName:
          attempt === 1
            ? "onboard-restricted-network-policy"
            : `onboard-restricted-network-policy-attempt-${attempt}`,
        env: baseEnv({
          NVIDIA_INFERENCE_API_KEY: apiKey,
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_POLICY_TIER: "restricted",
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    if (onboard.exitCode === 0) {
      break;
    }
    if (isTransientProviderValidationFailure(onboard) && attempt < ONBOARD_ATTEMPTS) {
      await sleep(10_000 * attempt);
      continue;
    }
    if (isTransientProviderValidationFailure(onboard) && process.env.GITHUB_ACTIONS === "true") {
      // Invalid state: the external NVIDIA Endpoints validation request is unreachable,
      // rate-limited, or temporarily unavailable while local CLI/config/policy setup has
      // not produced a classifier match on its own. Source boundary: hosted provider
      // availability outside this repo. Removal condition: endpoint validation becomes
      // stable enough in CI to avoid transient 429/5xx/connectivity skips for a release
      // cycle, or NemoClaw gains a hermetic provider-validation fixture for onboarding.
      await artifacts.writeJson("transient-provider-validation.skip.json", {
        reason: "transient NVIDIA Endpoints validation failure after retries",
        attempts: ONBOARD_ATTEMPTS,
        sourceBoundary: "external NVIDIA Endpoints provider availability",
        removalCondition:
          "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture",
      });
      skip(
        `NVIDIA Endpoints validation hit a transient upstream/rate-limit failure after ${ONBOARD_ATTEMPTS} attempts`,
      );
    }
    break;
  }
  expect(onboard?.exitCode, onboard ? text(onboard) : "onboard did not run").toBe(0);

  // Invalid state: prior bugs left `openclaw-pricing` (and, under
  // `NEMOCLAW_OPENCLAW_OTEL=1` with a local endpoint,
  // `openclaw-diagnostics-otel-local`) live on restricted OpenClaw sandboxes
  // even though the restricted tier promises zero third-party network access.
  // Source boundary: live OpenShell `policy-list` after a successful
  // restricted onboard and before any operator mutation (`policy-add brew`).
  // This scenario enables `NEMOCLAW_WEB_SEARCH_ENABLED=1` so the later brave
  // probe has a preset to allow, so the assertion below only proves the two
  // OpenClaw-agent suppressed presets are absent. The authoritative
  // source-of-truth for the linked issue's literal "zero applied presets"
  // clause is the dedicated `restricted-openclaw-policy-suppression`
  // scenario below — it onboards a default restricted sandbox (no
  // web-search, no OpenClaw OTEL) and asserts the `policy-list` output has
  // no `●`-bulleted entries; that scenario must remain the gate even if
  // this scenario's assertion is ever weakened.
  const policyListAfterOnboard = await runNemoclaw(host, [SANDBOX_NAME, "policy-list"], {
    artifactName: "tc-net-01-policy-list-after-onboard",
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  expect(policyListAfterOnboard.exitCode, text(policyListAfterOnboard)).toBe(0);
  expect(
    policyListAfterOnboard.stdout,
    `restricted onboard must not leave openclaw-pricing applied: ${text(policyListAfterOnboard)}`,
  ).not.toMatch(/^[\s]*●[\s]+openclaw-pricing\b/m);
  expect(
    policyListAfterOnboard.stdout,
    `restricted onboard must not leave openclaw-diagnostics-otel-local applied: ${text(policyListAfterOnboard)}`,
  ).not.toMatch(/^[\s]*●[\s]+openclaw-diagnostics-otel-local\b/m);

  const denyDefault = await fetchStatus(sandbox, "https://example.com/", "tc-net-01-deny-default");
  expect(denyDefault, `example.com should be blocked under restricted policy`).toMatch(
    /STATUS_403|ERROR_/,
  );

  const longHostnameDenial = await sandboxBash(sandbox, `curl -m 5 -sS ${DENIED_REASON_URL}`, {
    artifactName: "tc-net-4760-denied-long-hostname",
  });
  expect(
    longHostnameDenial.exitCode !== 0 || /403|denied|forbidden/i.test(text(longHostnameDenial)),
    `long-hostname egress probe must be denied: ${text(longHostnameDenial)}`,
  ).toBe(true);

  const deniedReason = await waitForDeniedReasonLog(host);
  expect(deniedReason.reason, deniedReason.line).toContain(DENIED_REASON_ENDPOINT);
  expect(deniedReason.reason, deniedReason.line).toMatch(
    /not (?:in|allowed by) (?:any )?policy|is not allowed by any policy/i,
  );
  expect(deniedReason.reason, deniedReason.line).not.toContain("...");
  const policyField = deniedReason.line.match(/\[policy:([^\s\]]+)/u)?.[1] ?? "";
  const hasCompletePolicyDisposition =
    (policyField !== "" && policyField !== "-") ||
    /not (?:in|allowed by) (?:any )?policy|is not allowed by any policy/i.test(deniedReason.reason);
  expect(
    hasCompletePolicyDisposition,
    `DENIED log must retain a named policy or the explicit any-policy rejection: ${deniedReason.line}`,
  ).toBe(true);

  const weatherApply = await applyPreset(host, "weather");
  expect(weatherApply.exitCode, text(weatherApply)).toBe(0);

  const weatherUrl = "https://wttr.in/London";
  await expect(curlStatus(sandbox, weatherUrl, "tc-net-weather-get")).resolves.toMatch(
    /^[23][0-9][0-9]$/,
  );
  await expect(curlStatus(sandbox, weatherUrl, "tc-net-weather-head", "-I")).resolves.toMatch(
    /^[23][0-9][0-9]$/,
  );
  await expect(curlStatus(sandbox, weatherUrl, "tc-net-weather-post", "-X POST")).resolves.toBe(
    "403",
  );

  const unrelatedAfterWeather = await fetchStatus(
    sandbox,
    "https://example.com/",
    "tc-net-weather-unrelated-denied",
  );
  expect(unrelatedAfterWeather, "weather preset must not allow unrelated hosts").toMatch(
    /STATUS_403|ERROR_/,
  );

  const brewApply = await applyPreset(host, "brew");
  expect(brewApply.exitCode, text(brewApply)).toBe(0);
  const policyListAfterBrew = await runNemoclaw(host, [SANDBOX_NAME, "policy-list"], {
    artifactName: "tc-net-11-policy-list-brew",
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  expect(policyListAfterBrew.exitCode, text(policyListAfterBrew)).toBe(0);
  expect(policyListAfterBrew.stdout).toMatch(/^[\s]*●[\s]+brew[\s]/m);

  const connectProbe = await runNemoclaw(host, [SANDBOX_NAME, "connect", "--probe-only"], {
    artifactName: "tc-net-11-connect-probe-only",
    timeoutMs: 60_000,
  });
  expect(connectProbe.exitCode, text(connectProbe)).toBe(0);

  const brewProbe = await sandboxBash(
    sandbox,
    String.raw`
set -euo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
check_status() {
  endpoint_name="$1"
  endpoint_url="$2"
  status="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$endpoint_url")"
  case "$status" in
    2??|3??|401) printf 'BREW_ENDPOINT_%s_OK_%s\n' "$endpoint_name" "$status" ;;
    *) printf 'BREW_ENDPOINT_%s_BAD_%s\n' "$endpoint_name" "$status"; exit 1 ;;
  esac
}
check_status formulae https://formulae.brew.sh
check_status raw https://raw.githubusercontent.com/Homebrew/brew/HEAD/README.md
git ls-remote https://github.com/Homebrew/brew.git HEAD >/dev/null
echo "BREW_ENDPOINT_github_OK"
check_status ghcr https://ghcr.io/v2/
command -v brew
brew --prefix
brew install --quiet hello
command -v hello
hello
`,
    { artifactName: "tc-net-11-brew-install-hello", timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS },
  );
  const brewText = text(brewProbe);
  expect(brewText).toContain("BREW_ENDPOINT_formulae_OK_");
  expect(brewText).toContain("BREW_ENDPOINT_raw_OK_");
  expect(brewText).toContain("BREW_ENDPOINT_github_OK");
  expect(brewText).toContain("BREW_ENDPOINT_ghcr_OK_");
  expect(brewText).toContain("/usr/local/bin/brew");
  expect(brewText).toContain("/home/linuxbrew/.linuxbrew");
  expect(brewText).toContain("/home/linuxbrew/.linuxbrew/bin/hello");
  expect(brewText).toContain("Hello, world!");

  const pypiApply = await applyPreset(host, "pypi");
  expect(pypiApply.exitCode, text(pypiApply)).toBe(0);
  await expect(
    curlStatus(sandbox, "https://pypi.org/simple/requests/", "tc-net-02-pypi-get"),
  ).resolves.toBe("200");
  // placeholder files.pythonhosted.org path can legitimately return 404,
  // which does not prove useful artifact egress for TC-NET-02.
  await expect(
    curlStatus(
      sandbox,
      "https://files.pythonhosted.org/packages/source/r/requests/requests-2.32.5.tar.gz",
      "tc-net-02-pythonhosted-get",
    ),
  ).resolves.toMatch(/^[23][0-9][0-9]$/);
  await expect(
    curlStatus(sandbox, "https://pypi.org/simple/le/", "tc-net-02-pypi-post", "-X POST"),
  ).resolves.toBe("403");

  // Use Slack's non-redirecting API probe on the preset's actual API host;
  // the marketing root can leave the slack.com allowlist during redirects.
  const slackBefore = await fetchStatus(
    sandbox,
    "https://slack.com/api/api.test",
    "tc-net-03-slack-before",
  );
  expect(slackBefore).toMatch(/STATUS_403|ERROR_/);
  const slackApply = await applyPresetInteractively(host, "slack");
  expect(slackApply.exitCode, text(slackApply)).toBe(0);
  const slackPolicyList = await runNemoclaw(host, [SANDBOX_NAME, "policy-list"], {
    artifactName: "tc-net-03-policy-list-slack",
  });
  expect(text(slackPolicyList)).toMatch(/● slack/);
  const slackAfter = await fetchStatus(
    sandbox,
    "https://slack.com/api/api.test",
    "tc-net-03-slack-after",
  );
  expect(slackAfter).toMatch(/STATUS_200/);

  const atlassianBefore = await fetchStatus(
    sandbox,
    "https://api.atlassian.com/",
    "tc-net-04-atlassian-before-dry-run",
  );
  expect(atlassianBefore).toMatch(/STATUS_403|ERROR_/);
  const jiraDryRun = await runNemoclaw(host, [SANDBOX_NAME, "policy-add", "jira", "--dry-run"], {
    artifactName: "tc-net-04-jira-dry-run",
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  expect(jiraDryRun.exitCode, text(jiraDryRun)).toBe(0);
  expect(text(jiraDryRun)).toMatch(/atlassian|would be opened/i);
  const atlassianAfterDryRun = await fetchStatus(
    sandbox,
    "https://api.atlassian.com/",
    "tc-net-04-atlassian-after-dry-run",
  );
  expect(atlassianAfterDryRun).toMatch(/STATUS_403|ERROR_/);

  const jiraApply = await applyPreset(host, "jira");
  expect(jiraApply.exitCode, text(jiraApply)).toBe(0);
  const nodeAtlassian = await sandboxBash(
    sandbox,
    `node -e "
const https = require('https');
const req = https.get('https://api.atlassian.com', (res) => { console.log('NODE_STATUS_' + res.statusCode); res.resume(); });
req.setTimeout(30000, () => { console.log('NODE_ERROR_TIMEOUT'); req.destroy(); });
req.on('error', (error) => console.log('NODE_ERROR_' + (error.code || error.message)));
"`,
    { artifactName: "tc-net-08-node-atlassian" },
  );
  expect(text(nodeAtlassian)).toMatch(/NODE_STATUS_[23][0-9][0-9]/);

  const curlBeforeApproval = await sandboxBash(
    sandbox,
    String.raw`
set +e
OUT=$(curl -sS -o /dev/null -w 'CURL_STATUS_%{http_code} CURL_APPCONNECT_%{time_appconnect}' --max-time 10 https://api.atlassian.com/oauth/token/accessible-resources 2>&1)
RC=$?
echo "$OUT CURL_RC_$RC"
`,
    { artifactName: "tc-net-08-curl-before-approval" },
  );
  const curlBeforeText = text(curlBeforeApproval);
  expect(curlBeforeText).toMatch(
    /CURL_STATUS_000|CURL_STATUS_403|CURL_RC_[1-9]|denied|policy|forbidden/i,
  );
  expect(curlBeforeText).toMatch(/CURL_APPCONNECT_0(\.0+)?( |$)/);

  const curlApproval = await sandbox.openshell(
    [
      "policy",
      "update",
      SANDBOX_NAME,
      "--add-endpoint",
      "api.atlassian.com:443:read-only:rest:enforce",
      "--binary",
      "/usr/bin/curl",
      "--binary",
      "/usr/local/bin/curl",
      "--wait",
    ],
    {
      artifactName: "tc-net-08-openshell-curl-approval",
      env: baseEnv(),
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  expect(curlApproval.exitCode, text(curlApproval)).toBe(0);
  await sleep(POLICY_SETTLE_MS);

  const curlAfterApproval = await sandboxBash(
    sandbox,
    String.raw`
set +e
rm -f /tmp/nemoclaw-jira-curl-body
OUT=$(curl -sS -o /tmp/nemoclaw-jira-curl-body -w 'CURL_STATUS_%{http_code}' --max-time 10 https://api.atlassian.com/oauth/token/accessible-resources 2>&1)
RC=$?
printf '%s CURL_RC_%s CURL_BODY_' "$OUT" "$RC"
head -c 120 /tmp/nemoclaw-jira-curl-body 2>/dev/null || true
printf '\n'
`,
    { artifactName: "tc-net-08-curl-after-approval" },
  );
  expect(text(curlAfterApproval)).toMatch(/CURL_STATUS_401/);
  expect(text(curlAfterApproval)).toMatch(/Unauthorized|unauthorized/);

  const startTimeBefore = await sandboxBash(
    sandbox,
    "cat /proc/1/stat 2>/dev/null | awk '{print $22}'",
    {
      artifactName: "tc-net-05-starttime-before",
    },
  );
  const npmApply = await applyPreset(host, "npm");
  expect(npmApply.exitCode, text(npmApply)).toBe(0);
  const startTimeAfter = await sandboxBash(
    sandbox,
    "cat /proc/1/stat 2>/dev/null | awk '{print $22}'",
    {
      artifactName: "tc-net-05-starttime-after",
    },
  );
  expect(startTimeBefore.stdout.trim()).not.toBe("");
  expect(startTimeAfter.stdout.trim()).toBe(startTimeBefore.stdout.trim());

  const inference = await sandboxBash(
    sandbox,
    String.raw`curl -s --max-time 60 https://inference.local/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":50}'`,
    { artifactName: "tc-net-07-inference-local", timeoutMs: 90_000 },
  );
  expect(inference.exitCode, text(inference)).toBe(0);
  expect(requireInferenceLocalCompletionText(inference.stdout).length).toBeGreaterThan(0);
  const directProvider = await fetchStatus(
    sandbox,
    "https://inference-api.nvidia.com/v1/models",
    "tc-net-07-direct-provider-blocked",
  );
  expect(directProvider).toMatch(/STATUS_403|ERROR_/);

  for (const ip of ["169.254.169.254", "127.0.0.1", "10.0.0.1", "192.168.1.1", "0.0.0.0"]) {
    expect(isPrivateIp(ip), `${ip} must be blocked by SSRF validation`).toBe(true);
  }
  for (const ip of ["8.8.8.8", "142.250.80.46"]) {
    expect(isPrivateIp(ip), `${ip} must be allowed by SSRF validation`).toBe(false);
  }

  const marker = "NEMOCLAW_HOST_GATEWAY_WEB_FETCH_OK";
  const denyMarker = "NEMOCLAW_HOST_GATEWAY_WEB_FETCH_DENIED_PORT_SHOULD_NOT_LEAK";
  const approvedServer = await startMarkerServer(marker);
  const deniedServer = await startMarkerServer(denyMarker);
  try {
    const hostPolicyFile = writeHostGatewayPolicy(artifacts, approvedServer.port);
    const hostGatewayApply = await runNemoclaw(
      host,
      [SANDBOX_NAME, "policy-add", "--from-file", hostPolicyFile, "--yes"],
      { artifactName: "tc-net-10-host-gateway-policy-add", timeoutMs: SANDBOX_EXEC_TIMEOUT_MS },
    );
    expect(hostGatewayApply.exitCode, text(hostGatewayApply)).toBe(0);

    // #6073: the same policy-add --from-file path must still reject
    // allowed_ips on a non-bridge host on this real sandbox, proving the
    // host.openshell.internal exemption is not a blanket allowed_ips bypass.
    const evilPolicyFile = writeEvilAllowedIpsPolicy(artifacts);
    const evilApply = await runNemoclaw(
      host,
      [SANDBOX_NAME, "policy-add", "--from-file", evilPolicyFile, "--yes"],
      {
        artifactName: "tc-net-10-evil-allowed-ips-rejection",
        timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
      },
    );
    expect(evilApply.exitCode, text(evilApply)).not.toBe(0);
    expect(text(evilApply)).toMatch(/allowed_ips|not permitted/i);

    await sleep(POLICY_SETTLE_MS);

    const approvedDirect = await fetchStatus(
      sandbox,
      `http://host.openshell.internal:${approvedServer.port}/`,
      "tc-net-10-direct-approved-host-gateway",
    );
    expect(approvedDirect).toContain(marker);

    const deniedDirect = await fetchStatus(
      sandbox,
      `http://host.openshell.internal:${deniedServer.port}/`,
      "tc-net-10-direct-denied-host-gateway",
    );
    expect(deniedDirect).not.toContain(denyMarker);
    expect(deniedDirect).toMatch(
      /STATUS_403|ERROR_|denied|policy|forbidden|not allowed|not permitted/i,
    );

    const webFetchScriptB64 = Buffer.from(buildWebFetchProbeScript(), "utf8").toString("base64");
    const webFetch = await sandboxBash(
      sandbox,
      `printf '%s' '${webFetchScriptB64}' | base64 -d > /tmp/nemoclaw-web-fetch-e2e.mjs
nemoclaw-start node /tmp/nemoclaw-web-fetch-e2e.mjs 'http://host.openshell.internal:${approvedServer.port}/' 'http://host.openshell.internal:${deniedServer.port}/' '${marker}' '${denyMarker}'`,
      { artifactName: "tc-net-10-openclaw-web-fetch", timeoutMs: SANDBOX_EXEC_TIMEOUT_MS },
    );
    const webFetchText = text(webFetch);
    expect(webFetchText).not.toContain("E2E_FAIL_SSRF_BLOCKED_HOST_GATEWAY");
    expect(webFetchText).not.toContain("E2E_FAIL_DENIED_PORT_REACHED");
    expect(webFetchText).toContain("E2E_WEB_FETCH_APPROVED_OK");
    expect(webFetchText).toContain("E2E_WEB_FETCH_DENIED_OK");
  } finally {
    await Promise.all([approvedServer.close(), deniedServer.close()]);
  }

  const permissiveApply = await sandbox.openshell(
    ["policy", "set", "--policy", PERMISSIVE_POLICY, "--wait", SANDBOX_NAME],
    {
      artifactName: "tc-net-06-apply-permissive-policy",
      env: baseEnv(),
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  expect(permissiveApply.exitCode, text(permissiveApply)).toBe(0);
  await sleep(POLICY_SETTLE_MS);
  const npmPing = await sandboxBash(sandbox, "npm ping 2>&1 && echo NPM_OK || echo NPM_FAIL", {
    artifactName: "tc-net-06-npm-ping-permissive",
  });
  expect(text(npmPing)).toContain("NPM_OK");

  await artifacts.target.complete({
    id: "network-policy",
    sandboxName: SANDBOX_NAME,
    assertions: {
      denyDefault: true,
      weatherReadOnlyPreset: true,
      brewPreset: true,
      pypiReadOnlyPreset: true,
      livePolicyAdd: true,
      dryRunNoSideEffect: true,
      jiraPerBinaryPolicy: true,
      hotReloadNoRestart: true,
      inferenceExemption: true,
      ssrfValidation: true,
      hostGatewayWebFetch: true,
      permissiveMode: true,
    },
  });
});

// Invalid state: a default restricted OpenClaw onboard (no web-search, no
// OpenClaw OTEL) used to leave `openclaw-pricing` applied, contradicting the
// linked issue's "zero presets" acceptance clause. Source boundary: live
// OpenShell `policy-list` after onboard and before any operator mutation.
// Source-fix constraint: unit/handler tests stub policy APIs and the
// brave-enabled `network-policy` scenario above probes the suppressed
// preset names only, so neither proves the post-onboard applied set is
// literally empty. Regression test: this scenario onboards a default
// restricted OpenClaw sandbox and asserts `policy-list` shows no `●`
// bullets. Removal condition: when the agent-required addition list moves
// into per-agent declarative metadata so tier filtering happens at the
// metadata layer (see `src/lib/onboard/policy-tier-suppression.ts`).
//
// Acceptance note (`NEMOCLAW_OPENCLAW_OTEL=1`): the OTEL-enabled live
// variant is deferred to a follow-up nightly extension to keep this
// scenario's wall-clock to a single onboard. The OTEL suppression contract
// is covered by `test/policy-tiers-onboard.test.ts` and
// `test/policy-tiers-onboard-restricted-stale-otel.test.ts` against the
// real CLI through a stubbed policy API, and by the brave-enabled scenario
// above which proves `openclaw-diagnostics-otel-local` is absent through the
// live OpenShell `policy-list`. A regression in `requiredOpenclawOtelPolicyPresets()`
// or the merge boundary would surface in both layers.
//
// Acceptance note (`policy-add` escape hatch): the documented escape hatch —
// `nemoclaw <sandbox> policy-add <preset>` to re-apply a suppressed preset on
// a restricted sandbox — does not change behavior in this PR. `policy-add`
// invokes `policies.applyPreset` directly and is independent of the onboarding
// suggestion / preservation / resume paths the suppression module touches, so
// existing CLI coverage for `policy-add` continues to gate it. A dedicated
// live re-add scenario was considered but deferred to keep this scenario's
// wall-clock to a single onboard; if the escape hatch ever stops working on
// restricted, a regression would surface in the CLI `policy-add` tests rather
// than here.
test("network-policy: default restricted OpenClaw onboard leaves policy-list with zero active presets", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  await artifacts.writeJson("scenario.json", {
    id: "restricted-openclaw-policy-suppression",
    runner: "vitest",
    boundary: "live-sandbox-network-policy",
    contracts: ["restricted tier applies zero presets"],
  });

  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI scenarios",
  ).toBe(true);

  await ensureDockerAvailable({
    host,
    artifactName: "prereq-docker-info-restricted-zero-presets",
    skip,
    scenarioLabel: "restricted-zero-presets",
  });

  const openshellVersion = await host.command("openshell", ["--version"], {
    artifactName: "prereq-openshell-version-restricted-zero-presets",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(openshellVersion.exitCode, text(openshellVersion)).toBe(0);

  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  // The full E2E workflow may stage a gateway-managed compatible endpoint
  // credential through this historical env name. The real onboard below is
  // the authoritative credential validation boundary, regardless of prefix.

  cleanup.add(`destroy restricted-zero-presets sandbox ${SUPPRESSION_SANDBOX_NAME}`, async () => {
    await runNemoclaw(host, [SUPPRESSION_SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-restricted-zero-presets",
      env: baseEnv(),
      timeoutMs: 120_000,
    });
    await sandbox.openshell(["sandbox", "delete", SUPPRESSION_SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-restricted-zero-presets",
      env: baseEnv(),
      timeoutMs: 60_000,
    });
  });

  await runNemoclaw(host, [SUPPRESSION_SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "pre-cleanup-nemoclaw-destroy-restricted-zero-presets",
    env: baseEnv(),
    timeoutMs: 120_000,
  });

  const onboard = await runRestrictedOnboardWithRetry({
    host,
    artifacts,
    skip,
    sandboxName: SUPPRESSION_SANDBOX_NAME,
    apiKey,
    scenarioLabel: "restricted-zero-presets",
    scenarioSlug: "restricted-zero-presets",
    preCleanupArtifactPrefix: "pre-cleanup-nemoclaw-destroy-restricted-zero-presets",
    onboardArtifactPrefix: "onboard-restricted-zero-presets",
    onboardTimeoutMs: ONBOARD_TIMEOUT_MS,
    preCleanupTimeoutMs: 120_000,
    runNemoclaw,
    baseEnv,
  });
  expect(onboard.exitCode, text(onboard)).toBe(0);

  const policyListAfterOnboard = await runNemoclaw(
    host,
    [SUPPRESSION_SANDBOX_NAME, "policy-list"],
    {
      artifactName: "restricted-zero-presets-policy-list-after-onboard",
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  expect(policyListAfterOnboard.exitCode, text(policyListAfterOnboard)).toBe(0);
  const activeBullets = (policyListAfterOnboard.stdout.match(/^[\s]*●[\s]+(\S+)/gm) ?? []).map(
    (line) => line.replace(/^[\s]*●[\s]+/, "").trim(),
  );
  expect(
    activeBullets,
    `restricted tier must apply zero presets; got ${JSON.stringify(activeBullets)} from:\n${text(policyListAfterOnboard)}`,
  ).toEqual([]);
});
