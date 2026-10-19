// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

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
        `${prefix}/issues/123/comments?per_page=100&page=1`,
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

  it("loads the ordinary producer from the main workflow sparse checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-main-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, ".github/workflows/main.yaml", "package-openshell-sdk");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const producer = await import('./scripts/checks/package-openshell-sdk-for-pr.mts'); console.log(typeof producer.packageReviewedOpenShellSdk)",
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

  it("loads the ordinary consumer from the PR workflow sparse checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, ".github/workflows/pr.yaml", "openshell-sdk-package");
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
      "nvidia-openshell-sdk-0.1.3.tgz",
    ]);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
      "@nvidia/openshell-sdk@0.1.3",
    ]);
    expect(source.requests[1]).toMatchObject({
      expectedIntegrity:
        "sha512-JXWcEDIl/h8Pp6c2NrFMp0XLloDsLaDZvSVJzXvKUyGEulE64d/utiE1KtNh45JtiZXbVmB2PMJAWEmgZKW5kA==",
      tarballUrl:
        "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.1.3/32e1b675af5ad8b8a8fe078a1a11d515a9f45571",
    });
    expect(source.remove).toHaveBeenCalledTimes(2);
  });

  it("packages the replacement when available without requiring transition metadata", () => {
    const source = fixture();
    const artifactDirectory = packageReviewedOpenShellSdk(source.output, "if-present", source);

    expect(artifactDirectory).toBe(source.output);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
      "@nvidia/openshell-sdk@0.1.3",
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
