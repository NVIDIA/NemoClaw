// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { packageReviewedOpenShellSdk } from "../../scripts/checks/package-openshell-sdk-for-pr.mts";
import type { ReviewedNpmArchiveRequest } from "../../scripts/lib/reviewed-npm-archive.mts";
import {
  candidateSdkMergeFixture,
  sparseSdkWorkflowCheckout,
} from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-package-transition-"));
  roots.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  const requests: ReviewedNpmArchiveRequest[] = [];
  const pack = vi.fn((request: ReviewedNpmArchiveRequest) => {
    requests.push(request);
    const archivePath = path.join(source, `${String(requests.length)}.tgz`);
    fs.writeFileSync(archivePath, request.packageSpec);
    return { archivePath, rootDirectory: source };
  });
  const remove = vi.fn();
  return { output, pack, remove, requests };
}

describe("reviewed OpenShell SDK transition packaging", () => {
  it("emits the admitted archive from the manual PR workflow producer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-dispatch-"));
    roots.push(root);
    const output = path.join(root, "workflow-output");
    const calls = path.join(root, "calls.jsonl");
    const archive = path.join(root, "sdk archives", "admitted-sdk.tgz");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, "admitted archive fixture");
    fs.mkdirSync(path.join(root, "scripts/checks"), { recursive: true });
    fs.mkdirSync(path.join(root, "tools/e2e"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts/checks/package-openshell-sdk-for-pr.mts"),
      `import { appendFileSync } from 'node:fs';
export async function packageCandidateOpenShellSdkIfRequired(output, identity, request) {
  appendFileSync(process.env.CALLS, JSON.stringify({ output, identity }) + '\\n');
  const admitted = await request('/repos/NVIDIA/NemoClaw/pulls/' + identity.prNumber);
  return { required: true, artifact: admitted.archive };
}
export function packageReviewedOpenShellSdk() {
  throw new Error('reviewed fallback must not replace the admitted archive');
}
`,
    );
    fs.writeFileSync(
      path.join(root, "tools/e2e/base-image-publication.mts"),
      `import { appendFileSync } from 'node:fs';
export async function githubRequest(route, token) {
  appendFileSync(process.env.CALLS, JSON.stringify({ route, token }) + '\\n');
  return { archive: process.env.ADMITTED_ARCHIVE };
}
`,
    );
    const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8"));
    const producer = workflow.jobs["package-openshell-sdk"].steps.find(
      (step: { id?: string }) => step.id === "package",
    );
    const result = spawnSync("bash", ["-c", producer.run], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        UPGRADE_PR_NUMBER: "123",
        CANDIDATE_SHA: "a".repeat(40),
        UPGRADE_BASE_SHA: "b".repeat(40),
        GITHUB_TOKEN: "fixture-api-token",
        GITHUB_OUTPUT: output,
        NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY: path.dirname(archive),
        CALLS: calls,
        ADMITTED_ARCHIVE: archive,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        output: path.dirname(archive),
        identity: { prNumber: 123, candidateSha: "a".repeat(40), baseSha: "b".repeat(40) },
      },
      { route: "/repos/NVIDIA/NemoClaw/pulls/123", token: "fixture-api-token" },
    ]);
    expect(fs.readFileSync(output, "utf8")).toBe(`artifact_path=${archive}\n`);
    expect(result.stdout + result.stderr).not.toContain("fixture-api-token");
  });

  it.each([
    ["pull_request", 0, /candidate-openshell-sdk/],
    ["workflow_dispatch", 1, /checkout differs/],
  ] as const)(
    "uses merge identity only for the %s CLI entrypoint",
    async (event, status, diagnostic) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-merge-cli-"));
      roots.push(root);
      const f = candidateSdkMergeFixture(path.join(root, "candidate"));
      sparseSdkWorkflowCheckout(root, ".github/workflows/pr.yaml", "openshell-sdk-package");
      const prefix = "/repos/NVIDIA/NemoClaw";
      const routes = [
        `${prefix}/pulls/123`,
        `${prefix}/compare/${f.identity.baseSha}...${f.identity.candidateSha}?per_page=1`,
        `${prefix}/pulls/123/reviews?per_page=100&page=1`,
        `${prefix}/collaborators/reviewer/permission`,
        `${prefix}/git/commits/${f.identity.mergeSha}`,
        ...Object.keys(f.sources).flatMap((file) => [
          `${prefix}/contents/${file}?ref=${f.identity.candidateSha}`,
          `${prefix}/contents/${file}?ref=${f.identity.mergeSha}`,
        ]),
      ];
      const responses = Object.fromEntries(
        await Promise.all(routes.map(async (route) => [route, await f.request(route)])),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      const responses = ${JSON.stringify(responses)};
      globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        const key = parsed.pathname + parsed.search;
        return new Response(JSON.stringify(responses[key] ?? {}), { status: key in responses ? 200 : 404 });
      };
      process.argv[1] = ${JSON.stringify(path.join(root, "scripts/checks/prepare-ci-npm-install.mts"))};
      await import('./scripts/checks/prepare-ci-npm-install.mts');
    `,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: event,
            GITHUB_SHA: f.identity.mergeSha,
            CANDIDATE_SHA: f.identity.candidateSha,
            UPGRADE_BASE_SHA: f.identity.baseSha,
            UPGRADE_PR_NUMBER: "123",
            NEMOCLAW_OPEN_SHELL_SDK_CANDIDATE: "1",
            NEMOCLAW_CI_NPM_PACKAGE_MODE: "inspect",
            NEMOCLAW_CI_TARGET_ROOT: f.preparation.targetRoot,
            GITHUB_TOKEN: "fixture-token",
          },
        },
      );
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout + result.stderr).toMatch(diagnostic);
      expect(result.stdout + result.stderr).not.toContain("fixture-token");
    },
  );

  it.each([
    [".github/workflows/main.yaml", "package-openshell-sdk-for-pr", "packageReviewedOpenShellSdk"],
    [".github/workflows/e2e.yaml", "candidate-openshell-sdk", "readApprovedOpenShellSdkConfig"],
  ])("loads %s SDK preparation from its sparse checkout", (workflow, module, member) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-main-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, workflow, "package-openshell-sdk");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const producer = await import('./scripts/checks/${module}.mts'); console.log(typeof producer[${JSON.stringify(member)}])`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });

  it.each([
    [".github/workflows/pr.yaml", "openshell-sdk-package"],
    [".github/workflows/e2e.yaml", "generate-matrix"],
  ])("loads SDK preparation from %s job %s", (workflow, job) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, workflow, job);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const consumer = await import('./scripts/checks/prepare-ci-npm-install.mts'); console.log(typeof consumer.prepareCiNpmInstall)",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });

  it("fails closed when replacement packaging lacks replacement metadata", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    delete config.sourceRegistryPackageReplacement;

    expect(() =>
      packageReviewedOpenShellSdk(source.output, "require", {
        ...source,
        readAuditConfig: () => JSON.stringify(config),
      }),
    ).toThrow("reviewed OpenShell SDK replacement metadata is required");
    expect(source.pack).not.toHaveBeenCalled();
  });

  it("keeps the default package result to the active SDK archive", () => {
    const source = fixture();

    const artifact = packageReviewedOpenShellSdk(source.output, "exclude", source);

    expect(path.basename(artifact)).toBe("nvidia-openshell-sdk-0.0.116.tgz");
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
    ]);
    expect(source.remove).toHaveBeenCalledOnce();
  });

  it("packages exactly the active and replacement identities for PR selection", () => {
    const source = fixture();
    const artifactDirectory = packageReviewedOpenShellSdk(source.output, "require", source);

    expect(artifactDirectory).toBe(source.output);
    expect(fs.readdirSync(artifactDirectory).sort()).toEqual([
      "nvidia-openshell-sdk-0.0.116.tgz",
      "nvidia-openshell-sdk-0.1.5.tgz",
    ]);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
      "@nvidia/openshell-sdk@0.1.5",
    ]);
    expect(source.requests[1]).toMatchObject({
      expectedIntegrity:
        "sha512-pqeumlEkIoFko9kL8EmemULuEPGf7dbFz1DXac9mB5H5e0+vGs24T1S+jT/UOtjhYEdmBSR3WjMojBBAyh6lSQ==",
      tarballUrl:
        "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.1.5/141f111b92761575225e0ae977e1cf86d2c6515e",
    });
    expect(source.remove).toHaveBeenCalledTimes(2);
  });

  it("packages the replacement when available without requiring transition metadata", () => {
    const source = fixture();
    const artifactDirectory = packageReviewedOpenShellSdk(source.output, "if-present", source);

    expect(artifactDirectory).toBe(source.output);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
      "@nvidia/openshell-sdk@0.1.5",
    ]);
  });

  it("keeps the active archive when optional transition metadata is absent", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    delete config.sourceRegistryPackageReplacement;

    const artifact = packageReviewedOpenShellSdk(source.output, "if-present", {
      ...source,
      readAuditConfig: () => JSON.stringify(config),
    });

    expect(path.basename(artifact)).toBe("nvidia-openshell-sdk-0.0.116.tgz");
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
    ]);
  });
});
