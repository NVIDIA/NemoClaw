// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWindowsInstallerWorkflowSources } from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidencePowerShell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
export const skipEvidenceProcesses =
  process.platform !== "win32" &&
  spawnSync(evidencePowerShell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
  }).status !== 0;

function command(job: string, name: string): string {
  const entry = readWindowsInstallerWorkflowSources(repoRoot).workflow.jobs[job].steps?.find(
    (item) => item.name === name,
  );
  if (typeof entry?.run !== "string") throw new Error("Missing executable workflow step: " + name);
  return entry.run;
}
export const revision = "a".repeat(40);
export const base = "b".repeat(40);
const request = {
  number: 12014,
  state: "open",
  base: { ref: "main", sha: base, repo: { full_name: "NVIDIA/NemoClaw" } },
  head: {
    ref: "codex/candidate",
    sha: revision,
    repo: { full_name: "NVIDIA/NemoClaw", owner: { login: "NVIDIA", type: "Organization" } },
  },
};
export type CandidateCase = {
  name: string;
  accepted?: boolean;
  environment?: Record<string, string>;
  change?: (pr: typeof request) => void;
  secondChange?: (pr: typeof request) => void;
  actorPermission?: string;
  triggeringPermission?: string;
  apiFailure?: boolean;
};
export const candidateCases: CandidateCase[] = [
  { name: "exact Hermes candidate", accepted: true },
  {
    name: "exact OpenClaw candidate",
    accepted: true,
    environment: { SELECTED_AGENT: "openclaw" },
  },
  { name: "wrong repository", environment: { CANDIDATE_REPOSITORY: "other/NemoClaw" } },
  { name: "invalid PR", environment: { PR_NUMBER: "12014\nother=1" } },
  { name: "wrong event source", environment: { EVENT_SHA: base } },
  { name: "wrong workflow source", environment: { EVENT_WORKFLOW_SHA: base } },
  { name: "wrong expected controller", environment: { EXPECTED_WORKFLOW_SHA: base } },
  { name: "wrong branch", environment: { EVENT_REF: "refs/heads/other" } },
  {
    name: "main branch",
    environment: { EVENT_REF: "refs/heads/main" },
    change: (pr) => {
      pr.head.ref = "main";
    },
  },
  { name: "unsupported agent", environment: { SELECTED_AGENT: "pi" } },
  { name: "credentialed scope", environment: { VALIDATION_SCOPE: "full-acceptance" } },
  {
    name: "output injection",
    environment: { PRODUCT_VERSION: "0.1.10\ncredential_authorized=true" },
  },
  ...["PROTECTED_REQUEST", "OTHER_COMPONENTS", "OTHER_PROFILE", "OTHER_RUNTIME"].map((key) => ({
    name: "mixed " + key,
    environment: { [key]: "true" },
  })),
  { name: "legacy replay", environment: { DIAGNOSTIC_SOURCE_RUN: "34555046495" } },
  {
    name: "closed PR",
    change: (pr) => {
      pr.state = "closed";
    },
  },
  {
    name: "wrong remote PR",
    change: (pr) => {
      pr.number = 1;
    },
  },
  {
    name: "fork head",
    change: (pr) => {
      pr.head.repo.full_name = "other/NemoClaw";
    },
  },
  {
    name: "nonorganization owner",
    change: (pr) => {
      pr.head.repo.owner.type = "User";
    },
  },
  {
    name: "wrong base",
    change: (pr) => {
      pr.base.sha = revision;
    },
  },
  {
    name: "wrong remote head",
    change: (pr) => {
      pr.head.sha = base;
    },
  },
  { name: "read-only actor", actorPermission: "read" },
  { name: "triage rerunner", triggeringPermission: "triage" },
  { name: "remote access failure", apiFailure: true },
  {
    name: "head changes during admission",
    secondChange: (pr) => {
      pr.head.sha = base;
    },
  },
  {
    name: "base changes during admission",
    secondChange: (pr) => {
      pr.base.sha = revision;
    },
  },
  {
    name: "PR closes during admission",
    secondChange: (pr) => {
      pr.state = "closed";
    },
  },
];

export function runCandidateAdmission(scenario: CandidateCase) {
  const root = mkdtempSync(join(tmpdir(), "windows-candidate-admission-"));
  try {
    const first = structuredClone(request);
    scenario.change?.(first);
    const second = structuredClone(first);
    scenario.secondChange?.(second);
    const fixture = join(root, "responses.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        first,
        second,
        actor: scenario.actorPermission ?? "write",
        rerunner: scenario.triggeringPermission ?? "maintain",
        fail: scenario.apiFailure ?? false,
      }),
    );
    // Only this inert local responder is on the test's gh path. It does not
    // authenticate or contact GitHub, execute a payload, or set GITHUB_ACTIONS.
    writeFileSync(
      join(root, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.env.REQUEST_FIXTURE, 'utf8'));
