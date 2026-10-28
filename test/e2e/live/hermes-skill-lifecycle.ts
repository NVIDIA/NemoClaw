// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  E2E_MOCK_REQUEST_CANARY,
  type E2EInferenceAdapter,
} from "../fixtures/inference-adapter.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { hermesSessionIds, onlyNewHermesSessionId, stripAnsi } from "./hermes-cli-adapter-live.ts";

const HERMES_SKILL_ID = "nc-hermes-e2e";
const HERMES_SKILL_RESPONSE = "PONG";
const HERMES_REMOVED_RESPONSE = "REMOVED_OK";
const HERMES_SKILL_FIXTURE = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "fixtures",
  "hermes-skill-runtime",
);
const HERMES_SKILL_PROMPT =
  "Follow the selected verification skill and return only its verification value.";
const INFERENCE_REQUEST_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/responses",
  "/responses",
]);

interface HermesSkillLifecycleOptions {
  apiPort: string;
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  inference: Pick<E2EInferenceAdapter, "model" | "requestSummaries">;
  redactionValues: string[];
  sandboxName: string;
}

/**
 * Prove the public Hermes skill lifecycle through NemoClaw without persisting
 * inference request bodies. The local mock records only whether the skill's
 * non-secret canary crossed the inference boundary.
 */
