// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertBraveConfig,
  assertBraveResponse,
  assertBraveShellCredentialBoundary,
  assertDockerAvailable,
  cleanupBraveNemoClawSandbox,
  cleanupBraveState,
  commandEnv,
  extractOpenClawAgentText,
  onboardBrave,
  runBraveAgentWithSecretBoundaryCheck,
  SANDBOX_NAME,
  sandboxShell,
} from "./brave-search-helpers.ts";

const LIVE_TIMEOUT_MS = 35 * 60_000;

test("Brave search preset wires policy/config, hides the real key, and performs real searches (#2687)", {
  timeout: LIVE_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "check Brave search prerequisites",
      "onboard Brave-enabled OpenClaw sandbox",
      "validate Brave policy and secret isolation",
      "run Brave-backed OpenClaw search",
      "assert sandbox shell cannot read the real Brave key",
      "query Brave API through credential resolver",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
  const braveKey = secrets.required("BRAVE_API_KEY");
  const inferenceKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const redactionValues = [braveKey, inferenceKey];

  await artifacts.target.declare({
    id: "brave-search",
    boundary: "source CLI onboard + OpenShell policy/config + in-sandbox OpenClaw/Brave API calls",
    sandboxName: SANDBOX_NAME,
    contracts: [
      "onboard succeeds with BRAVE_API_KEY present",
      "the brave network policy preset includes api.search.brave.com",
      "OpenClaw web search config is enabled and selects provider=brave",
      "OpenClaw stores a BRAVE_API_KEY placeholder rather than the raw key",
      "OpenClaw agent can perform a Brave-backed web search",
      "BRAVE_API_KEY is absent or a placeholder in the live agent and sandbox shell environments",
      "curl from inside the sandbox can query Brave using the placeholder token header",
    ],
  });

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  assertDockerAvailable(dockerInfo, skip);

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

  progress.phase("validate Brave policy and secret isolation");
  const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
    artifactName: "phase-2-brave-policy",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, resultText(policy)).toBe(0);
  expect(resultText(policy)).toContain("api.search.brave.com");

  const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
    artifactName: "phase-2-openclaw-config",
    env: commandEnv(),
    redactionValues,
    timeoutMs: 60_000,
  });
  expect(config.exitCode, resultText(config)).toBe(0);

  const placeholder = assertBraveConfig(config.stdout);

  progress.phase("run Brave-backed OpenClaw search");
  const agent = await runBraveAgentWithSecretBoundaryCheck(sandbox, redactionValues);
  expect(resultText(agent)).not.toMatch(
    /SsrFBlockedError|Blocked hostname|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i,
  );
  expect(agent.exitCode, resultText(agent)).toBe(0);
  expect(extractOpenClawAgentText(agent.stdout), resultText(agent)).toMatch(
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
  assertBraveResponse(resultText(curl));
});
