// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { exportHermesSession, hermesLastActive } from "../fixtures/hermes-session.ts";

interface HermesCliAdapterLiveOptions {
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  redactionValues: string[];
  sandbox: SandboxClient;
  sandboxName: string;
}

type HermesFollowUpReplyOptions = Omit<HermesCliAdapterLiveOptions, "host">;

interface HermesFollowUpReplyEvidence {
  continuePrompt: string;
  resumePrompt: string;
  seedPrompt: string;
  seedSessionId: string;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g, "");
}

export function hermesSessionIds(output: string): Set<string> {
  return new Set(output.match(/\b[0-9]{8}_[0-9]{6}_[a-zA-Z0-9]+\b/g) ?? []);
}

export function onlyNewHermesSessionId(before: Set<string>, after: Set<string>): string {
  const created = [...after].filter((id) => !before.has(id));
  expect(created).toHaveLength(1);
  return created[0];
}

function createHermesCliRunner({
  env,
  redactionValues,
  sandbox,
  sandboxName,
}: HermesFollowUpReplyOptions) {
  return async (args: string[], artifactName: string, timeoutMs = 6 * 60_000) => {
    const result = await sandbox.exec(sandboxName, ["hermes", ...args], {
      artifactName,
      env,
      redactionValues,
      timeoutMs,
    });
    expect(result.exitCode, resultText(result)).toBe(0);
    return result;
  };
}

export async function assertHermesFollowUpReplies({
  env,
  redactionValues,
  sandbox,
  sandboxName,
}: HermesFollowUpReplyOptions): Promise<HermesFollowUpReplyEvidence> {
  const runHermesCli = createHermesCliRunner({ env, redactionValues, sandbox, sandboxName });
  const listDefaultSessionsText = async (artifactName: string) =>
    resultText(await runHermesCli(["sessions", "list"], artifactName, 60_000));
  const listDefaultSessions = async (artifactName: string) =>
    hermesSessionIds(await listDefaultSessionsText(artifactName));
  const expectNoNewDefaultSessions = async (
    before: Set<string>,
    beforeActivityArtifact: string,
    expectedSessionId: string,
    args: string[],
    runArtifact: string,
    afterArtifact: string,
  ) => {
    const beforeActivity = await hermesLastActive(
      sandbox,
      sandboxName,
      expectedSessionId,
      beforeActivityArtifact,
    );
    const result = await runHermesCli(args, runArtifact);
    expect(containsAnswer(stripAnsi(result.stdout), "56"), resultText(result)).toBe(true);
    const afterText = await listDefaultSessionsText(afterArtifact);
    const after = hermesSessionIds(afterText);
    expect([...after].filter((id) => !before.has(id))).toEqual([]);
    expect(after.has(expectedSessionId), stripAnsi(afterText)).toBe(true);
    expect(
      await hermesLastActive(sandbox, sandboxName, expectedSessionId, `${afterArtifact}-metadata`),
    ).toBeGreaterThan(beforeActivity);
  };

  const issue5254Marker = `NEMOCLAW_5254_${Date.now()}`;
  const beforeSeedSessions = await listDefaultSessions("phase-4-issue-5254-sessions-before-seed");
  const seedPrompt = `Remember this exact token: ${issue5254Marker}. Reply with acknowledged.`;
  const seedResult = await runHermesCli(["-z", seedPrompt], "phase-4-issue-5254-seed-oneshot");
  expect(containsAnswer(stripAnsi(seedResult.stdout), "acknowledged"), resultText(seedResult)).toBe(
    true,
  );
  const seedSessionId = onlyNewHermesSessionId(
    beforeSeedSessions,
    await listDefaultSessions("phase-4-issue-5254-sessions-after-seed"),
  );
  const resumePrompt = "What is seven multiplied by eight? Reply with only the integer.";
  await expectNoNewDefaultSessions(
    await listDefaultSessions("phase-4-issue-5254-sessions-before-resume"),
    "phase-4-issue-5254-session-before-resume-metadata",
    seedSessionId,
    ["--resume", seedSessionId, "-z", resumePrompt, "--pass-session-id", "--ignore-rules"],
    "phase-4-issue-5254-resume-oneshot",
    "phase-4-issue-5254-sessions-after-resume",
  );
  const continuePrompt = "Multiply seven by eight. Reply with only the integer.";
  await expectNoNewDefaultSessions(
    await listDefaultSessions("phase-4-issue-5254-sessions-before-continue"),
    "phase-4-issue-5254-session-before-continue-metadata",
    seedSessionId,
    ["-c", seedSessionId, "-z", continuePrompt],
    "phase-4-issue-5254-continue-oneshot",
    "phase-4-issue-5254-sessions-after-continue",
  );
  return { continuePrompt, resumePrompt, seedPrompt, seedSessionId };
}

