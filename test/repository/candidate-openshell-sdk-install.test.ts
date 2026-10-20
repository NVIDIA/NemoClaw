// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareApprovedCandidateOpenShellSdk } from "../../scripts/checks/candidate-openshell-sdk.mts";
import {
  afterCandidateSdkRead,
  candidateSdkCheckout,
  candidateSdkFixture,
  candidateSdkMergeFixture,
  sdkCandidateIdentity,
} from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-install-"));
  roots.push(root);
  const f = candidateSdkFixture();
  return { ...f, preparation: candidateSdkCheckout(root, f), stage: vi.fn() };
}
function mergeFixture() {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-merge-"));
  roots.push(root);
  return candidateSdkMergeFixture(root);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admitted candidate SDK installation", () => {
  it("accepts merged dependency inputs that retain the approved SDK and trusted graph policy", async () => {
    const f = mergeFixture();
    await prepareApprovedCandidateOpenShellSdk(
      f.preparation,
      f.identity,
      f.request,
      f.trustedSource,
      f.stage,
    );
    expect(f.stage).toHaveBeenCalledOnce();
  });

  it("rejects a merge selecting another SDK listed in the candidate metadata", async () => {
    const f = mergeFixture();
    f.change("ci/reviewed-npm-audit.json", (value) => {
      value.sourceRegistryPackageReplacement = JSON.parse(
        JSON.stringify(f.sdk).replaceAll("9.8.7", "9.8.8"),
      );
    });
    f.writeMerged("package.json", f.sources["package.json"]!.replaceAll("9.8.7", "9.8.8"));
    f.writeMerged(
      "nemoclaw/package.json",
      f.sources["nemoclaw/package.json"]!.replaceAll("9.8.7", "9.8.8"),
    );
    f.writeMerged(
      "package-lock.json",
      f.sources["package-lock.json"]!.replaceAll("9.8.7", "9.8.8"),
    );
    f.writeMerged(
      "nemoclaw/package-lock.json",
      f.sources["nemoclaw/package-lock.json"]!.replaceAll("9.8.7", "9.8.8"),
    );
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        f.identity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/identity changed in the merge/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a replacement approval between candidate and merge source reads", async () => {
    const f = mergeFixture();
    const request = afterCandidateSdkRead(f, () => {
      f.records[0]!.id = 51;
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        f.identity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/admission changed during merge/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it.each(["different-sdk", "untrusted-registry", "local-drift"])(
    "rejects merged dependency inputs with %s before staging",
    async (kind) => {
      const f = mergeFixture();
      const mutations = {
        "different-sdk": () =>
          f.writeMerged(
            "package.json",
            JSON.stringify({ optionalDependencies: { "@nvidia/openshell-sdk": "9.8.8" } }),
          ),
        "untrusted-registry": () =>
          f.writeMerged(
            "package-lock.json",
            f.sources["package-lock.json"]!.replace(
              "https://registry.npmjs.org/",
              "https://attacker.invalid/",
            ),
          ),
        "local-drift": () => writeFileSync(join(f.preparation.targetRoot, "package.json"), "{}"),
      };
      mutations[kind as keyof typeof mutations]();
      await expect(
        prepareApprovedCandidateOpenShellSdk(
          f.preparation,
          f.identity,
          f.request,
          f.trustedSource,
          f.stage,
        ),
      ).rejects.toThrow(/one identity|reviewed registry|checkout differs/);
      expect(f.stage).not.toHaveBeenCalled();
    },
  );

  it("stages verified bytes only after rechecking live admission", async () => {
    const f = fixture();
    await prepareApprovedCandidateOpenShellSdk(
      f.preparation,
      sdkCandidateIdentity,
      f.request,
      f.trustedSource,
      f.stage,
    );
    expect(f.stage).toHaveBeenCalledExactlyOnceWith({
      archive: f.bytes,
      artifactName: f.sdk.artifactName,
      cacheDirectory: f.preparation.cacheDirectory,
    });
    expect(f.request.mock.calls.filter(([route]) => route.includes("/contents/"))).toHaveLength(10);
  });

  it.each([
    "package.json",
    "package-lock.json",
    "nemoclaw/package.json",
    "nemoclaw/package-lock.json",
  ])("rejects a checkout that differs from the approved %s", async (path) => {
    const f = fixture();
    writeFileSync(join(f.preparation.targetRoot, path), "{}");
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/checkout differs/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a symbolic-link input before staging", async () => {
    const f = fixture();
    const path = join(f.preparation.targetRoot, "package.json");
    rmSync(path);
    symlinkSync("nemoclaw/package.json", path);
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/symbolic-link/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects corrupt archive bytes before staging", async () => {
    const f = fixture();
    writeFileSync(join(f.preparation.artifactDirectory, f.sdk.artifactName), "substituted");
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/integrity mismatch/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a revoked approval before staging verified bytes", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      f.records.length = 0;
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/independent maintainer/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a replacement approval before staging verified bytes", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      f.records[0]!.id = 51;
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/admission changed/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rechecks checkout inputs after acquiring the final approval", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      writeFileSync(join(f.preparation.targetRoot, "nemoclaw/package-lock.json"), "{}");
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/checkout differs/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects registry installation without consulting GitHub", async () => {
    const f = fixture();
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        { ...f.preparation, mode: "registry" },
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/requires artifact mode/);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.stage).not.toHaveBeenCalled();
  });
});
