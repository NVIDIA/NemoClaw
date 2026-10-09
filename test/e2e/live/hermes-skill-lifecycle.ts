// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { resultText } from "../fixtures/clients/command.ts";
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
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  inference: Pick<E2EInferenceAdapter, "requestSummaries">;
  redactionValues: string[];
  sandboxName: string;
}

/**
 * Prove the public Hermes skill lifecycle through NemoClaw without persisting
 * inference request bodies. The local mock records only whether the skill's
 * non-secret canary crossed the inference boundary.
 */
export async function assertHermesSkillLifecycle({
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
