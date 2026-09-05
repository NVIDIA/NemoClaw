// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { ensureConfiguredRuntimeProviderAvailable } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { runRestrictedOnboardWithRetry } from "./restricted-onboard-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-net-policy";
const SUPPRESSION_SANDBOX_NAME =
  process.env.NEMOCLAW_NETWORK_POLICY_SUPPRESSION_SANDBOX_NAME ?? "e2e-net-suppress";
const TEST_TIMEOUT_MS = testTimeout(35 * 60_000);
const ONBOARD_TIMEOUT_MS = execTimeout(15 * 60_000);
const SANDBOX_EXEC_TIMEOUT_MS = 120_000;
const POLICY_SETTLE_MS =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 5_000 : 3_000;
type NemoEnv = NodeJS.ProcessEnv;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_NAME);
validateSandboxName(SUPPRESSION_SANDBOX_NAME);

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
  artifactName: string,
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName,
    env: baseEnv(),
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
}

async function readSandboxStartTime(sandbox: SandboxClient, artifactName: string): Promise<string> {
  const result = await sandboxBash(
    sandbox,
    "cat /proc/1/stat 2>/dev/null | awk '{print $22}'",
    artifactName,
  );
  const startTime = result.stdout.trim();
  expect(startTime, text(result)).not.toBe("");
  return startTime;
}

async function probeUrl(
  sandbox: SandboxClient,
  url: string,
  artifactName: string,
): Promise<string> {
  const result = await sandboxBash(
    sandbox,
    `curl -sS --connect-timeout 10 --max-time 20 -w '\nSTATUS_%{http_code}\n' '${url}' 2>&1`,
    artifactName,
  );
  return text(result).trim();
}

async function startMarkerServer(
  marker: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${marker}\n`);
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
  let closed = false;
  return {
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
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
  name: e2e-host-gateway
  description: "Allow one host-gateway port"

network_policies:
  e2e_host_gateway:
    name: e2e_host_gateway
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
      - { path: /usr/local/bin/curl }
      - { path: /usr/bin/curl }
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

const [approvedUrl, deniedUrl, approvedMarker, deniedMarker] = process.argv.slice(2);
function fail(detail) {
  throw new Error(detail);
}

const configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config?.tools?.web?.fetch?.useTrustedEnvProxy !== true) {
  fail("tools.web.fetch.useTrustedEnvProxy must be enabled");
}

const distDir = "/usr/local/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^openclaw-tools-(?!serve-config-).+\.js$/.test(name))
  .sort();
if (candidates.length !== 1) {
  fail("expected one OpenClaw tools module, found " + candidates.join(", "));
}

const mod = await import(pathToFileURL(path.join(distDir, candidates[0])).href);
const createOpenClawTools = mod.t || mod.createOpenClawTools;
if (typeof createOpenClawTools !== "function") {
  fail("OpenClaw tools export is missing");
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
  fail("installed OpenClaw web_fetch tool is missing");
}

function summary(value) {
  return JSON.stringify(value).slice(0, 2000);
}

const approved = await webFetch.execute("e2e-approved-host-gateway", {
  url: approvedUrl,
  extractMode: "text",
  maxChars: 2000,
});
const approvedText = summary(approved);
if (!approvedText.includes(approvedMarker)) {
  fail("approved marker missing: " + approvedText);
}
console.log("E2E_WEB_FETCH_APPROVED_OK");

try {
  const denied = await webFetch.execute("e2e-denied-host-gateway", {
    url: deniedUrl,
    extractMode: "text",
    maxChars: 2000,
  });
  const deniedText = summary(denied);
  if (deniedText.includes(deniedMarker)) {
    fail("E2E_FAIL_DENIED_PORT_REACHED: " + deniedText);
  }
  fail("E2E_FAIL_DENIED_PORT_UNEXPECTED_SUCCESS: " + deniedText);
} catch (error) {
  const detail = String(error && (error.stack || error.message) ? error.stack || error.message : error);
  if (/E2E_FAIL_DENIED_PORT_|SsrFBlockedError|Blocked hostname|private\/internal\/special-use/i.test(detail)) {
    throw error;
  }
  if (!/Web fetch failed \(403\)|\b403\b/i.test(detail)) {
    throw error;
  }
  console.log("E2E_WEB_FETCH_DENIED_OK " + detail.split("\n")[0].slice(0, 300));
}
`;
}

