// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

export const COMPILED_ARTIFACT_SHA = "a".repeat(40);
const temporaryRoots: string[] = [];
export function cleanupCompiledArtifactFixtures(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
}

export function createCompiledArtifactFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "compiled-artifact-"));
  temporaryRoots.push(root);
  for (const file of [
    "dist/nemoclaw.js",
    "dist/lib/blueprint-runner.js",
    "dist/nemoclaw/blueprint/runner.js",
    "nemoclaw/dist/index.js",
    "nemoclaw/dist/shared/sandbox-name.cjs",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export {};\n");
  }
  writeFileSync(
    join(root, "dist/build-identity.json"),
    JSON.stringify({ sourceRevision: COMPILED_ARTIFACT_SHA }),
  );
  return root;
}

// Execute the composite's shell steps; only GitHub cache, setup-node, and npm
// are replaced at their external boundaries. This exercises the actual gates.
export function runCompiledArtifactPreparation(
  cacheHit: boolean,
  event = "pull_request",
  corrupt = false,
) {
  const root = createCompiledArtifactFixture();
  const template = createCompiledArtifactFixture();
  const bin = join(root, "tools");
  mkdirSync(bin);
  const log = join(root, "commands");
  writeFileSync(join(root, "dist/stale"), "old output");
  if (corrupt) writeFileSync(join(root, "dist/build-identity.json"), '{"sourceRevision":"wrong"}');
  for (const [name, body] of Object.entries({
    git: 'printf "%s\\n" "$TEST_SOURCE_SHA"',
    bash: 'printf "install\\n" >> "$TEST_COMMAND_LOG"',
    npm: 'printf "%s\\n" "$*" >> "$TEST_COMMAND_LOG"\nif [ "$*" = "run build:cli" ]; then cp -R "$TEST_TEMPLATE/dist" "$TEST_TEMPLATE/nemoclaw" "$GITHUB_WORKSPACE/"; fi',
  }))
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  const actionPath = resolve(".github/actions/ci-compile-artifacts");
  const action = YAML.parse(readFileSync(join(actionPath, "action.yaml"), "utf8")) as {
    runs: {
      steps: Array<{
        id?: string;
        name: string;
        if?: string;
        run?: string;
        uses?: string;
        env?: Record<string, string>;
      }>;
    };
  };
  const outputs: Record<string, Record<string, string>> = {};
  const value = (reference: string) => {
    const [, step, , field] = reference.split(".");
    return outputs[step]?.[field] ?? "";
  };
  const enabled = (condition?: string): boolean => {
    if (!condition || condition === "always()") return true;
    return condition.split(" && ").every((clause) => {
      const match = /^(steps\.[\w-]+\.outputs\.[\w-]+) (==|!=) '([^']*)'$/.exec(clause);
      if (!match) throw new Error(`Unsupported action condition: ${clause}`);
      return match[2] === "==" ? value(match[1]) === match[3] : value(match[1]) !== match[3];
    });
  };
  let saved = 0;
  let restored = 0;
  let failure = "";
  for (const [index, step] of action.runs.steps.entries()) {
    if (!enabled(step.if) || (failure && step.if !== "always()")) continue;
    if (step.uses?.startsWith("actions/setup-node@")) continue;
    if (step.uses?.startsWith("actions/cache/restore@")) {
      restored++;
      outputs[step.id!] = { "cache-hit": String(cacheHit) };
      continue;
    }
    if (step.uses?.startsWith("actions/cache/save@")) {
      saved++;
      continue;
    }
    if (!step.run) throw new Error(`Unexpected action step: ${step.name}`);
    const output = join(root, `step-${index}`);
    const stepEnv = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, input]) => [
        key,
        input
          .replace(/\$\{\{ (steps\.[\w-]+\.outputs\.[\w-]+) \}\}/g, (_, reference: string) =>
            value(reference),
          )
          .replace("${{ job.status }}", failure ? "failure" : "success"),
      ]),
    );
    const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        ...stepEnv,
        NODE_AUTH_TOKEN: "",
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_WORKSPACE: root,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: event === "pull_request" ? "refs/pull/123/merge" : "refs/heads/main",
        GITHUB_SHA: "b".repeat(40),
        TEST_SOURCE_SHA: COMPILED_ARTIFACT_SHA,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        TEST_TEMPLATE: template,
        TEST_COMMAND_LOG: log,
      },
    });
    if (result.status !== 0) {
      failure ||= result.stderr || result.stdout || `Step "${step.name}" exited ${result.status}`;
      continue;
    }
    if (step.id && existsSync(output))
      outputs[step.id] = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
  }
  return {
    root,
    failure,
    saved,
    restored,
    outputs,
    summary: readFileSync(join(root, "summary"), "utf8"),
    commands: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}
