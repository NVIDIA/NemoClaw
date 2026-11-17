// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { readApprovedOpenShellSdkConfig } from "../../scripts/checks/candidate-openshell-sdk.mts";
import { vi } from "vitest";
import YAML from "yaml";

export const sdkCandidateIdentity = {
  prNumber: 123,
  candidateSha: "a".repeat(40),
  baseSha: "b".repeat(40),
};

export function candidateSdkFixture() {
  const bytes = Buffer.from("inert candidate SDK archive fixture");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const trustedSource = readFileSync("ci/reviewed-npm-audit.json", "utf8");
  const trusted = JSON.parse(trustedSource);
  const sdk = {
    artifactName: "nvidia-openshell-sdk-9.8.7.tgz",
    packageSpec: "@nvidia/openshell-sdk@9.8.7",
    label: "OpenShell TypeScript SDK 9.8.7",
    integrity,
    tarballUrl: `https://npm.pkg.github.com/download/@nvidia/openshell-sdk/9.8.7/${"c".repeat(40)}`,
  };
  const manifest = { optionalDependencies: { "@nvidia/openshell-sdk": "9.8.7" } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/@nvidia/openshell-sdk": {
        version: "9.8.7",
        resolved: sdk.tarballUrl,
        integrity,
        dependencies: { "sdk-helper": "1.0.0" },
      },
      "node_modules/sdk-helper": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/sdk-helper/-/sdk-helper-1.0.0.tgz",
        integrity,
      },
    },
  };
  const config = { ...trusted, sourceRegistryPackage: sdk };
  delete config.sourceRegistryPackageReplacement;
  const sources: Record<string, string> = {
    "ci/reviewed-npm-audit.json": JSON.stringify(config),
    "package.json": JSON.stringify(manifest),
    "nemoclaw/package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify(lock),
    "nemoclaw/package-lock.json": JSON.stringify(lock),
  };
  const repository = { full_name: "NVIDIA/NemoClaw" };
  const pr = {
    number: 123,
    state: "open",
    user: { login: "author" },
    head: { sha: sdkCandidateIdentity.candidateSha, repo: repository },
    base: { sha: sdkCandidateIdentity.baseSha, ref: "main", repo: repository },
  };
  const approval = {
    id: 50,
    user: { login: "reviewer", type: "User" },
    submitted_at: "2026-10-14T00:00:00Z",
    state: "APPROVED",
    commit_id: sdkCandidateIdentity.candidateSha,
  };
  const records = [approval];
  const permission = { role_name: "maintain" };
  const request = vi.fn(async (route: string): Promise<unknown> => {
    if (route.endsWith("/pulls/123")) return pr;
    if (
      route ===
      `/repos/NVIDIA/NemoClaw/compare/${sdkCandidateIdentity.baseSha}...${sdkCandidateIdentity.candidateSha}?per_page=1`
    )
      return {
        status: "ahead",
        base_commit: { sha: sdkCandidateIdentity.baseSha },
        merge_base_commit: { sha: sdkCandidateIdentity.baseSha },
        files: [],
      };
    if (route.endsWith("/permission")) return permission;
    if (route.includes("/reviews?")) return records;
    const match = /^\/repos\/NVIDIA\/NemoClaw\/contents\/(.+)\?ref=([a-f0-9]{40})$/u.exec(route);
    if (!match || match[2] !== sdkCandidateIdentity.candidateSha || !sources[match[1]!]) {
      throw new Error("Unexpected SDK fixture request");
    }
    const source = sources[match[1]!]!;
    return {
      type: "file",
      path: match[1],
      encoding: "base64",
      size: Buffer.byteLength(source),
      content: Buffer.from(source).toString("base64"),
    };
  });
  const change = (file: string, mutate: (value: any) => void) => {
    const value = JSON.parse(sources[file]!);
    mutate(value);
    sources[file] = JSON.stringify(value);
  };
  return { bytes, trusted, trustedSource, sdk, sources, pr, records, permission, request, change };
}

