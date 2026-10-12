// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateOpenShellFeatureGateSource } from "../../../scripts/checks/extract-installer-pins.mts";
import {
  projectProtectedOpenShellSources,
  projectProtectedOpenShellSdk,
} from "../../../tools/e2e/protected-openshell-projection.mts";

function read(source: string) {
  return readFileSync(new URL(`../../../${source}`, import.meta.url), "utf8");
}
function fixture() {
  return {
    candidate: {
      blueprintSource: read("nemoclaw-blueprint/blueprint.yaml"),
      installerSource: read("scripts/install-openshell.sh"),
      brevInstallerSource: read("scripts/brev-launchable-ci-cpu.sh"),
      supervisorRuntimeSource: read("src/lib/onboard/docker-driver-gateway-runtime.ts"),
      featureGateSource: read("src/lib/onboard/openshell-feature-gate.ts"),
    },
    trusted: {
      blueprintSource:
        'name: trusted-controller\nmin_openshell_version: "0.0.1"\nmax_openshell_version: "0.0.1"\n',
      versionSource:
        'export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "0.0.1";\nexport const otherSetting = "unchanged";\n',
    },
  };
}

describe("protected OpenShell source projection", () => {
  it("binds the controller to reviewed release data without adopting the candidate blueprint", () => {
    const { candidate, trusted } = fixture();
    candidate.blueprintSource += '\nunrelated_candidate_field: "never copy"\n';
    const projected = projectProtectedOpenShellSources(candidate, trusted);
    expect(projected.releaseVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(projected.files).sort()).toEqual([
      "nemoclaw-blueprint/blueprint.yaml",
      "scripts/install-openshell.sh",
      "src/lib/onboard/docker-driver-gateway-runtime.ts",
      "src/lib/onboard/openshell-feature-gate.ts",
      "src/lib/onboard/openshell-version.ts",
    ]);
    expect(projected.files["nemoclaw-blueprint/blueprint.yaml"]).toBe(
      `name: trusted-controller\nmin_openshell_version: "${projected.releaseVersion}"\nmax_openshell_version: "${projected.releaseVersion}"\n`,
    );
    expect(projected.files["src/lib/onboard/openshell-version.ts"]).toBe(
      `export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "${projected.releaseVersion}";\nexport const otherSetting = "unchanged";\n`,
    );
  });

  it.each([
    "installerSource",
    "brevInstallerSource",
    "supervisorRuntimeSource",
    "featureGateSource",
  ] as const)("rejects unreviewed operations in %s", (field) => {
    const { candidate, trusted } = fixture();
    candidate[field] += "\nunreviewed_operation();\n";
    expect(() => projectProtectedOpenShellSources(candidate, trusted)).toThrow(/template/);
  });

  it.each(["blueprintSource", "versionSource"] as const)(
    "rejects ambiguous trusted %s pins",
    (field) => {
      const { candidate, trusted } = fixture();
      trusted[field] += trusted[field];
      expect(() => projectProtectedOpenShellSources(candidate, trusted)).toThrow(/requires one/);
    },
  );

  it("rejects a reviewed supervisor template that selects a different release", () => {
    const { candidate, trusted } = fixture();
    candidate.supervisorRuntimeSource = candidate.supervisorRuntimeSource.replace(
      /^const QUALIFIED_STABLE_OPENSHELL_VERSION = ".*";$/m,
      'const QUALIFIED_STABLE_OPENSHELL_VERSION = "9.9.9";',
    );
    expect(() => projectProtectedOpenShellSources(candidate, trusted)).toThrow();
  });

  it.each([
    { name: "unknown binary", map: `  ["${"a".repeat(64)}", "0.0.116"],\n` },
    { name: "executable entry", map: '  [process.env.BINARY, "0.0.116"],\n' },
    { name: "unterminated comment", map: "  /* ignore remaining map\n" },
  ])("rejects a feature map with $name", ({ map }) => {
    const { candidate, trusted } = fixture();
    candidate.featureGateSource = candidate.featureGateSource.replace(
      "const PINNED_SANDBOX_BUILD_VERSIONS = new Map<string, string>([\n",
      `const PINNED_SANDBOX_BUILD_VERSIONS = new Map<string, string>([\n${map}`,
    );
    expect(() => projectProtectedOpenShellSources(candidate, trusted)).toThrow(/feature gate/);
  });

  it("rejects duplicate binary identities before using the map", () => {
    const { candidate, trusted } = fixture();
    candidate.featureGateSource = candidate.featureGateSource.replace(
      /^(  \["[a-f0-9]{64}", "[0-9.]+"\],)$/m,
      "$1\n$1",
    );
    expect(() => projectProtectedOpenShellSources(candidate, trusted)).toThrow(/unique/);
  });

  it("rejects an unknown release and oversized feature source", () => {
    const { candidate } = fixture();
    expect(() => validateOpenShellFeatureGateSource(candidate.featureGateSource, "9.9.9")).toThrow(
      /base-trusted/,
    );
    expect(() =>
      validateOpenShellFeatureGateSource("x".repeat(1024 * 1024 + 1), "0.0.116"),
    ).toThrow(/too large/);
  });
});

