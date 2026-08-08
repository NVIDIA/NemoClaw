// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

export type ReleaseQualificationFixture = {
  baseSha: string;
  contract: Record<string, unknown>;
  mockBin: string;
  mockApiRoot: string;
  planPath: string;
  receiptPath: string;
  remote: string;
  root: string;
  targetSha: string;
  work: string;
};

export function releaseQualificationEnv(
  fixture?: ReleaseQualificationFixture,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) result[key] = value;
  }
  const environment: NodeJS.ProcessEnv = {
    ...result,
    GIT_AUTHOR_NAME: "Release Gate Test",
    GIT_AUTHOR_EMAIL: "release-gate@example.com",
    GIT_COMMITTER_NAME: "Release Gate Test",
    GIT_COMMITTER_EMAIL: "release-gate@example.com",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    NODE_OPTIONS: "",
  };
  return {
    ...environment,
    ...(fixture
      ? {
          PATH: `${fixture.mockBin}:${environment.PATH ?? ""}`,
          NEMOCLAW_QUALIFICATION_TEST_API_ROOT: fixture.mockApiRoot,
          NEMOCLAW_QUALIFICATION_TEST_REAL_GIT: REAL_GIT,
          NEMOCLAW_QUALIFICATION_TEST_REMOTE: fixture.remote,
          NEMOCLAW_QUALIFICATION_TEST_WORK: fixture.work,
        }
      : {}),
    ...extra,
  };
}

export function runReleaseQualificationCommand(cwd: string, args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: "utf8",
    env: releaseQualificationEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function writeReleasePlan(planPath: string, targetSha: string): void {
  const planWithoutHash = {
    schemaVersion: 1,
    mode: "tag-only",
    previousTag: "v0.0.1",
    nextTag: "v0.0.2",
    originMainCommit: targetSha,
    confirmationPhrase: `CONFIRM RELEASE v0.0.2 ${targetSha}`,
  };
  const planHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(planWithoutHash, null, 2))
    .digest("hex");
  fs.writeFileSync(planPath, `${JSON.stringify({ ...planWithoutHash, planHash }, null, 2)}\n`);
}
