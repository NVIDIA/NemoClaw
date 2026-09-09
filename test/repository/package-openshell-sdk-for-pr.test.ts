// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageReviewedOpenShellSdk } from "../../scripts/checks/package-openshell-sdk-for-pr.mts";
import type { ReviewedNpmArchiveRequest } from "../../scripts/lib/reviewed-npm-archive.mts";

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
  it("fails closed when replacement packaging lacks replacement metadata", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    delete config.sourceRegistryPackageReplacement;

    expect(() =>
      packageReviewedOpenShellSdk(source.output, true, {
        ...source,
        readAuditConfig: () => JSON.stringify(config),
      }),
    ).toThrow("reviewed OpenShell SDK replacement metadata is required");
    expect(source.pack).not.toHaveBeenCalled();
  });

  it("keeps the default package result to the active SDK archive", () => {
    const source = fixture();

    const artifact = packageReviewedOpenShellSdk(source.output, false, source);

    expect(path.basename(artifact)).toBe("nvidia-openshell-sdk-0.0.106.tgz");
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.106",
    ]);
    expect(source.remove).toHaveBeenCalledOnce();
  });

  it("packages exactly the active and replacement identities for PR selection", () => {
    const source = fixture();

    const artifactDirectory = packageReviewedOpenShellSdk(source.output, true, source);

    expect(artifactDirectory).toBe(source.output);
    expect(fs.readdirSync(artifactDirectory).sort()).toEqual([
      "nvidia-openshell-sdk-0.0.106.tgz",
      "nvidia-openshell-sdk-0.0.116.tgz",
    ]);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.106",
      "@nvidia/openshell-sdk@0.0.116",
    ]);
    expect(source.remove).toHaveBeenCalledTimes(2);
  });
});