test(
  "network-policy: a live policy update does not restart the sandbox during host-gateway allow and deny probes",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm built CLI selected runtime provider OpenShell and credential",
        "clear the sandbox and onboard restricted policy",
        "deny default egress and hot-reload one host-gateway port",
        "allow the approved host-gateway port and deny another port",
        "prove the installed OpenClaw web_fetch path obeys the host-gateway policy",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
    await artifacts.target.declare({
      id: "network-policy",
      boundary: "live-sandbox-network-policy",
      contracts: [
        "restricted policy denies undeclared egress",
        "a live policy update does not restart the sandbox",
        "a host-gateway policy allows only its declared port",
        "installed OpenClaw web_fetch uses the same host-gateway port boundary",
      ],
    });

    expect(
      fs.existsSync(CLI_DIST_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI targets",
    ).toBe(true);

    await ensureConfiguredRuntimeProviderAvailable({
      artifactName: "prereq-runtime-provider-info-network-policy",
      host,
      scenarioLabel: "network-policy",
      skip,
    });

    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "prereq-openshell-version-network-policy",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(openshellVersion.exitCode, text(openshellVersion)).toBe(0);

    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-delete-network-policy",
        env: baseEnv(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-network-policy",
      env: baseEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });

    progress.phase("clear the sandbox and onboard restricted policy");
    await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-network-policy",
      env: baseEnv(),
      timeoutMs: 120_000,
    });

    const onboard = await runRestrictedOnboardWithRetry({
      host,
      artifacts,
      skip,
      sandboxName: SANDBOX_NAME,
      apiKey,
      scenarioLabel: "network-policy",
      scenarioSlug: "network-policy",
      preCleanupArtifactPrefix: "pre-cleanup-nemoclaw-destroy-network-policy",
      onboardArtifactPrefix: "onboard-restricted-network-policy",
      onboardTimeoutMs: ONBOARD_TIMEOUT_MS,
      preCleanupTimeoutMs: 120_000,
      runNemoclaw,
      baseEnv,
    });
    expect(onboard.exitCode, text(onboard)).toBe(0);

    progress.phase("deny default egress and hot-reload one host-gateway port");
    const defaultDenied = await probeUrl(
      sandbox,
      "https://example.com/",
      "network-policy-default-denial",
    );
    expect(defaultDenied).toMatch(/\b403\b/);

    const approvedMarker = "NEMOCLAW_HOST_GATEWAY_ALLOWED";
    const deniedMarker = "NEMOCLAW_HOST_GATEWAY_DENIED_PORT";
    const approvedServer = await startMarkerServer(approvedMarker);
    cleanup.trackDisposable("stop the approved host-gateway marker server", approvedServer.close);
    const deniedServer = await startMarkerServer(deniedMarker);
    cleanup.trackDisposable("stop the denied host-gateway marker server", deniedServer.close);

    const startTimeBefore = await readSandboxStartTime(sandbox, "network-policy-start-time-before");

    const policyFile = writeHostGatewayPolicy(artifacts, approvedServer.port);
    const policyApply = await runNemoclaw(
      host,
      [SANDBOX_NAME, "policy-add", "--from-file", policyFile, "--yes"],
      {
        artifactName: "network-policy-add-host-gateway",
        timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
      },
    );
    expect(policyApply.exitCode, text(policyApply)).toBe(0);
    await sleep(POLICY_SETTLE_MS);

    const startTimeAfterPolicy = await readSandboxStartTime(
      sandbox,
      "network-policy-start-time-after-policy",
    );
    expect(startTimeAfterPolicy).toBe(startTimeBefore);

    progress.phase("allow the approved host-gateway port and deny another port");
    const approved = await probeUrl(
      sandbox,
      `http://host.openshell.internal:${approvedServer.port}/`,
      "network-policy-approved-host-gateway-port",
    );
    expect(approved).toContain(approvedMarker);
    expect(approved).toContain("STATUS_200");
    const startTimeAfterAllow = await readSandboxStartTime(
      sandbox,
      "network-policy-start-time-after-allow-probe",
    );
    expect(startTimeAfterAllow).toBe(startTimeBefore);

    const denied = await probeUrl(
      sandbox,
      `http://host.openshell.internal:${deniedServer.port}/`,
      "network-policy-denied-host-gateway-port",
    );
    expect(denied).not.toContain(deniedMarker);
    expect(denied).toMatch(/\b403\b/);

    progress.phase("prove the installed OpenClaw web_fetch path obeys the host-gateway policy");
    const webFetch = await sandboxBash(
      sandbox,
      `nemoclaw-start node --input-type=module - 'http://host.openshell.internal:${approvedServer.port}/' 'http://host.openshell.internal:${deniedServer.port}/' '${approvedMarker}' '${deniedMarker}' <<'NEMOCLAW_WEB_FETCH_PROBE'
${buildWebFetchProbeScript()}
NEMOCLAW_WEB_FETCH_PROBE`,
      "network-policy-openclaw-web-fetch",
    );
    const webFetchText = text(webFetch);
    expect(webFetch.exitCode, webFetchText).toBe(0);
    expect(webFetchText).toContain("E2E_WEB_FETCH_APPROVED_OK");
    expect(webFetchText).toContain("E2E_WEB_FETCH_DENIED_OK");
    const startTimeAfterDeny = await readSandboxStartTime(
      sandbox,
      "network-policy-start-time-after-deny-probe",
    );
    expect(startTimeAfterDeny).toBe(startTimeBefore);

    await artifacts.target.complete({
      id: "network-policy",
      sandboxName: SANDBOX_NAME,
      assertions: {
        defaultDeny: true,
        hotReloadWithoutRestart: true,
        approvedHostGatewayPort: true,
        deniedHostGatewayPort: true,
        installedWebFetchApprovedHostGatewayPort: true,
        installedWebFetchDeniedUndeclaredPort: true,
      },
    });
  },
);

test(
  "network-policy: default restricted OpenClaw onboard leaves policy-list with zero active presets",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm built CLI selected runtime provider OpenShell and credential",
        "clear the restricted-policy sandbox",
        "onboard default restricted OpenClaw",
        "confirm the restricted tier has zero active presets",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
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

    await ensureConfiguredRuntimeProviderAvailable({
      artifactName: "prereq-runtime-provider-info-restricted-zero-presets",
      host,
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
    cleanup.trackDisposable(`delete OpenShell sandbox ${SUPPRESSION_SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SUPPRESSION_SANDBOX_NAME, {
        artifactName: "cleanup-openshell-delete-restricted-zero-presets",
        env: baseEnv(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SUPPRESSION_SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-restricted-zero-presets",
      env: baseEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });

    progress.phase("clear the restricted-policy sandbox");
    await runNemoclaw(host, [SUPPRESSION_SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-restricted-zero-presets",
      env: baseEnv(),
      timeoutMs: 120_000,
    });

    progress.phase("onboard default restricted OpenClaw");
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

    progress.phase("confirm the restricted tier has zero active presets");
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
  },
);
