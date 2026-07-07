// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertBraveConfig,
  assertBraveResponse,
  assertDockerAvailable,
  assertOptionalBraveEnv,
  assertRawConfigHasNoSecret,
  cleanupBraveState,
  commandEnv,
  extractOpenClawAgentText,
  onboardBrave,
  SANDBOX_NAME,
  sandboxShell,
  uploadSecretForLeakCheck,
} from "./brave-search-helpers.ts";

const LIVE_TIMEOUT_MS = 35 * 60_000;

test("Brave search preset wires policy/config, hides the real key, and performs real searches (#2687)", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
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
      "the real BRAVE_API_KEY is absent from openclaw.json and sandbox shell env",
      "OpenClaw agent can perform a Brave-backed web search",
      "curl from inside the sandbox can query Brave using the placeholder token header",
    ],
  });

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  assertDockerAvailable(dockerInfo, skip);

  cleanup.add(`destroy brave search sandbox ${SANDBOX_NAME}`, () =>
    cleanupBraveState(host, sandbox),
  );
  await cleanupBraveState(host, sandbox);

  const onboard = await onboardBrave(host, braveKey, inferenceKey);
  expect(onboard.exitCode, resultText(onboard)).toBe(0);

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

  const remoteSecretFile = await uploadSecretForLeakCheck(
    sandbox,
    cleanup,
    braveKey,
    redactionValues,
  );
  await assertRawConfigHasNoSecret(sandbox, remoteSecretFile);
  const placeholder = assertBraveConfig(config.stdout);

  const envCheck = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", "printenv BRAVE_API_KEY || true"],
    {
      artifactName: "phase-3-sandbox-brave-env",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  expect(envCheck.exitCode, resultText(envCheck)).toBe(0);
  assertOptionalBraveEnv(envCheck.stdout, braveKey);

  const agent = await sandboxShell(
    sandbox,
    `openclaw agent --agent main --json --session-id e2e-brave-agent-$$ -m 'Use the web search tool to find one result for the query: NVIDIA. Reply with only the title of the top result.'`,
    { artifactName: "phase-4a-agent-web-search", timeoutMs: 150_000, redactionValues },
  );
  expect(resultText(agent)).not.toMatch(
    /SsrFBlockedError|Blocked hostname|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error/i,
  );
  expect(agent.exitCode, resultText(agent)).toBe(0);
  expect(extractOpenClawAgentText(agent.stdout), resultText(agent)).toMatch(
    /nvidia|geforce|cuda|gpu/i,
  );

  const curl = await sandboxShell(
    sandbox,
    `curl -sS --max-time 20 -G 'https://api.search.brave.com/res/v1/web/search' --data-urlencode 'q=NVIDIA' --data-urlencode 'count=1' -H 'X-Subscription-Token: ${placeholder}' -w '\nHTTP_STATUS:%{http_code}\n'`,
    { artifactName: "phase-4b-direct-brave-curl", timeoutMs: 60_000, redactionValues },
  );
  assertBraveResponse(resultText(curl));
});
