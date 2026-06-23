// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-cron-preflight-inference-local-e2e.sh.
 *
 * Preserves the legacy runtime boundary by onboarding a real OpenClaw sandbox,
 * then invoking OpenClaw's in-sandbox cron model-provider preflight helper
 * directly against the onboarded managed provider whose base URL resolves via
 * inference.local. The cron CLI needs operator.admin scope, so this scenario
 * intentionally probes the runtime helper rather than the scheduler surface.
 */

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installShOnboardArgs } from "./install-sh-onboard.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cron-preflight";
validateSandboxName(SANDBOX_NAME);
const MODEL = process.env.NEMOCLAW_CRON_PREFLIGHT_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const LIVE_TIMEOUT_MS = 35 * 60_000;
const PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

const AUDIT_CONTEXT = "cron-model-provider-preflight";
const EXPORT_NAME = "preflightCronModelProvider";
const EXPECTED_HOSTNAME = "inference.local";
const DIST_ROOTS = [
  "/usr/local/lib/node_modules/openclaw/dist",
  "/usr/lib/node_modules/openclaw/dist",
];

function isExpectedManagedProvider(provider) {
  if (!provider || typeof provider.baseUrl !== "string") return false;
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === EXPECTED_HOSTNAME;
  } catch {
    return false;
  }
}

function findPreflightModule(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!(full.endsWith(".js") || full.endsWith(".mjs") || full.endsWith(".cjs"))) continue;
      let body;
      try {
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (body.includes(AUDIT_CONTEXT) && body.includes(EXPORT_NAME)) return full;
    }
  }
  return null;
}

(async () => {
  let target = null;
  const scanned = [];
  for (const root of DIST_ROOTS) {
    if (!fs.existsSync(root)) continue;
    scanned.push(root);
    target = findPreflightModule(root);
    if (target) break;
  }
  if (!target) {
    console.error(JSON.stringify({ error: "preflight-source-not-found", scanned }));
    process.exit(3);
  }

  let mod;
  try {
    mod = await import(url.pathToFileURL(target).href);
  } catch (err) {
    console.error(JSON.stringify({ error: "preflight-import-threw", target, message: String(err && err.stack ? err.stack : err) }));
    process.exit(3);
  }
  const preflightCronModelProvider = mod[EXPORT_NAME];
  if (typeof preflightCronModelProvider !== "function") {
    console.error(JSON.stringify({ error: "preflight-export-missing", target, exports: Object.keys(mod) }));
    process.exit(3);
  }

  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(JSON.stringify({ error: "config-read-failed", configPath, message: String(err) }));
    process.exit(3);
  }

  const providers = (cfg.models && cfg.models.providers) || {};
  const providerKey = Object.keys(providers).find((key) => isExpectedManagedProvider(providers[key]));
  if (!providerKey) {
    console.error(JSON.stringify({
      error: "no-managed-inference-local-provider",
      expectedHost: EXPECTED_HOSTNAME,
      providers: Object.entries(providers).map(([key, value]) => ({
        key,
        baseUrl: value && typeof value.baseUrl === "string" ? value.baseUrl : null,
      })),
    }));
    process.exit(3);
  }
  const providerCfg = providers[providerKey];
  const modelKey = providerCfg.defaultModel || (Array.isArray(providerCfg.models) ? providerCfg.models[0] : undefined) || "ping";

  try {
    const result = await preflightCronModelProvider({ cfg, provider: providerKey, model: modelKey });
    console.log(JSON.stringify({ providerKey, modelKey, baseUrl: providerCfg.baseUrl, target, result }));
    process.exit(result && result.status === "available" ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: "preflight-threw", message: String(err && err.stack ? err.stack : err) }));
    process.exit(2);
  }
})();
`;

interface CronPreflightProbeJson {
  providerKey?: unknown;
  modelKey?: unknown;
  baseUrl?: unknown;
  target?: unknown;
  result?: {
    status?: unknown;
    reason?: unknown;
  };
}

function commandEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER ?? "build",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  if (apiKey) {
    env.NVIDIA_INFERENCE_API_KEY = apiKey;
    env.NVIDIA_API_KEY = apiKey;
  }
  return env;
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup should not hide primary failures.
  }
}

function parseProbeJson(output: string): CronPreflightProbeJson | undefined {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith('{"providerKey"'));
  if (!line) return undefined;
  return JSON.parse(line) as CronPreflightProbeJson;
}

function probeShell(): string {
  const encoded = Buffer.from(PROBE_SOURCE, "utf8").toString("base64");
  return (
    [
      ". /tmp/nemoclaw-proxy-env.sh",
      '__probe="$(mktemp /tmp/nemoclaw-preflight-probe.XXXXXX.cjs)"',
      `printf %s '${encoded}' | base64 -d > "$__probe"`,
    ].join(" && ") + '; node "$__probe"; __rc=$?; rm -f "$__probe"; exit "$__rc"'
  );
}

async function cleanupCronSandbox(sandbox: SandboxClient): Promise<void> {
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-cron-preflight",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "cron preflight reaches managed inference.local provider without EAI_AGAIN",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");

    await artifacts.writeJson("scenario.json", {
      id: "cron-preflight-inference-local",
      runner: "vitest",
      legacySource: "test/e2e/test-cron-preflight-inference-local-e2e.sh",
      boundary: "install.sh + in-sandbox OpenClaw cron preflight runtime helper",
      sandboxName: SANDBOX_NAME,
      model: MODEL,
      contracts: [
        "install.sh onboards a fresh OpenClaw sandbox against hosted inference",
        "the onboarded OpenClaw config contains a managed provider routed through inference.local",
        "preflightCronModelProvider runs from the in-sandbox OpenClaw dist",
        "the cron preflight reports status=available",
        "the preflight reason does not contain EAI_AGAIN or local endpoint unreachable text",
      ],
    });

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for cron preflight E2E: ${resultText(dockerInfo)}`);
      }
      skip(`Docker is required for cron preflight E2E: ${resultText(dockerInfo)}`);
    }

    cleanup.add(`destroy cron preflight sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-cron-preflight",
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await cleanupCronSandbox(sandbox);
    });

    await bestEffort(() =>
      host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-cron-preflight",
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await cleanupCronSandbox(sandbox);

    let install: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
      install = await host.command("bash", installShOnboardArgs(), {
        artifactName:
          attempt === 1
            ? "phase-1-install-cron-preflight"
            : `phase-1-install-cron-preflight-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: commandEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: 20 * 60_000,
      });
      if (install.exitCode === 0) break;
      if (isTransientProviderValidationFailure(install) && attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
    expect(install, "install command must run").toBeDefined();
    expect(install?.exitCode, resultText(install as ShellProbeResult)).toBe(0);

    const probe = await host.nemoclaw([SANDBOX_NAME, "exec", "--", "sh", "-c", probeShell()], {
      artifactName: "phase-2-cron-preflight-probe",
      env: commandEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    const output = resultText(probe);
    await artifacts.writeText("cron-preflight-probe-output.txt", output);

    const parsed = parseProbeJson(output);
    expect(parsed, output).toBeDefined();
    const reason = typeof parsed?.result?.reason === "string" ? parsed.result.reason : "";
    expect(reason, output).not.toMatch(/EAI_AGAIN/i);
    expect(reason, output).not.toMatch(/local provider endpoint is not reachable/i);
    expect(probe.exitCode, output).toBe(0);
    expect(parsed?.result?.status, output).toBe("available");
    expect(parsed?.baseUrl, output).toBe("https://inference.local/v1");
  },
);
