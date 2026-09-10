// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { validateNemoClawConfig } from "../../../src/lib/config/schema.ts";
import { parseOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { testTimeout } from "../../helpers/timeouts.ts";
import {
  assertBraveConfig,
  assertBraveExport,
  assertBraveShellCredentialBoundary,
  cleanupBraveNemoClawSandbox,
  cleanupBraveState,
  commandEnv,
  exportBraveConfig,
  onboardBrave,
  reuseBraveSandboxWithWebSearchDisabled,
  runBraveAgentWithSecretBoundaryCheck,
  SANDBOX_NAME,
  sandboxShell,
} from "./brave-search-helpers.ts";

const LIVE_TIMEOUT_MS = testTimeout(35 * 60_000);

test(
  "Brave search exports stable configuration, performs real searches, and survives disabled-search reuse (#2687, #10404, #10904)",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "check Brave search prerequisites",
        "onboard Brave-enabled OpenClaw sandbox",
        "export stable Brave configuration and verify secret isolation",
        "run Brave-backed OpenClaw search",
        "assert sandbox shell cannot read the real Brave key",
        "query Brave API through credential resolver",
        "re-onboard the existing sandbox with web search disabled",
        "verify reused runtime identity and retained Brave egress",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const braveKey = secrets.required("BRAVE_API_KEY");
    const inferenceKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const redactionValues = [braveKey, inferenceKey];

    await artifacts.target.declare({
      id: "brave-search",
      boundary:
        "source CLI onboard/export + live SDK provider profile + in-sandbox OpenClaw/Brave API calls",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "onboard succeeds with BRAVE_API_KEY present",
        "config export validates the live managed Brave profile and produces schema-valid configuration",
        "repeated export preserves the same spec and references BRAVE_API_KEY without credential values or internal transports",
        "OpenClaw web search config is enabled and selects provider=brave",
        "OpenClaw stores a BRAVE_API_KEY placeholder rather than the raw key",
        "OpenClaw agent can perform a Brave-backed web search",
        "BRAVE_API_KEY is absent or a placeholder in the live agent and sandbox shell environments",
        "curl from inside the sandbox can query Brave using the placeholder token header",
        "re-onboard reuse with web search disabled exits zero and retains the durable OpenShell sandbox identity",
        "the reused OpenClaw config records web search as disabled",
        "the reused Balanced-tier policy retains api.search.brave.com and can reach it",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "phase-0-runtime-info",
      scenarioLabel: "Brave search",
    });

    cleanup.trackDisposable(`delete Brave search OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-delete-brave-search",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackDisposable(`destroy Brave search sandbox ${SANDBOX_NAME}`, () =>
      cleanupBraveNemoClawSandbox(host),
    );
    await cleanupBraveState(host, sandbox);

    progress.phase("onboard Brave-enabled OpenClaw sandbox");
    const onboard = await onboardBrave(host, braveKey, inferenceKey);
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    progress.phase("export stable Brave configuration and verify secret isolation");
    const exportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brave-export-"));
    cleanup.trackDisposable("remove private Brave config exports", () =>
      fs.rmSync(exportDirectory, { recursive: true, force: true }),
    );
    const firstPath = path.join(exportDirectory, "first.yaml");
    const first = await exportBraveConfig(
      host,
      firstPath,
      "phase-2-brave-config-export-first",
      redactionValues,
    );
    expect(first.exitCode, resultText(first)).toBe(0);
    const firstRaw = fs.readFileSync(firstPath, "utf8");
    const firstSpec = assertBraveExport(firstRaw, redactionValues);

    const repeatPath = path.join(exportDirectory, "repeat.yaml");
    const repeat = await exportBraveConfig(
      host,
      repeatPath,
      "phase-2-brave-config-export-repeat",
      redactionValues,
    );
    expect(repeat.exitCode, resultText(repeat)).toBe(0);
    const repeatRaw = fs.readFileSync(repeatPath, "utf8");
    expect(
      redactionValues.some((value) => repeatRaw.includes(value)),
      "Repeated export must omit credential values",
    ).toBe(false);
    const repeatSpec = validateNemoClawConfig(YAML.parse(repeatRaw)).spec;
    expect(
      /NEMOCLAW_[A-Z0-9_]+|openshell:resolve:env:/u.test(firstRaw + repeatRaw),
      "Export must omit internal environment transports and credential placeholders",
    ).toBe(false);
    expect(repeatSpec).toEqual(firstSpec);
    await artifacts.writeJson("brave-config-export-evidence.json", {
      sandboxName: SANDBOX_NAME,
      provider: "brave",
      credentialReference: "BRAVE_API_KEY",
      schemaValid: true,
      repeatedSpecMatches: true,
      credentialValuesAbsent: true,
      internalTransportsAbsent: true,
    });

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
      artifactName: "phase-2-openclaw-config",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 60_000,
    });

    const placeholder = assertBraveConfig(config.stdout);

    progress.phase("run Brave-backed OpenClaw search");
    const agent = await runBraveAgentWithSecretBoundaryCheck(sandbox, redactionValues);
    expect(agent.exitCode, resultText(agent)).toBe(0);
    expect(parseOpenClawAgentText(agent.stdout), resultText(agent)).toMatch(
      /nvidia|geforce|cuda|gpu/i,
    );

    progress.phase("assert sandbox shell cannot read the real Brave key");
    // #7425 reproduction, reframed to the real boundary. The reporter's leak came
    // from the raw key being readable by the agent (a generic-typed provider
    // injects it into the sandbox env), not from the model choosing to print it.
    // The benign search above proves Brave still works; the checks cover the live
    // agent and sandbox login-shell environment without feeding the key through
    // the live LLM loop or deriving portable test material from it.
    await assertBraveShellCredentialBoundary(sandbox, redactionValues);

    progress.phase("query Brave API through credential resolver");
    const curl = await sandboxShell(
      sandbox,
      `curl -sS --max-time 20 -G 'https://api.search.brave.com/res/v1/web/search' --data-urlencode 'q=NVIDIA' --data-urlencode 'count=1' -H 'X-Subscription-Token: ${placeholder}' -w '\nHTTP_STATUS:%{http_code}\n'`,
      { artifactName: "phase-4b-direct-brave-curl", timeoutMs: 60_000, redactionValues },
    );
    const body = resultText(curl);
    expect(body.match(/HTTP_STATUS:(\d{3})/)?.[1], body).toBe("200");
    const json = body.replace(/\n?HTTP_STATUS:\d{3}\s*$/u, "");
    const braveResponse = JSON.parse(json) as { web?: { results?: unknown[] } };
    expect(braveResponse.web?.results?.length ?? 0, json.slice(0, 500)).toBeGreaterThan(0);
    progress.phase("re-onboard the existing sandbox with web search disabled");
    const sandboxBeforeReuse = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-5-pre-reuse-sandbox-identity",
      env: commandEnv({ NEMOCLAW_RECREATE_SANDBOX: "0" }),
      timeoutMs: 60_000,
    });
    const sandboxIdBeforeReuse = parseOpenShellSandboxId(resultText(sandboxBeforeReuse));
    expect(sandboxIdBeforeReuse, resultText(sandboxBeforeReuse)).not.toBeNull();

    const reuse = await reuseBraveSandboxWithWebSearchDisabled(host, inferenceKey);
    expect(reuse.exitCode, resultText(reuse)).toBe(0);

    progress.phase("verify reused runtime identity and retained Brave egress");
    const sandboxAfterReuse = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-6-post-reuse-sandbox-identity",
      env: commandEnv({ NEMOCLAW_RECREATE_SANDBOX: "0" }),
      timeoutMs: 60_000,
    });
    expect(
      parseOpenShellSandboxId(resultText(sandboxAfterReuse)),
      resultText(sandboxAfterReuse),
    ).toBe(sandboxIdBeforeReuse);

    const reusedConfig = await sandbox.exec(
      SANDBOX_NAME,
      ["cat", "/sandbox/.openclaw/openclaw.json"],
      {
        artifactName: "phase-6-reused-openclaw-config",
        env: commandEnv({ NEMOCLAW_RECREATE_SANDBOX: "0" }),
        timeoutMs: 60_000,
      },
    );
    const parsedReusedConfig = JSON.parse(reusedConfig.stdout) as {
      tools?: { web?: { search?: { enabled?: unknown } } };
    };
    expect(parsedReusedConfig.tools?.web?.search?.enabled, reusedConfig.stdout).toBe(false);

    const reusedPolicy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-6-reused-brave-policy",
      env: commandEnv({ NEMOCLAW_RECREATE_SANDBOX: "0" }),
      timeoutMs: 60_000,
    });
    expect(reusedPolicy.exitCode, resultText(reusedPolicy)).toBe(0);
    expect(resultText(reusedPolicy)).toContain("api.search.brave.com");

    const reachable = await sandboxShell(
      sandbox,
      "curl -sS -o /dev/null --max-time 20 -w 'HTTP_STATUS:%{http_code}\\n' 'https://api.search.brave.com/res/v1/web/search'",
      { artifactName: "phase-6-reused-brave-egress", timeoutMs: 60_000 },
    );
    expect(resultText(reachable)).toMatch(/HTTP_STATUS:(?!000)[0-9]{3}/u);
  },
);
