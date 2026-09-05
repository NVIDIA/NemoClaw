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

const HERMES_SKILL_ID = "nemoclaw-hermes-skill-e2e";
const HERMES_SKILL_FIXTURE = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "fixtures",
  "hermes-skill-runtime",
);
const HERMES_SKILL_UPDATE_FIXTURE = path.join(
  REPO_ROOT,
  "test",
  "e2e",
  "fixtures",
  "hermes-skill-runtime-v2",
);
const HERMES_SKILL_V1_RESPONSE = "HERMES_NATIVE_SKILL_V1";
const HERMES_SKILL_V2_RESPONSE = "HERMES_NATIVE_SKILL_V2";
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

  expect(HERMES_SKILL_PROMPT).not.toContain(E2E_MOCK_REQUEST_CANARY);
  expect(HERMES_SKILL_PROMPT).not.toMatch(/HERMES_NATIVE_SKILL_V[12]/);

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
  expect(stripAnsi(resultText(skillInstall))).toContain(`Skill '${HERMES_SKILL_ID}' installed`);

  await exec(
    ["test", "-f", `/sandbox/.hermes/skills/${HERMES_SKILL_ID}/SKILL.md`],
    "phase-4-hermes-skill-disk-check",
  );
  const skillList = await exec(
    ["env", "COLUMNS=240", "hermes", "skills", "list"],
    "phase-4-hermes-skills-list",
  );
  expect(stripAnsi(resultText(skillList))).toContain(HERMES_SKILL_ID);

  const skillUpdate = await host.command(
    "nemohermes",
    [sandboxName, "skill", "install", HERMES_SKILL_UPDATE_FIXTURE],
    {
      artifactName: "phase-4-hermes-skill-update",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expect(skillUpdate.exitCode, resultText(skillUpdate)).toBe(0);
  await exec(
    [
      "bash",
      "-c",
      `grep -Fq ${HERMES_SKILL_V2_RESPONSE} /sandbox/.hermes/skills/${HERMES_SKILL_ID}/SKILL.md && ! grep -Fq ${HERMES_SKILL_V1_RESPONSE} /sandbox/.hermes/skills/${HERMES_SKILL_ID}/SKILL.md`,
    ],
    "phase-4-hermes-skill-update-disk-check",
  );

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
  expect(
    skillChatText.includes(HERMES_SKILL_V2_RESPONSE) &&
      !skillChatText.includes(HERMES_SKILL_V1_RESPONSE),
  ).toBe(true);

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

  const skillRemove = await host.command(
    "nemohermes",
    [sandboxName, "skill", "remove", HERMES_SKILL_ID],
    {
      artifactName: "phase-4-hermes-skill-remove",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 150_000,
    },
  );
  expect(skillRemove.exitCode, resultText(skillRemove)).toBe(0);
  const skillListAfterRemove = await exec(
    ["env", "COLUMNS=240", "hermes", "skills", "list"],
    "phase-4-hermes-skills-list-after-remove",
  );
  expect(stripAnsi(resultText(skillListAfterRemove))).not.toContain(HERMES_SKILL_ID);
  await exec(
    ["test", "!", "-e", `/sandbox/.hermes/skills/${HERMES_SKILL_ID}`],
    "phase-4-hermes-skill-disk-check-after-remove",
  );

  if (requestOffset === undefined) return;
  const skillRequests = (inference.requestSummaries() ?? [])
    .slice(requestOffset)
    .filter((request) => request.method === "POST" && INFERENCE_REQUEST_PATHS.has(request.path));
  expect(
    skillRequests.some((request) => request.auth === "ok" && request.requestCanaryPresent === true),
    "installed Hermes skill canary did not reach an authenticated mock inference request",
  ).toBe(true);
}
