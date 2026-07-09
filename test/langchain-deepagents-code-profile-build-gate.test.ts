// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checkPath = path.join(repoRoot, "scripts", "check-dcode-profile-import-gate.sh");
const reviewedDockerfiles = [
  "agents/langchain-deepagents-code/Dockerfile.base",
  "test/Dockerfile.dcode-profile-missing-dependencies",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;
const unreviewedArgCases = [
  ...reviewedDockerfiles.map((dockerfile) => ({
    declaration: "ARG UNREVIEWED_SECRET",
    dockerfile,
    label: "uppercase directive",
  })),
  ...reviewedDockerfiles.map((dockerfile) => ({
    declaration: "arg UNREVIEWED_SECRET",
    dockerfile,
    label: "lowercase directive",
  })),
  {
    declaration: "ArG \\\n  UNREVIEWED_SECRET",
    dockerfile: reviewedDockerfiles[2],
    label: "mixed-case continued directive",
  },
] as const;

function runGateWithFakeDocker(
  mode: "expected-failure-with-marker" | "early-failure" | "success",
  mutateFixture: (fixtureRoot: string) => void = () => undefined,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-profile-import-gate-"));
  const fixtureRoot = path.join(tmp, "repo");
  const fixtureCheckPath = path.join(fixtureRoot, "scripts", path.basename(checkPath));
  const dockerPath = path.join(tmp, "docker");
  const callLog = path.join(tmp, "docker.log");
  fs.mkdirSync(path.dirname(fixtureCheckPath), { recursive: true });
  fs.copyFileSync(checkPath, fixtureCheckPath);
  for (const dockerfile of reviewedDockerfiles) {
    const fixturePath = path.join(fixtureRoot, dockerfile);
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, dockerfile), fixturePath);
  }
  mutateFixture(fixtureRoot);
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
case " $* " in
  *" --file agents/langchain-deepagents-code/Dockerfile "*)
    case "\${FAKE_DOCKER_MODE:?}" in
      expected-failure-with-marker)
        printf '%s\\n' NEMOCLAW_DCODE_PROFILE_IMPORT_GATE "ModuleNotFoundError: No module named 'deepagents'"
        exit 1
        ;;
      early-failure)
        printf '%s\\n' "production build failed before import gate"
        exit 1
        ;;
      success) exit 0 ;;
    esac
    ;;
esac
exit 0
`,
    "utf8",
  );
  fs.chmodSync(dockerPath, 0o755);
  try {
    const result = spawnSync("bash", [fixtureCheckPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: callLog,
        FAKE_DOCKER_MODE: mode,
        PATH: `${tmp}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    return { ...result, calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("LangChain Deep Agents Code profile build gate", () => {
  it.each(
    unreviewedArgCases,
  )("rejects an unreviewed ARG with $label in $dockerfile", (testCase) => {
    const result = runGateWithFakeDocker("expected-failure-with-marker", (fixtureRoot) =>
      fs.appendFileSync(path.join(fixtureRoot, testCase.dockerfile), `\n${testCase.declaration}\n`),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unreviewed ARG UNREVIEWED_SECRET in ${testCase.dockerfile}`);
    expect(result.calls).not.toContain("--file");
  });

  it("accepts only the expected production-build failure at the runtime marker", () => {
    const result = runGateWithFakeDocker("expected-failure-with-marker");

    expect(result.status, result.stderr).toBe(0);
    const markerIndex = result.stdout.indexOf("NEMOCLAW_DCODE_PROFILE_IMPORT_GATE");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(
      result.stdout.indexOf("ModuleNotFoundError: No module named 'deepagents'"),
    ).toBeGreaterThan(markerIndex);
    expect(result.stdout).toContain(
      "DCode profile import gate rejected a base missing deepagents and deepagents-code",
    );
    expect(result.calls).toContain("--file agents/langchain-deepagents-code/Dockerfile.base");
    expect(result.calls).toContain("--file test/Dockerfile.dcode-profile-missing-dependencies");
    expect(result.calls).toContain("--file agents/langchain-deepagents-code/Dockerfile");
    expect(result.calls).not.toContain(":latest");
    expect([...result.calls.matchAll(/--build-arg ([^ =]+)=/g)].map((match) => match[1])).toEqual([
      "BASE_IMAGE",
      "BASE_IMAGE",
    ]);
    const script = fs.readFileSync(checkPath, "utf8");
    const argGuard = "plain-progress build refuses unreviewed ARG";
    expect(script).toContain(argGuard);
    expect(script).toContain("docker build");
    expect(script.indexOf(argGuard)).toBeLessThan(script.indexOf("docker build"));
  });

  it("rejects a production build that unexpectedly succeeds", () => {
    const result = runGateWithFakeDocker("success");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DCode production image unexpectedly built without deepagents dependencies",
    );
  });

  it("rejects a failure before the runtime import marker", () => {
    const result = runGateWithFakeDocker("early-failure");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DCode build failed before reaching the profile import gate");
  });
});