if (input.fail) process.exit(1);
const args = process.argv.slice(2);
const route = args[1];
if (args[0] !== 'api') process.exit(2);
if (route === 'repos/NVIDIA/NemoClaw/pulls/12014' && args.length === 2) {
  const count = fs.existsSync(process.env.CALL_STATE) ? 1 : 0;
  fs.writeFileSync(process.env.CALL_STATE, 'read');
  process.stdout.write(JSON.stringify(count ? input.second : input.first));
} else if (args.length === 4 && args[2] === '--jq' && args[3] === '.permission' && route === 'repos/NVIDIA/NemoClaw/collaborators/actor/permission') {
  process.stdout.write(input.actor);
} else if (args.length === 4 && args[2] === '--jq' && args[3] === '.permission' && route === 'repos/NVIDIA/NemoClaw/collaborators/rerunner/permission') {
  process.stdout.write(input.rerunner);
} else process.exit(3);
`,
      { mode: 0o700 },
    );
    const output = join(root, "outputs");
    const script = command(
      "windows-finished-request",
      "Admit an exact credential-free candidate build",
    );
    const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
        REQUEST_FIXTURE: fixture,
        CALL_STATE: join(root, "calls"),
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        PR_NUMBER: "12014",
        CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
        CANDIDATE_SHA: revision,
        BASE_SHA: base,
        EXPECTED_WORKFLOW_SHA: revision,
        EVENT_SHA: revision,
        EVENT_WORKFLOW_SHA: revision,
        EVENT_REF: "refs/heads/codex/candidate",
        SELECTED_AGENT: "hermes",
        PRODUCT_VERSION: "0.1.10",
        VALIDATION_SCOPE: "build-only",
        ACTOR: "actor",
        TRIGGERING_ACTOR: "rerunner",
        PROTECTED_REQUEST: "false",
        OTHER_COMPONENTS: "false",
        OTHER_PROFILE: "false",
        OTHER_RUNTIME: "false",
        DIAGNOSTIC_SOURCE_RUN: "",
        ...scenario.environment,
      },
    });

    return {
      result,
      outputExists: existsSync(output),
      fields: existsSync(output)
        ? Object.fromEntries(
            readFileSync(output, "utf8")
              .trim()
              .split("\n")
              .map((line) => line.split("=")),
          )
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export const nativeTransferCases = [
  "complete",
  "failed-proof",
  "wrong-source",
  "legacy-proof",
  "cleanup-failed",
  "retained-root",
  "failed-runner",
  "existing-transfer",
] as const;
export function runNativeTransfer(scenario: (typeof nativeTransferCases)[number]) {
  const root = mkdtempSync(join(tmpdir(), "windows-native-bash-transfer-"));
  const evidence = join(root, "finished-bash-evidence");
  const transfer = join(root, "finished-windows-bash-transfer");
  const revision = "a".repeat(40);
  const proof = {
    schemaVersion: scenario === "legacy-proof" ? 1 : 2,
    classification: "small-msys-native-basecontainer-compatibility-proof",
    sourceRevision: scenario === "wrong-source" ? "b".repeat(40) : revision,
    passed: scenario !== "failed-proof",
    normalCleanup: scenario !== "cleanup-failed",
  };
  const runner = {
    sourceRevision: revision,
    status: scenario === "failed-runner" ? "failed" : "pass",
    cleanup: {
      workRootRemoved: true,
      workRetainedForUnconfirmedExecutor: scenario === "retained-root",
    },
  };
  const retained = new Map([
    ["result.json", JSON.stringify(proof)],
    ["runner-result.json", JSON.stringify(runner)],
    ["compatibility-build/build-receipt.json", "{}"],
    ["compatibility-build/NemoClawMsysCompat-arm64.dll", "inert-compatibility-fixture"],
    ["mxc-token-inspection-build/wxc-exec.exe", "inert-executor-fixture"],
    ["mxc-token-inspection-build/mxc-token-inspection-build.json", "{}"],
    ["derived-aslr/derivation.json", "{}"],
    ["d-mxc.log", "inert-host-log-fixture"],
    ["node/build-receipt.json", "{}"],
  ]);
  const excluded = [
    "downloads/archive.exe",
    "build/intermediate.obj",
    "compatibility-build/build/intermediate.obj",
    "mxc-token-inspection-build/build/source.rs",
    "node/node.exe",
    "node/archive.zip",
  ];
  try {
    for (const [relative, content] of [
      ...retained,
      ...excluded.map((relative): [string, string] => [relative, "excluded-fixture"]),
    ]) {
      const file = join(evidence, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    if (scenario === "existing-transfer") mkdirSync(transfer);
    const program = command(
      "windows-bash-compatibility-reuse",
      "Seal same-run exact-input Bash evidence",
    ).replace("& current/scripts/checks/windows-native-transfer.ps1", "& $env:TRANSFER_SCRIPT");
    const script = join(root, "seal.ps1");
    writeFileSync(
      script,
      "$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n" + program,
    );
    const output = join(root, "github-output");
    const result = spawnSync(
      evidencePowerShell,
      ["-NoProfile", "-NonInteractive", "-File", script],
      {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          CANDIDATE_SHA: revision,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_OUTPUT: output,
          TRANSFER_SCRIPT: join(repoRoot, "scripts/checks/windows-native-transfer.ps1"),
        },
      },
    );

    const manifestPath = join(transfer, "transfer-manifest.json");
    return {
      result,
      revision,
      manifestText: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
      outputText: existsSync(output) ? readFileSync(output, "utf8") : null,
      retained: [...retained],
      originalContents: [
        ...retained,
        ...excluded.map((relative): [string, string] => [relative, "excluded-fixture"]),
      ],
      sourceContents: [...retained.keys(), ...excluded].map((relative) => [
        relative,
        readFileSync(join(evidence, relative), "utf8"),
      ]),
      transferredContents: [...retained.keys()].map((relative) => {
        const file = join(transfer, "native-proof/bash-compat-evidence", relative);
        return [relative, existsSync(file) ? readFileSync(file, "utf8") : null];
      }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