export async function assertHermesSkillLifecycle({
  apiPort,
  env,
  host,
  inference,
  redactionValues,
  sandboxName,
}: HermesSkillLifecycleOptions): Promise<void> {
  const exec = async (
    args: string[],
    artifactName: string,
    remoteTimeoutSeconds = 60,
    hostTimeoutMs = 90_000,
  ) => {
    const result = await host.command(
      "nemohermes",
      [sandboxName, "exec", "--no-stdin", "--timeout", String(remoteTimeoutSeconds), "--", ...args],
      { artifactName, env, redactionValues, timeoutMs: hostTimeoutMs },
    );
    expect(result.exitCode, resultText(result)).toBe(0);
    return result;
  };

  const skillInstall = await host.command(
    "nemohermes",
    [sandboxName, "skill", "install", HERMES_SKILL_FIXTURE],
    {
      artifactName: "phase-4-hermes-skill-install",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expect(skillInstall.exitCode, resultText(skillInstall)).toBe(0);

  const skillList = await host.command("nemohermes", [sandboxName, "skill", "list"], {
    artifactName: "phase-4-hermes-skills-list",
    env: { ...env, COLUMNS: "240" },
    redactionValues,
    timeoutMs: 90_000,
  });
  expect(skillList.exitCode, resultText(skillList)).toBe(0);
  expect(stripAnsi(resultText(skillList))).toContain(HERMES_SKILL_ID);

  // The CLI skill turn below does not exercise the default-profile gateway
  // prompt. Prove that the real gateway stores both default-home inputs.
  const sessionId = `nemoclaw-agent-home-${Date.now()}`;
  const soulMarker = "NEMOCLAW_E2E_DEFAULT_SOUL_K9X2";
  const soulBackup = `/tmp/nemoclaw-e2e-soul-${Date.now()}`;
  const soulPath = "/sandbox/.hermes/SOUL.md";
  const prepareSoul = await exec(
    [
      "bash",
      "-lc",
      `set -eu; if test -f ${shellQuote(soulPath)}; then cp ${shellQuote(soulPath)} ${shellQuote(soulBackup)}; echo SOUL_EXISTED; else echo SOUL_ABSENT; fi`,
    ],
    "phase-4-hermes-default-profile-soul-backup",
  );
  const soulExisted = prepareSoul.stdout.includes("SOUL_EXISTED");
  try {
    await exec(
      [
        "bash",
        "-lc",
        `set -eu; printf '\\n%s\\n' ${shellQuote(soulMarker)} >> ${shellQuote(soulPath)}`,
      ],
      "phase-4-hermes-default-profile-soul-setup",
    );
    const payload = JSON.stringify({
      model: inference.model,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 512,
    });
    const gatewayChat = await exec(
      [
        "bash",
        "-lc",
        `set -eu; set -a; . /sandbox/.hermes/.env; set +a; curl -fsS --max-time 120 -o /dev/null -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -H ${shellQuote(`X-Hermes-Session-Id: ${sessionId}`)} --data-raw ${shellQuote(payload)} ${shellQuote(`http://127.0.0.1:${apiPort}/v1/chat/completions`)}; echo GATEWAY_REQUEST_OK`,
      ],
      "phase-4-hermes-default-profile-gateway-chat",
      180,
      210_000,
    );
    expect(gatewayChat.stdout).toContain("GATEWAY_REQUEST_OK");

    const promptEvidence = await exec(
      [
        "/opt/hermes/.venv/bin/python",
        "-c",
        "from hermes_state import SessionDB; import sys; row = SessionDB().get_session(sys.argv[1]); assert row is not None, 'gateway session missing'; prompt = row.get('system_prompt') or ''; assert sys.argv[2] in prompt, 'default-profile SOUL.md missing from stored prompt'; assert sys.argv[3] in prompt, 'installed skill missing from stored prompt'; print('DEFAULT_PROFILE_PROMPT_OK')",
        sessionId,
        soulMarker,
        HERMES_SKILL_ID,
      ],
      "phase-4-hermes-default-profile-stored-prompt",
    );
    expect(promptEvidence.stdout).toContain("DEFAULT_PROFILE_PROMPT_OK");
  } finally {
    await exec(
      [
        "bash",
        "-lc",
        soulExisted
          ? `set -eu; cat ${shellQuote(soulBackup)} > ${shellQuote(soulPath)}; rm -f ${shellQuote(soulBackup)}`
          : `set -eu; rm -f ${shellQuote(soulPath)}`,
      ],
      "phase-4-hermes-default-profile-soul-restore",
    );
  }

  const sessionsBeforeSkill = await exec(
    ["hermes", "sessions", "list"],
    "phase-4-hermes-skill-sessions-before",
  );
  const requestOffset = inference.requestSummaries()?.length;
  const skillChat = await exec(
    ["hermes", "chat", "--skills", HERMES_SKILL_ID, "--query", HERMES_SKILL_PROMPT, "--quiet"],
    "phase-4-hermes-skill-chat",
    360,
    420_000,
  );
  const skillChatText = stripAnsi(resultText(skillChat));
  expect(skillChatText).toMatch(/\bPONG\b/i);
  expect(skillChatText).not.toContain(E2E_MOCK_REQUEST_CANARY);
  const sessionsAfterSkill = await exec(
    ["hermes", "sessions", "list"],
    "phase-4-hermes-skill-sessions-after",
  );
  expect(
    onlyNewHermesSessionId(
      hermesSessionIds(resultText(sessionsBeforeSkill)),
      hermesSessionIds(resultText(sessionsAfterSkill)),
    ),
  ).toMatch(/^\d{8}_\d{6}_[a-zA-Z0-9]+$/);

  if (requestOffset !== undefined) {
    const skillRequests = (inference.requestSummaries() ?? [])
      .slice(requestOffset)
      .filter((request) => request.method === "POST" && INFERENCE_REQUEST_PATHS.has(request.path));
    expect(skillRequests.length).toBeGreaterThan(0);
    expect(
      skillRequests.some(
        (request) => request.auth === "ok" && request.requestCanaryPresent === true,
      ),
      "installed Hermes skill canary did not reach an authenticated mock inference request",
    ).toBe(true);
  }

  const skillRemove = await host.command(
    "nemohermes",
    [sandboxName, "skill", "remove", HERMES_SKILL_ID],
    {
      artifactName: "phase-4-hermes-skill-remove",
      env,
      redactionValues,
      timeoutMs: 90_000,
    },
  );
  expect(skillRemove.exitCode, resultText(skillRemove)).toBe(0);
  const postRemoveRequestOffset = inference.requestSummaries()?.length;
  const postRemove = await host.command(
    "bash",
    [
      "-c",
      'set -eu; list="$(nemohermes "$1" skill list)"; printf "%s\\n" "$list"; ! grep -Fq -- "$2" <<<"$list"; chat="$(nemohermes "$1" exec --no-stdin --timeout 360 -- hermes chat --query "Use the removed skill named $2 if it is available. If it is unavailable, reply only $4. NEMOCLAW_E2E_FAKE_RESPONSE=$4" --quiet)"; printf "%s\\n" "$chat"; grep -Fq -- "$4" <<<"$chat"; ! grep -Fq -- "$5" <<<"$chat"; ! grep -Fq -- "$3" <<<"$chat"',
      "hermes-skill-post-remove",
      sandboxName,
      HERMES_SKILL_ID,
      E2E_MOCK_REQUEST_CANARY,
      HERMES_REMOVED_RESPONSE,
      HERMES_SKILL_RESPONSE,
    ],
    {
      artifactName: "phase-4-hermes-skill-post-remove-native-and-session",
      env,
      redactionValues,
      timeoutMs: 420_000,
    },
  );
  expect(postRemove.exitCode, resultText(postRemove)).toBe(0);
  const postRemoveRequests = (inference.requestSummaries() ?? [])
    .slice(postRemoveRequestOffset ?? Number.MAX_SAFE_INTEGER)
    .filter((request) => request.method === "POST" && INFERENCE_REQUEST_PATHS.has(request.path));
  expect(
    postRemoveRequestOffset === undefined ||
      (postRemoveRequests.length > 0 &&
        postRemoveRequests.every((request) => request.requestCanaryPresent !== true)),
    "removed Hermes skill canary still reached a fresh mock inference request",
  ).toBe(true);
}