const sdkName = "@nvidia/openshell-sdk";
const sdkLocation = `node_modules/${sdkName}`;
function sdkFixture() {
  const auditSource = read("ci/reviewed-npm-audit.json");
  const config = JSON.parse(auditSource);
  const baseline = config.sourceRegistryPackage;
  const replacement = config.sourceRegistryPackageReplacement;
  const baseVersion = baseline.packageSpec.split("@").at(-1);
  const version = replacement.packageSpec.split("@").at(-1);
  const packageRecord = {
    name: "trusted",
    scripts: { build: "trusted-build" },
    optionalDependencies: { [sdkName]: baseVersion },
    dependencies: { unrelated: "1.0.0" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { ...packageRecord },
      [sdkLocation]: {
        version: baseVersion,
        resolved: baseline.tarballUrl,
        integrity: baseline.integrity,
        optional: true,
        dependencies: { helper: "1.0.0" },
      },
      "node_modules/helper": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/helper/-/helper-1.0.0.tgz",
        integrity: baseline.integrity,
      },
      "node_modules/unrelated": { version: "1.0.0" },
    },
  };
  const candidatePackage = structuredClone(packageRecord);
  candidatePackage.optionalDependencies[sdkName] = version;
  candidatePackage.scripts.build = "unreviewed-build";
  candidatePackage.dependencies.unrelated = "9.0.0";
  const candidateLock = structuredClone(lock);
  candidateLock.packages[""] = candidatePackage;
  Object.assign(candidateLock.packages[sdkLocation], {
    version,
    resolved: replacement.tarballUrl,
    integrity: replacement.integrity,
  });
  candidateLock.packages["node_modules/unrelated"].version = "9.0.0";
  return {
    version,
    candidate: {
      packageSource: JSON.stringify(candidatePackage),
      lockSource: JSON.stringify(candidateLock),
    },
    trusted: {
      packageSource: JSON.stringify(packageRecord),
      lockSource: JSON.stringify(lock),
      auditSource,
    },
  };
}

describe("protected OpenShell SDK projection", () => {
  it("selects the candidate archive and preserves unrelated trusted dependencies and scripts", () => {
    const { candidate, trusted, version } = sdkFixture();
    const result = projectProtectedOpenShellSdk(candidate, trusted, version);
    const manifest = JSON.parse(result.files["package.json"]!);
    const lock = JSON.parse(result.files["package-lock.json"]!);
    expect(result.sdkVersion).toBe(version);
    expect(manifest).toEqual({
      ...JSON.parse(trusted.packageSource),
      optionalDependencies: { [sdkName]: version },
    });
    expect(lock.packages[sdkLocation]).toEqual(
      JSON.parse(candidate.lockSource).packages[sdkLocation],
    );
    expect(lock.packages["node_modules/unrelated"]).toEqual({ version: "1.0.0" });
  });

  it("rejects a runtime and SDK version mismatch", () => {
    const { candidate, trusted } = sdkFixture();
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, "9.9.9")).toThrow(
      /match the selected/,
    );
  });

  it.each(["resolved", "integrity"])("rejects substituted candidate SDK %s", (field) => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages[sdkLocation][field] = "unreviewed";
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(/not trusted/);
  });

  it("rejects an SDK absent from trusted archive records", () => {
    const { candidate, trusted, version } = sdkFixture();
    const config = JSON.parse(trusted.auditSource);
    delete config.sourceRegistryPackageReplacement;
    trusted.auditSource = JSON.stringify(config);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(/not trusted/);
  });

  it.each(["version", "integrity"])("rejects candidate changes to SDK transitive %s", (field) => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages["node_modules/helper"][field] = "substituted";
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /transitive dependencies/,
    );
  });

  it("rejects a nested dependency that shadows the trusted dependency", () => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages[`${sdkLocation}/node_modules/helper`] = lock.packages["node_modules/helper"];
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /transitive dependencies/,
    );
  });

  it("rejects new SDK dependency metadata", () => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages[sdkLocation].dependencies.injected = "1.0.0";
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /dependency metadata/,
    );
  });

  it("rejects a mismatched SDK lock identity", () => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages[sdkLocation].version = "9.9.9";
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /identities disagree/,
    );
  });

  it("rejects a mismatched root lock identity", () => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.packages[""].optionalDependencies[sdkName] = "9.9.9";
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /identities disagree/,
    );
  });

  it("rejects an unsupported lockfile version", () => {
    const { candidate, trusted, version } = sdkFixture();
    const lock = JSON.parse(candidate.lockSource);
    lock.lockfileVersion = 2;
    candidate.lockSource = JSON.stringify(lock);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(
      /lockfileVersion/,
    );
  });

  it("rejects ambiguous manifest declarations", () => {
    const { candidate, trusted, version } = sdkFixture();
    const manifest = JSON.parse(candidate.packageSource);
    manifest.dependencies[sdkName] = version;
    candidate.packageSource = JSON.stringify(manifest);
    expect(() => projectProtectedOpenShellSdk(candidate, trusted, version)).toThrow(/ambiguous/);
  });
});
