// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readApprovedOpenShellSdkConfig,
  readCandidateSdkPackageDecision,
} from "../../scripts/checks/candidate-openshell-sdk.mts";
import {
  packageApprovedCandidateOpenShellSdk,
  packageCandidateOpenShellSdkIfRequired,
} from "../../scripts/checks/package-openshell-sdk-for-pr.mts";
import { requiresCandidateSdkAdmission } from "../../scripts/checks/prepare-ci-npm-install.mts";
import { candidateSdkFixture, sdkCandidateIdentity } from "../support/candidate-openshell-sdk.ts";
import type { ReviewedNpmArchiveRequest } from "../../scripts/lib/reviewed-npm-archive.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admitted candidate SDK packages", () => {
  it("packages a newly approved SDK with a commit-bound artifact name", async () => {
    const f = candidateSdkFixture();
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-publication-"));
    roots.push(root);
    const archivePath = join(root, "input.tgz");
    writeFileSync(archivePath, f.bytes);
    const pack = vi.fn(() => ({ archivePath, rootDirectory: root }));
    const result = await packageCandidateOpenShellSdkIfRequired(
      join(root, "output"),
      sdkCandidateIdentity,
      f.request,
      {
        readAuditConfig: () => f.trustedSource,
        pack,
        remove: vi.fn(),
      },
    );
    expect(result).toEqual({
      required: true,
      candidate: true,
      artifactName: f.sdk.artifactName,
      artifact: join(root, "output", f.sdk.artifactName),
      bundleName: `candidate-openshell-sdk-123-${sdkCandidateIdentity.candidateSha}-${sdkCandidateIdentity.baseSha}-50`,
    });
    expect(readFileSync(join(root, "output", f.sdk.artifactName))).toEqual(f.bytes);
    expect(pack).toHaveBeenCalledOnce();
  });

  it("keeps a trusted SDK on the existing artifact path without approval or downloading", async () => {
    const f = candidateSdkFixture();
    f.records.length = 0;
    const trustedSource = JSON.stringify({ ...f.trusted, sourceRegistryPackage: f.sdk });
    const pack = vi.fn();
    await expect(
      packageCandidateOpenShellSdkIfRequired("unused", sdkCandidateIdentity, f.request, {
        readAuditConfig: () => trustedSource,
        pack,
      }),
    ).resolves.toEqual({ required: false });
    expect(pack).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([route]) => route)).toEqual([
      `/repos/NVIDIA/NemoClaw/contents/package-lock.json?ref=${sdkCandidateIdentity.candidateSha}`,
      `/repos/NVIDIA/NemoClaw/contents/nemoclaw/package-lock.json?ref=${sdkCandidateIdentity.candidateSha}`,
    ]);
  });

  it("binds a new SDK artifact to the candidate, base and current approval", async () => {
    const f = candidateSdkFixture();
    await expect(
      readCandidateSdkPackageDecision(sdkCandidateIdentity, f.request, f.trustedSource),
    ).resolves.toEqual({
      required: true,
      candidate: true,
      artifactName: f.sdk.artifactName,
      bundleName: `candidate-openshell-sdk-123-${sdkCandidateIdentity.candidateSha}-${sdkCandidateIdentity.baseSha}-50`,
    });
  });

  it.each(["latest", "file:../sdk", "9.8", null])(
    "rejects malformed lock version %s before choosing admission",
    (version) => {
      const f = candidateSdkFixture();
      const lock = JSON.stringify({
        packages: { "node_modules/@nvidia/openshell-sdk": { version } },
      });
      expect(() => requiresCandidateSdkAdmission([lock], f.trustedSource)).toThrow(/exact version/);
    },
  );

  it("does not turn a changed integrity on a known version into a new admission", () => {
    const f = candidateSdkFixture();
    f.change("package-lock.json", (value) => {
      value.packages["node_modules/@nvidia/openshell-sdk"].integrity = "substituted";
    });
    expect(
      requiresCandidateSdkAdmission(
        [f.sources["package-lock.json"]!],
        JSON.stringify({ ...f.trusted, sourceRegistryPackage: f.sdk }),
      ),
    ).toBe(false);
  });

  it("selects a new SDK and its graph without adopting candidate audit policy", async () => {
    const f = candidateSdkFixture();
    f.change("ci/reviewed-npm-audit.json", (value) => {
      value.severityThreshold = "critical";
      value.registryOrigin = "https://attacker.invalid";
      value.sourceRegistryPackagesWithoutIntegrity = [];
      value.sourceNestedShrinkwrapPackages = ["sdk-helper@1.0.0"];
      value.exceptionFile = "candidate-exceptions.json";
    });
    const result = await readApprovedOpenShellSdkConfig(
      sdkCandidateIdentity,
      f.request,
      f.trustedSource,
    );
    const { sourceRegistryPackageReplacement: _old, ...expected } = f.trusted;
    expect(JSON.parse(result.configSource)).toEqual({ ...expected, sourceRegistryPackage: f.sdk });
    expect(result.sources["package-lock.json"]).toBe(f.sources["package-lock.json"]);
    expect(result.reviewer).toBe("reviewer");
  });

  it.each([
    ["packageSpec", "@other/sdk@9.8.7"],
    ["packageSpec", "@nvidia/openshell-sdk@latest"],
    ["artifactName", "../sdk.tgz"],
    ["integrity", "sha512-short"],
    ["tarballUrl", "https://attacker.invalid/sdk.tgz"],
    [
      "tarballUrl",
      "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/9.8.7/../" + "c".repeat(40),
    ],
  ])("rejects invalid SDK %s before packaging", async (key, value) => {
    const f = candidateSdkFixture();
    f.change("ci/reviewed-npm-audit.json", (config) => {
      config.sourceRegistryPackage[key!] = value;
    });
    await expect(
      readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, f.trustedSource),
    ).rejects.toThrow(/immutable official/);
  });

  it.each(["package.json", "nemoclaw/package.json"])(
    "rejects a conflicting pin in %s",
    async (file) => {
      const f = candidateSdkFixture();
      f.change(file, (value) => {
        value.optionalDependencies["@nvidia/openshell-sdk"] = "9.8.8";
      });
      await expect(
        readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, f.trustedSource),
      ).rejects.toThrow(/one identity/);
    },
  );

  it.each(["package-lock.json", "nemoclaw/package-lock.json"])(
    "validates SDK identity and transitive registry in %s",
    async (file) => {
      const f = candidateSdkFixture();
      f.change(file, (value) => {
        value.packages["node_modules/sdk-helper"].resolved = "https://attacker.invalid/helper.tgz";
      });
      await expect(
        readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, f.trustedSource),
      ).rejects.toThrow(/reviewed registry/);
    },
  );

  it("rejects a missing SDK transitive dependency", async () => {
    const f = candidateSdkFixture();
    f.change("package-lock.json", (value) => {
      delete value.packages["node_modules/sdk-helper"];
    });
    await expect(
      readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, f.trustedSource),
    ).rejects.toThrow(/missing a production dependency/);
  });

  it("rejects substitution of a base-trusted SDK identity", async () => {
    const f = candidateSdkFixture();
    const source = JSON.stringify({
      ...f.trusted,
      sourceRegistryPackage: {
        ...f.sdk,
        integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
      },
    });
    await expect(
      readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, source),
    ).rejects.toThrow(/cannot replace/);
  });

  it("requires independent current admission before reading package inputs", async () => {
    const f = candidateSdkFixture();
    f.records.length = 0;
    await expect(
      readApprovedOpenShellSdkConfig(sdkCandidateIdentity, f.request, f.trustedSource),
    ).rejects.toThrow(/independent maintainer/);
    expect(f.request.mock.calls.some(([route]) => route.includes("/contents/"))).toBe(false);
  });

  it.each(["success", "revoked", "corrupt", "reapproved", "head-moved", "pack-failed"])(
    "packages with script execution disabled and handles %s",
    async (result) => {
      const f = candidateSdkFixture();
      const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-package-"));
      roots.push(root);
      const archivePath = join(root, "sdk.tgz");
      writeFileSync(archivePath, result === "corrupt" ? "substituted" : f.bytes);
      const outcomes = {
        success: () => {},
        corrupt: () => {},
        revoked: () => {
          f.records.length = 0;
        },
        reapproved: () => {
          f.records[0]!.id = 51;
        },
        "head-moved": () => {
          f.pr.head.sha = "d".repeat(40);
        },
        "pack-failed": () => {
          throw new Error("fixture package download failed");
        },
      };
      const pack = vi.fn((_request: ReviewedNpmArchiveRequest) => {
        outcomes[result as keyof typeof outcomes]();
        return { archivePath, rootDirectory: root };
      });
      const remove = vi.fn();
      const output = join(root, "output");
      const task = packageApprovedCandidateOpenShellSdk(output, sdkCandidateIdentity, f.request, {
        pack,
        remove,
        readAuditConfig: () => f.trustedSource,
        env: {
          GITHUB_TOKEN: "fixture-read-token",
          GH_TOKEN: "fixture-cli-token",
          NODE_AUTH_TOKEN: "fixture-package-token",
        },
      });
      const assertions = {
        success: async () => {
          const artifact = await task;
          expect(readFileSync(artifact)).toEqual(f.bytes);
        },
        revoked: async () => {
          await expect(task).rejects.toThrow(/independent maintainer/);
          expect(existsSync(output)).toBe(false);
        },
        corrupt: async () => {
          await expect(task).rejects.toThrow(/integrity mismatch/);
          expect(existsSync(output)).toBe(false);
        },
        reapproved: async () => {
          await expect(task).rejects.toThrow(/admission changed/);
          expect(existsSync(output)).toBe(false);
        },
        "head-moved": async () => {
          await expect(task).rejects.toThrow(/open upstream PR/);
          expect(existsSync(output)).toBe(false);
        },
        "pack-failed": async () => {
          await expect(task).rejects.toThrow(/package download failed/);
          expect(existsSync(output)).toBe(false);
        },
      };
      await assertions[result as keyof typeof assertions]();
      expect(pack).toHaveBeenCalledOnce();
      expect(pack.mock.calls[0]![0].env).toEqual({
        NODE_AUTH_TOKEN: "fixture-package-token",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      });
      expect(remove).toHaveBeenCalledTimes(result === "pack-failed" ? 0 : 1);
    },
  );

  it("preserves an existing output directory without calling admission or npm", async () => {
    const f = candidateSdkFixture();
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-existing-"));
    roots.push(root);
    const output = join(root, "output");
    mkdirSync(output);
    writeFileSync(join(output, "retained"), "preserve");
    await expect(
      packageApprovedCandidateOpenShellSdk(output, sdkCandidateIdentity, f.request),
    ).rejects.toThrow(/new absolute/);
    expect(f.request).not.toHaveBeenCalled();
    expect(readFileSync(join(output, "retained"), "utf8")).toBe("preserve");
  });
});