export function candidateSdkCheckout(
  root: string,
  fixture: ReturnType<typeof candidateSdkFixture>,
) {
  for (const [file, source] of Object.entries(fixture.sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const artifactDirectory = join(root, "artifacts");
  const cacheDirectory = join(root, "cache");
  mkdirSync(artifactDirectory);
  mkdirSync(cacheDirectory);
  writeFileSync(join(artifactDirectory, fixture.sdk.artifactName), fixture.bytes);
  return { mode: "artifact" as const, artifactDirectory, cacheDirectory, targetRoot: root };
}

export function afterCandidateSdkRead(
  fixture: ReturnType<typeof candidateSdkFixture>,
  change: () => void,
) {
  let pullReads = 0;
  return async (route: string) => {
    if (route.endsWith("/pulls/123")) pullReads += 1;
    if (pullReads === 3 && route.endsWith("/pulls/123")) change();
    return fixture.request(route);
  };
}

export function candidateSdkMergeFixture(root: string) {
  const f = candidateSdkFixture();
  const mergeSha = "c".repeat(40);
  const pr = Object.assign(f.pr, { merge_commit_sha: mergeSha });
  const sources = Object.fromEntries(
    Object.entries(f.sources).map(([path, source]) => [
      path,
      path === "ci/reviewed-npm-audit.json"
        ? source
        : JSON.stringify({ ...JSON.parse(source), description: "A change from the approved base" }),
    ]),
  );
  const preparation = candidateSdkCheckout(root, { ...f, sources });
  const commit = {
    sha: mergeSha,
    parents: [{ sha: sdkCandidateIdentity.baseSha }, { sha: sdkCandidateIdentity.candidateSha }],
  };
  const request = async (route: string): Promise<unknown> => {
    if (route.endsWith(`/git/commits/${mergeSha}`)) return commit;
    if (route.endsWith(`?ref=${mergeSha}`)) {
      const path = route.split("/contents/")[1]!.split("?")[0]!;
      const source = sources[path]!;
      return {
        type: "file",
        path,
        encoding: "base64",
        size: Buffer.byteLength(source),
        content: Buffer.from(source).toString("base64"),
      };
    }
    return f.request(route);
  };
  const writeMerged = (path: string, source: string) => {
    sources[path] = source;
    writeFileSync(join(root, path), source);
  };
  return {
    ...f,
    pr,
    preparation,
    sources,
    request: vi.fn(request),
    commit,
    identity: { ...sdkCandidateIdentity, mergeSha },
    writeMerged,
    stage: vi.fn(),
  };
}

export function sparseSdkWorkflowCheckout(root: string, workflowPath: string, job: string) {
  const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
  const checkouts = workflow.jobs[job].steps.filter(
    (step: { with?: Record<string, string> }) => step.with?.["sparse-checkout"],
  );
  for (const checkout of checkouts) {
    for (const entry of checkout.with["sparse-checkout"].trim().split(/\s+/u)) {
      mkdirSync(dirname(join(root, entry)), { recursive: true });
      cpSync(entry, join(root, entry), { recursive: true });
    }
  }
}

export function candidateSdkLocatorFixture(
  root: string,
  mode: "candidate" | "trusted" = "candidate",
) {
  const f = candidateSdkFixture();
  const trustedIdentities = [
    f.trusted.sourceRegistryPackage,
    f.trusted.sourceRegistryPackageReplacement,
  ]
    .filter(Boolean)
    .map((identity) =>
      Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))),
    );
  const bundleName =
    mode === "candidate"
      ? `candidate-openshell-sdk-123-${sdkCandidateIdentity.candidateSha}-${sdkCandidateIdentity.baseSha}-50`
      : `reviewed-openshell-sdk-${createHash("sha256")
          .update(`${JSON.stringify(trustedIdentities)}\n`)
          .digest("hex")}`;
  const decision = {
    required: true,
    candidate: mode === "candidate" ? true : undefined,
    artifactName:
      mode === "candidate" ? f.sdk.artifactName : f.trusted.sourceRegistryPackage.artifactName,
    bundleName,
  };
  const artifact = {
    name: bundleName,
    id: 42,
    expired: false,
    workflow_run: {
      id: 44,
      head_branch: mode === "candidate" ? "upgrade" : "main",
      head_repository_id: 888,
    },
  };
  const run = {
    path:
      mode === "candidate"
        ? ".github/workflows/candidate-upgrade-admission.yaml"
        : ".github/workflows/main.yaml",
    head_sha: sdkCandidateIdentity.candidateSha,
    head_branch: mode === "candidate" ? "upgrade" : "main",
    pull_requests: [
      {
        number: sdkCandidateIdentity.prNumber,
        head: { sha: sdkCandidateIdentity.candidateSha },
        base: { sha: sdkCandidateIdentity.baseSha },
      },
    ],
    event: mode === "candidate" ? "pull_request_target" : "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "NVIDIA/NemoClaw" },
    head_repository: { full_name: "NVIDIA/NemoClaw" },
  };
  const bin = join(root, "bin");
  const trusted = join(root, ".trusted-sdk-package-decision");
  mkdirSync(bin);
  mkdirSync(join(trusted, "scripts/checks"), { recursive: true });
  mkdirSync(join(trusted, "ci"));
  writeFileSync(join(trusted, "ci/reviewed-npm-audit.json"), f.trustedSource);
  writeFileSync(
    join(trusted, "scripts/checks/prepare-ci-npm-install.mts"),
    "process.stdout.write(process.env.SDK_LOCATOR_DECISION);\n",
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const route = process.argv.find(value => value.startsWith('repos/'));
if (route?.includes('/actions/artifacts?')) process.stdout.write(process.env.SDK_LOCATOR_ARTIFACTS);
else if (route?.endsWith('/actions/runs/44')) process.stdout.write(process.env.SDK_LOCATOR_RUN);
else process.exit(97);
`,
  );
  chmodSync(join(bin, "gh"), 0o700);
  const workflow = YAML.parse(readFileSync(".github/workflows/pr.yaml", "utf8"));
  const script = workflow.jobs["openshell-sdk-package"].steps.find(
    (step: { id?: string }) => step.id === "locate",
  ).run;
  const output = join(root, "outputs");
  return {
    artifact,
    run,
    decision,
    execute: () => {
      const result = spawnSync("bash", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: root,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          HEAD_REPOSITORY: "NVIDIA/NemoClaw",
          REPOSITORY_ID: "888",
          CANDIDATE_SHA: sdkCandidateIdentity.candidateSha,
          UPGRADE_BASE_SHA: sdkCandidateIdentity.baseSha,
          UPGRADE_PR_NUMBER: String(sdkCandidateIdentity.prNumber),
          SDK_LOCATOR_DECISION: JSON.stringify(decision),
          SDK_LOCATOR_ARTIFACTS: JSON.stringify([{ artifacts: [artifact] }]),
          SDK_LOCATOR_RUN: JSON.stringify(run),
        },
      });
      return { ...result, output: existsSync(output) ? readFileSync(output, "utf8") : "" };
    },
  };
}

export type SdkAuditScenario =
  | "admitted"
  | "missing-token"
  | "missing-pr"
  | "missing-candidate"
  | "missing-base";

/** Run the real audit controller with synthetic admission responses and an observed npm child. */
export async function runCandidateSdkAuditAction(scenario: SdkAuditScenario = "admitted") {
  const sdkAuditRepoRoot = resolve(import.meta.dirname, "../..");
  const fixture = candidateSdkFixture();
  const responses: Record<string, unknown> = {};
  await readApprovedOpenShellSdkConfig(
    sdkCandidateIdentity,
    async (route) => {
      const value = await fixture.request(route);
      responses[route] = value;
      return value;
    },
    fixture.trustedSource,
  );
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-admitted-audit-entry-"));
  try {
    candidateSdkCheckout(root, fixture);
    const observation = join(root, "npm-observation.json");
    const bootstrap = join(root, "bootstrap.mjs");
    const selectedEntrypointFile = join(root, "selected-entrypoint");
    const actionDirectory = join(sdkAuditRepoRoot, ".github/actions/ci-reviewed-npm-audit");
    const action = YAML.parse(
      readFileSync(
        join(sdkAuditRepoRoot, ".github/actions/ci-reviewed-npm-audit/action.yaml"),
        "utf8",
      ),
    ) as {
      runs: { steps: { name: string; run?: string; env?: Record<string, string> }[] };
    };
    const inputs: Record<string, string> = {
      "sdk-admission-token": scenario === "missing-token" ? "" : "fixture-api-token",
      "sdk-admission-pr-number":
        scenario === "missing-pr" ? "" : String(sdkCandidateIdentity.prNumber),
      "sdk-admission-candidate-sha":
        scenario === "missing-candidate" ? "" : sdkCandidateIdentity.candidateSha,
      "sdk-admission-base-sha": scenario === "missing-base" ? "" : sdkCandidateIdentity.baseSha,
      "target-root": root,
      "report-dir": "reports",
      "cache-directory": "",
    };
    const controller = action.runs.steps.find(
      (step) => step.name === "Materialize and audit production dependency graphs",
    )!;
    const actionEnvironment = Object.fromEntries(
      Object.entries(controller.env!).map(([name, value]) => [
        name,
        value.replace(
          /\$\{\{ inputs\.([\w-]+) \}\}/gu,
          (_match, input: string) => inputs[input] ?? "",
        ),
      ]),
    );
    writeFileSync(
      bootstrap,
      [
        'import fs from "node:fs";',
        'import childProcess from "node:child_process";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const responses = ${JSON.stringify(responses)};`,
        "globalThis.fetch = async (input, options) => {",
        "const url = new URL(input); const value = responses[url.pathname + url.search];",
        'if (url.origin !== "https://api.github.com" || value === undefined || options.headers.Authorization !== "Bearer fixture-api-token") return new Response("denied", { status: 403 });',
        "return new Response(JSON.stringify(value), { status: 200 }); };",
        "childProcess.spawnSync = (command, args, options) => {",
        `fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ command, args, github: options.env.GITHUB_TOKEN ?? null, gh: options.env.GH_TOKEN ?? null }));`,
        // A deliberate version mismatch stops before package installs or registry access.
        'return { status: 0, stdout: "0.0.0", stderr: "" }; }; syncBuiltinESMExports();',
        `Object.defineProperty(process, "version", { value: ${JSON.stringify(`v${fixture.trusted.nodeVersion}`)} });`,
        `fs.writeFileSync(${JSON.stringify(selectedEntrypointFile)}, process.argv[1]);`,
      ].join("\n"),
    );
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", controller.run!],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          ...actionEnvironment,
          BASH_ENV: "/dev/null",
          GITHUB_ACTION_PATH: actionDirectory,
          NODE_OPTIONS: `--import=${pathToFileURL(bootstrap).href}`,
          GH_TOKEN: scenario === "missing-token" ? "" : "fixture-gh-token",
        },
      },
    );
    return {
      result,
      selectedEntrypoint: existsSync(selectedEntrypointFile)
        ? resolve(readFileSync(selectedEntrypointFile, "utf8"))
        : null,
      npmObservation: existsSync(observation)
        ? JSON.parse(readFileSync(observation, "utf8"))
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