export async function assertHermesCliAdapterLiveContract({
  env,
  host,
  redactionValues,
  sandbox,
  sandboxName,
}: HermesCliAdapterLiveOptions): Promise<void> {
  const runHermesCli = createHermesCliRunner({ env, redactionValues, sandbox, sandboxName });
  const listDefaultSessions = async (artifactName: string) =>
    hermesSessionIds(resultText(await runHermesCli(["sessions", "list"], artifactName, 60_000)));

  const { continuePrompt, resumePrompt, seedPrompt, seedSessionId } =
    await assertHermesFollowUpReplies({ env, redactionValues, sandbox, sandboxName });
  const exportPath = `/tmp/nemoclaw-issue-5254-${Date.now()}.jsonl`;
  await exportHermesSession(
    sandbox,
    sandboxName,
    seedSessionId,
    exportPath,
    [seedPrompt, resumePrompt, continuePrompt],
    {
      artifactName: "phase-4-issue-5254-export-session",
      env,
      redactionValues,
      timeoutMs: 60_000,
    },
  );

  const deleteSession = await host.command(
    "nemohermes",
    [sandboxName, "sessions", "delete", seedSessionId],
    {
      artifactName: "phase-4-issue-8301-delete-session",
      env,
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expect(deleteSession.exitCode, resultText(deleteSession)).toBe(0);
  const sessionsAfterDelete = await host.command("nemohermes", [sandboxName, "sessions", "list"], {
    artifactName: "phase-4-issue-8301-sessions-after-delete",
    env,
    redactionValues,
    timeoutMs: 60_000,
  });
  expect(sessionsAfterDelete.exitCode, resultText(sessionsAfterDelete)).toBe(0);
  expect(
    hermesSessionIds(resultText(sessionsAfterDelete)).has(seedSessionId),
    stripAnsi(resultText(sessionsAfterDelete)),
  ).toBe(false);

  const usageFilePath = `/tmp/nemoclaw-cli-adapter-usage-${Date.now()}.json`;
  const sessionsBeforeGuardedUsage = await listDefaultSessions(
    "phase-4-cli-adapter-sessions-before-guarded-usage",
  );
  const guardedUsage = await sandbox.exec(
    sandboxName,
    [
      "hermes",
      "--resume",
      seedSessionId,
      "-z",
      `N8011_${Date.now().toString(36)}_USAGE_GUARD`,
      "--usage-file",
      usageFilePath,
    ],
    {
      artifactName: "phase-4-cli-adapter-guarded-usage-file",
      env,
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expect(guardedUsage.exitCode, resultText(guardedUsage)).toBe(2);
  expect(resultText(guardedUsage)).toContain(
    "[COMPATIBILITY] Refusing resumed one-shot with --usage-file",
  );
  expect(
    [...(await listDefaultSessions("phase-4-cli-adapter-sessions-after-guarded-usage"))].sort(),
  ).toEqual([...sessionsBeforeGuardedUsage].sort());
  const guardedUsageFile = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`test ! -e ${shellQuote(usageFilePath)}`),
    {
      artifactName: "phase-4-cli-adapter-guarded-usage-file-absence",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(guardedUsageFile.exitCode, resultText(guardedUsageFile)).toBe(0);

  const profileName = "nemoclaw-cli-adapter-e2e";
  await runHermesCli(
    ["profile", "create", profileName],
    "phase-4-cli-adapter-create-named-profile",
    60_000,
  );
  const profileHome = `/sandbox/.hermes/profiles/${profileName}`;
  const prepareProfile = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        `test -d ${shellQuote(profileHome)}`,
        `install -m 600 /sandbox/.hermes/config.yaml ${shellQuote(`${profileHome}/config.yaml`)}`,
        `install -m 600 /sandbox/.hermes/.env ${shellQuote(`${profileHome}/.env`)}`,
      ].join(" && "),
    ),
    {
      artifactName: "phase-4-cli-adapter-prepare-named-profile",
      env,
      timeoutMs: 30_000,
    },
  );
  expect(prepareProfile.exitCode, resultText(prepareProfile)).toBe(0);

  const listProfileSessionsText = async (artifactName: string) =>
    resultText(
      await runHermesCli(["--profile", profileName, "sessions", "list"], artifactName, 60_000),
    );
  const listProfileSessions = async (artifactName: string) =>
    hermesSessionIds(await listProfileSessionsText(artifactName));
  const profileSessionsBeforeSeed = await listProfileSessions(
    "phase-4-cli-adapter-profile-sessions-before-seed",
  );
  const profileSeedPrompt = `N8011_${Date.now().toString(36)}_PROFILE_SEED`;
  await runHermesCli(
    ["--profile", profileName, "-z", profileSeedPrompt],
    "phase-4-cli-adapter-profile-seed-oneshot",
  );
  const profileSessionId = onlyNewHermesSessionId(
    profileSessionsBeforeSeed,
    await listProfileSessions("phase-4-cli-adapter-profile-sessions-after-seed"),
  );
  const profileSessionsBeforeContinue = await listProfileSessions(
    "phase-4-cli-adapter-profile-sessions-before-continue",
  );
  const profileContinuePrompt = `N8011_${Date.now().toString(36)}_PROFILE_CONTINUE`;
  await runHermesCli(
    ["--profile", profileName, "-c", "-z", profileContinuePrompt],
    "phase-4-cli-adapter-profile-continue-oneshot",
  );
  const profileSessionsAfterContinueText = await listProfileSessionsText(
    "phase-4-cli-adapter-profile-sessions-after-continue",
  );
  const profileSessionsAfterContinue = hermesSessionIds(profileSessionsAfterContinueText);
  expect(
    [...profileSessionsAfterContinue].filter((id) => !profileSessionsBeforeContinue.has(id)),
  ).toEqual([]);
  expect(
    profileSessionsAfterContinue.has(profileSessionId),
    stripAnsi(profileSessionsAfterContinueText),
  ).toBe(true);
  const profileSessionRow = stripAnsi(profileSessionsAfterContinueText)
    .split("\n")
    .find((line) => line.includes(profileSessionId));
  expect(profileSessionRow, stripAnsi(profileSessionsAfterContinueText)).toContain(
    profileContinuePrompt,
  );
}
