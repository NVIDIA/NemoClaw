// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-network-policy.sh.
 *
 * This keeps the legacy contract real: onboarding a restricted OpenClaw
 * sandbox, mutating live OpenShell network policy from the NemoClaw CLI, and
 * probing egress from inside the sandbox. Helpers stay local to this file so
 * the security/policy anchor does not add a new framework or shared fixture
 * before repeated migration needs prove one is warranted.
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
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const PERMISSIVE_POLICY = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox-permissive.yaml",
);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-net-policy-${process.pid}`;
const RUN_NETWORK_POLICY_TEST = shouldRunLiveE2EScenarios() ? test : test.skip;

const TEST_TIMEOUT_MS = 65 * 60_000;
const ONBOARD_TIMEOUT_MS = 15 * 60_000;
const SANDBOX_EXEC_TIMEOUT_MS = 120_000;
const PACKAGE_MANAGER_TIMEOUT_MS = 5 * 60_000;
const POLICY_SETTLE_MS =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 5_000 : 3_000;
const ONBOARD_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
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
  const script = String.raw`
set -euo pipefail
preset_list="$(env NEMOCLAW_NON_INTERACTIVE= node "$NEMOCLAW_E2E_CLI" "$NEMOCLAW_E2E_SANDBOX" policy-add </dev/null 2>&1 || true)"
preset_num="$(printf '%s\n' "$preset_list" | python3 -c 'import re,sys; preset=sys.argv[1]; text=sys.stdin.read(); m=re.search(r"(?m)^\s*(\d+)\).*" + re.escape(preset), text); print(m.group(1) if m else "")' "$NEMOCLAW_E2E_PRESET")"
if [ -z "$preset_num" ]; then
  printf 'preset %s not found in list:\n%s\n' "$NEMOCLAW_E2E_PRESET" "$preset_list" >&2
  exit 1
fi
printf '%s\nY\n' "$preset_num" | env NEMOCLAW_NON_INTERACTIVE= node "$NEMOCLAW_E2E_CLI" "$NEMOCLAW_E2E_SANDBOX" policy-add
`;
  const result = await host.command("bash", ["-lc", script], {
    artifactName: `policy-add-${preset}-interactive`,
    env: baseEnv({
      NEMOCLAW_E2E_CLI: CLI_ENTRYPOINT,
      NEMOCLAW_E2E_SANDBOX: SANDBOX_NAME,
      NEMOCLAW_E2E_PRESET: preset,
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

RUN_NETWORK_POLICY_TEST(
  "network-policy: restricted sandbox enforces live allow/deny policy probes",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    await artifacts.writeJson("scenario.json", {
      id: "network-policy",
      runner: "vitest",
      boundary: "live-sandbox-network-policy",
      migratedFrom: "test/e2e/test-network-policy.sh",
      contracts: [
        "deny-by-default egress",
        "read-only preset allowlist behavior",
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
      "run `npm run build:cli` before live repo CLI scenarios",
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

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

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
            NVIDIA_API_KEY: apiKey,
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

    const denyDefault = await fetchStatus(
      sandbox,
      "https://example.com/",
      "tc-net-01-deny-default",
    );
    expect(denyDefault, `example.com should be blocked under restricted policy`).toMatch(
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
    // Use the same real artifact as the retained legacy shell test. A
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

    const slackBefore = await fetchStatus(sandbox, "https://slack.com/", "tc-net-03-slack-before");
    expect(slackBefore).toMatch(/STATUS_403|ERROR_/);
    const slackApply = await applyPresetInteractively(host, "slack");
    expect(slackApply.exitCode, text(slackApply)).toBe(0);
    const slackAfter = await fetchStatus(sandbox, "https://slack.com/", "tc-net-03-slack-after");
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
    const inferenceContent = JSON.parse(inference.stdout).choices?.[0]?.message?.content;
    expect(typeof inferenceContent).toBe("string");
    expect(inferenceContent.trim().length).toBeGreaterThan(0);
    const directProvider = await fetchStatus(
      sandbox,
      "https://integrate.api.nvidia.com/v1/models",
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

    await artifacts.writeJson("scenario-result.json", {
      id: "network-policy",
      sandboxName: SANDBOX_NAME,
      assertions: {
        denyDefault: true,
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
      shellDeletion: "deferred to #5098 Phase 11 cleanup",
      nightlyShellWiring: "deferred to #5098 Phase 11 cleanup",
    });
  },
);
