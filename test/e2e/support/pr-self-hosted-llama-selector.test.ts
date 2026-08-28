// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW_PATH = ".github/workflows/pr-self-hosted.yaml";
const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function workflow(): Workflow {
  return YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function genericGpuJobSteps() {
  return workflow().jobs["llama-cpp-generic-gpu"]?.steps ?? [];
}

function genericGpuManagerAndLiveScript() {
  const selectedStepNames = new Set([
    "Bind systemd user manager when available",
    "Run llama.cpp generic NVIDIA GPU live test",
  ]);
  return genericGpuJobSteps()
    .filter((step) => selectedStepNames.has(step.name ?? ""))
    .map(
      (step) => `${step.run ?? ""}
set -a
[ ! -s "$GITHUB_ENV" ] || . "$GITHUB_ENV"
set +a`,
    )
    .join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function replaceRequired(source: string, search: string, replacement: string) {
  const result = source.replaceAll(search, replacement);
  return result === source ? fail(`Workflow command is missing ${search}`) : result;
}

function writeCommand(directory: string, name: string, body: string) {
  const commandPath = join(directory, name);
  writeFileSync(commandPath, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return commandPath;
}

function selectGenericGpuLane(
  changedFiles: readonly string[],
  copiedSha = CANDIDATE_SHA,
  baseSha = BASE_SHA,
) {
  const value = workflow();
  const script = value.jobs["select-llama-cpp-generic-gpu"]?.steps?.find(
    (step) => step.name === "Select llama.cpp generic GPU E2E from PR files",
  )?.run;
  expect(script).toEqual(expect.any(String));

  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-generic-gpu-selector-"));
  const binDirectory = join(directory, "bin");
  const outputPath = join(directory, "github-output");
  const ghPath = join(binDirectory, "gh");
  mkdirSync(binDirectory);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${!#}" == "repos/NVIDIA/NemoClaw/pulls/8748" ]]; then
  printf '%s' "$PR_JSON"
else
  printf '%s' "$PR_FILES_JSON"
fi
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(outputPath, "");

  try {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script!],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "test-token",
          GITHUB_REF_NAME: "pull-request/8748",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          GITHUB_SHA: copiedSha,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          PR_FILES_JSON: JSON.stringify([changedFiles.map((filename) => ({ filename }))]),
          PR_JSON: JSON.stringify({
            number: 8748,
            base: { sha: baseSha },
            head: { sha: CANDIDATE_SHA },
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8").trim();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("generic NVIDIA GPU PR selection", () => {
  it.each([
    "scripts/install.sh",
    "src/lib/readiness/host.ts",
    "src/lib/readiness/onboard-admission.ts",
    "src/lib/onboard/fatal-runtime-preflight.ts",
    "src/lib/onboard/overlayfs-auto-fix.ts",
    "src/lib/onboard/preflight.ts",
  ])(
    "selects the generic NVIDIA GPU E2E job when %s can change installer readiness",
    (changedFile) => {
      expect(selectGenericGpuLane([changedFile])).toBe(`base_sha=${BASE_SHA}\nselected=true`);
    },
  );

  it("does not select the generic NVIDIA GPU E2E job for unrelated documentation", () => {
    expect(selectGenericGpuLane(["docs/get-started/quickstart.mdx"])).toBe(
      `base_sha=${BASE_SHA}\nselected=false`,
    );
  });

  it("rejects a copied branch whose commit does not match the current PR head", () => {
    expect(() => selectGenericGpuLane(["scripts/install.sh"], "b".repeat(40))).toThrow(
      "Copied PR branch SHA does not match the current PR head",
    );
  });

  it("binds the existing same-user manager before the live test without changing services", async () => {
    const directory = mkdtempSync("/tmp/nemoclaw-gpu-manager-");
    const binDirectory = join(directory, "bin");
    const runtimeDirectory = join(directory, "runtime");
    const busSocket = join(runtimeDirectory, "bus");
    const commandLog = join(directory, "commands.log");
    const githubEnv = join(directory, "github-env");
    mkdirSync(binDirectory);
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    writeFileSync(commandLog, "");
    writeFileSync(githubEnv, "");

    const idCommand = writeCommand(
      binDirectory,
      "id",
      `case "$1" in
  -u) printf '2000\\n' ;;
  -g) printf '2000\\n' ;;
  *) exit 97 ;;
esac`,
    );
    const statCommand = writeCommand(
      binDirectory,
      "stat",
      `case "$2" in
  %u:%g:%a) printf '2000:2000:700\\n' ;;
  %u) printf '2000\\n' ;;
  *) exit 97 ;;
esac`,
    );
    const systemctlCommand = writeCommand(
      binDirectory,
      "systemctl",
      `printf 'systemctl:%s\\n' "$*" >>"$COMMAND_LOG"
printf '%s\\n' "$CHILD_OUTPUT_SENTINEL"
printf '%s\\n' "$CHILD_OUTPUT_SENTINEL" >&2`,
    );
    const busctlCommand = writeCommand(
      binDirectory,
      "busctl",
      `printf 'busctl:%s\\n' "$*" >>"$COMMAND_LOG"
printf '%s\\n' "$CHILD_OUTPUT_SENTINEL"
printf '%s\\n' "$CHILD_OUTPUT_SENTINEL" >&2`,
    );
    writeCommand(binDirectory, "openshell", `printf 'openshell:%s\\n' "$*" >>"$COMMAND_LOG"`);
    writeCommand(
      binDirectory,
      "npx",
      `printf 'live:%s:%s\\n' "\${DBUS_SESSION_BUS_ADDRESS-unset}" "\${XDG_RUNTIME_DIR-unset}" >>"$COMMAND_LOG"`,
    );

    const sourceScript = genericGpuManagerAndLiveScript();
    const runtimeBoundScript = replaceRequired(
      sourceScript,
      'runtime_dir="/run/user/${uid}"',
      `runtime_dir=${JSON.stringify(runtimeDirectory)}`,
    );
    const commandBoundScript = [
      ["/usr/bin/id", idCommand],
      ["/usr/bin/stat", statCommand],
      ["/usr/bin/systemctl", systemctlCommand],
      ["/usr/bin/busctl", busctlCommand],
    ].reduce(
      (script, [command, replacement]) =>
        replaceRequired(script, command!, JSON.stringify(replacement)),
      runtimeBoundScript,
    );
    const server = createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(busSocket, () => resolve());
      });
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", commandBoundScript],
        {
          encoding: "utf8",
          env: {
            CHILD_OUTPUT_SENTINEL: "manager-output-secret",
            COMMAND_LOG: commandLog,
            DBUS_SESSION_BUS_ADDRESS: "inherited-secret-address",
            GITHUB_ENV: githubEnv,
            HOME: directory,
            PATH: binDirectory,
          },
        },
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("manager-output-secret");
      expect(readFileSync(githubEnv, "utf8")).toBe(`XDG_RUNTIME_DIR=${runtimeDirectory}\n`);
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "systemctl:--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager",
        "busctl:--user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager UnitPath",
        "openshell:--version",
        `live:unset:${runtimeDirectory}`,
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("preserves standalone qualification when the user manager runtime is absent (#9705)", () => {
    const directory = mkdtempSync("/tmp/nemoclaw-gpu-manager-absent-");
    const binDirectory = join(directory, "bin");
    const runtimeDirectory = join(directory, "missing-runtime");
    const commandLog = join(directory, "commands.log");
    const githubEnv = join(directory, "github-env");
    mkdirSync(binDirectory);
    writeFileSync(commandLog, "");
    writeFileSync(githubEnv, "");

    const idCommand = writeCommand(
      binDirectory,
      "id",
      `case "$1" in
  -u) printf '2000\\n' ;;
  -g) printf '2000\\n' ;;
  *) exit 97 ;;
esac`,
    );
    writeCommand(binDirectory, "openshell", `printf 'openshell:%s\\n' "$*" >>"$COMMAND_LOG"`);
    writeCommand(
      binDirectory,
      "npx",
      `printf 'live:%s:%s\\n' "\${DBUS_SESSION_BUS_ADDRESS-unset}" "\${XDG_RUNTIME_DIR-unset}" >>"$COMMAND_LOG"`,
    );

    const runtimeBoundScript = replaceRequired(
      genericGpuManagerAndLiveScript(),
      'runtime_dir="/run/user/${uid}"',
      `runtime_dir=${JSON.stringify(runtimeDirectory)}`,
    );
    const commandBoundScript = replaceRequired(runtimeBoundScript, "/usr/bin/id", idCommand);

    try {
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", commandBoundScript],
        {
          encoding: "utf8",
          env: {
            COMMAND_LOG: commandLog,
            DBUS_SESSION_BUS_ADDRESS: "inherited-secret-address",
            GITHUB_ENV: githubEnv,
            HOME: directory,
            PATH: binDirectory,
            XDG_RUNTIME_DIR: "/untrusted/ambient/runtime",
          },
        },
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(githubEnv, "utf8")).toBe("XDG_RUNTIME_DIR=\n");
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "openshell:--version",
        "live:unset:unset",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a PR whose base SHA is not a lowercase 40-character SHA", () => {
    expect(() => selectGenericGpuLane(["scripts/install.sh"], CANDIDATE_SHA, "main")).toThrow();
  });

  // source-shape-contract: security -- The copied PR workflow must run the publication verifier from the validated PR base before the generic GPU job receives its managed-image revision
  it("binds trusted base publication to the generic NVIDIA GPU job", () => {
    const value = workflow();
    const selector = value.jobs["select-llama-cpp-generic-gpu"];

    expect(selector?.permissions).toEqual({ actions: "read", contents: "read" });
    expect(selector?.outputs).toMatchObject({
      base_sha: "${{ steps.changed.outputs.base_sha }}",
      managed_image_revision: "${{ steps.publication.outputs.head_sha }}",
    });

    const checkout = selector?.steps?.find(
      (step) => step.name === "Check out PR base SHA for publication verification",
    );
    expect(checkout).toMatchObject({
      if: "${{ steps.changed.outputs.selected == 'true' }}",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ steps.changed.outputs.base_sha }}",
      },
    });

    const publication = selector?.steps?.find((step) => step.id === "publication");
    expect(publication).toMatchObject({
      env: {
        EXPECTED_SHA: "${{ steps.changed.outputs.base_sha }}",
        GITHUB_TOKEN: "${{ github.token }}",
        REQUIRE_MANAGED_IMAGE_PUBLICATION: "1",
      },
      if: "${{ steps.changed.outputs.selected == 'true' }}",
    });
    expect(publication?.run).toContain("export GITHUB_REF=refs/heads/main");
    expect(publication?.run).toContain('export GITHUB_SHA="$EXPECTED_SHA"');
    expect(publication?.run).toContain(
      "node --experimental-strip-types --no-warnings tools/e2e/base-image-publication.mts --wait-seconds 3000 --poll-seconds 30",
    );

    expect(value.jobs["llama-cpp-generic-gpu"]?.env?.E2E_MANAGED_IMAGE_REVISION).toBe(
      "${{ needs.select-llama-cpp-generic-gpu.outputs.managed_image_revision }}",
    );
  });
});
