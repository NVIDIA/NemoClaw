// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyDependencyPins } from "../scripts/checks/dependency-pins";

const OPENSHELL_MIN = "1.2.3";
const OPENSHELL_MAX = "1.2.4";
const OPENCLAW_VERSION = "2030.4.5";
const OPENCLAW_INTEGRITY =
  "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==";
const ALTERNATE_INTEGRITY =
  "sha512-PzSJiYqmwpTudmakYs2oCJ57OW3VwEJYf8buTuKvuRvcYEUf/KOTu2dD6pLf2XYgDKErpvcDaoSAJ1nGCyvzAA==";
const HERMES_SEMVER = "7.8.9";
const MAP_SHA256 = "b".repeat(64);
const MANIFEST_SHA256 = "c".repeat(64);
const OPENSHELL_RELEASE_MANIFESTS = [
  "openshell-checksums-sha256.txt",
  "openshell-gateway-checksums-sha256.txt",
  "openshell-sandbox-checksums-sha256.txt",
] as const;

type FixtureOverrides = Partial<Record<string, string>>;

function openclawSelector(version: string, argVersion: string = version): string {
  const arg = `OPENCLAW_${argVersion.replace(/[.-]/g, "_")}`;
  return (
    `if [ "$OPENCLAW_VERSION" = "${version}" ]; then ` +
    `EXPECTED_INTEGRITY="$${arg}_INTEGRITY"; ` +
    `EXPECTED_TARBALL="$${arg}_TARBALL"; fi;`
  );
}

function writeFixture(root: string, overrides: FixtureOverrides = {}): void {
  const openshellMin = overrides.openshellMin ?? OPENSHELL_MIN;
  const openshellMax = overrides.openshellMax ?? OPENSHELL_MAX;
  const openclawVersion = overrides.openclawVersion ?? OPENCLAW_VERSION;
  const openclawIntegrity = overrides.openclawIntegrity ?? OPENCLAW_INTEGRITY;
  const openclawTarball =
    overrides.openclawTarball ??
    `https://registry.npmjs.org/openclaw/-/openclaw-${openclawVersion}.tgz`;
  const openclawArg = `OPENCLAW_${openclawVersion.replace(/[.-]/g, "_")}`;
  const hermesSemver = overrides.hermesSemver ?? HERMES_SEMVER;
  const credentialManifestName = `openshell-child-visible-credentials.v${openshellMax}.json`;
  const credentialVersion = overrides.credentialVersion ?? openshellMax;
  const installerHashVersions = [
    overrides.installerHashExtraVersion,
    overrides.installerHashVersion ?? openshellMax,
  ].filter((version): version is string => version !== undefined);
  const installerHashAllowlist = installerHashVersions
    .flatMap((version) =>
      OPENSHELL_RELEASE_MANIFESTS.filter(
        (manifest) => manifest !== overrides.installerHashOmitManifest,
      ).map((manifest) => `  "${version}|${manifest}|${MANIFEST_SHA256}"`),
    )
    .join("\n");

  const files: Record<string, string> = {
    "nemoclaw-blueprint/blueprint.yaml": `
min_openshell_version: "${openshellMin}"
max_openshell_version: "${openshellMax}"
`,
    "scripts/install-openshell.sh": `
MIN_VERSION="${overrides.installerMin ?? openshellMin}"
MAX_VERSION="${overrides.installerMax ?? openshellMax}"
PIN_VERSION="${overrides.installerPinExpression ?? "$MAX_VERSION"}"
`,
    "scripts/check-installer-hash.sh": `
readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(
${installerHashAllowlist}
)
`,
    "scripts/brev-launchable-ci-cpu.sh": `
case "$NEMOCLAW_REF" in
  stable | auto) OPENSHELL_VERSION="v${overrides.brevVersion ?? openshellMax}" ;;
esac
`,
    ".github/workflows/e2e.yaml": `
jobs:
  openshell-gateway-auth-contract:
    env:
      NEMOCLAW_OPENSHELL_PIN_VERSION: "${overrides.workflowPinVersion ?? openshellMax}"
`,
    [`src/lib/actions/sandbox/${credentialManifestName}`]: JSON.stringify({
      openshellCommit: "f".repeat(40),
      openshellVersion: credentialVersion,
    }),
    "src/lib/actions/sandbox/mcp-bridge-validation.ts": `
import boundary from "./openshell-child-visible-credentials.v${overrides.mcpImportVersion ?? openshellMax}.json";
`,
    "src/lib/onboard/openshell-version.ts": `
export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "${overrides.fallbackVersion ?? openshellMax}";
`,
    "src/lib/onboard/openshell-install.ts": `
const minVersion = deps.getBlueprintMinOpenshellVersion() ?? "${overrides.minFallbackVersion ?? openshellMin}";
`,
    "src/lib/onboard/docker-driver-gateway-runtime.ts": `
const DIGESTS = {
  "${overrides.supervisorMapVersion ?? openshellMax}": "sha256:${MAP_SHA256}",
};
`,
    "src/lib/onboard/openshell-feature-gate.ts": `
const BUILDS = new Map([
  ["${MAP_SHA256}", "${overrides.sandboxMapVersion ?? openshellMax}"],
]);
`,
    "agents/hermes/Dockerfile": `
COPY src/lib/actions/sandbox/${credentialManifestName} /usr/local/lib/nemoclaw/${`openshell-child-visible-credentials.v${overrides.hermesDockerfileBoundaryVersion ?? openshellMax}.json`}
`,
    "agents/hermes/mcp-config-transaction.py": `
BOUNDARY_MANIFEST_NAME = "openshell-child-visible-credentials.v${overrides.hermesTransactionBoundaryVersion ?? openshellMax}.json"
if manifest.get("openshellVersion") != "${overrides.hermesTransactionExpectedVersion ?? openshellMax}":
    raise RuntimeError("invalid")
`,
    "scripts/update-hermes-agent.sh": `
"openshell-child-visible-credentials.v${overrides.hermesUpdateBoundaryVersion ?? openshellMax}.json"
`,
    "Dockerfile.base": `
ARG OPENCLAW_VERSION=${openclawVersion}
ARG ${openclawArg}_INTEGRITY=${openclawIntegrity}
ARG ${openclawArg}_TARBALL=${openclawTarball}
${openclawSelector(
  overrides.openclawBaseSelectorVersion ?? openclawVersion,
  overrides.openclawBaseSelectorArgVersion,
)}
${overrides.dockerfileBaseExtra ?? ""}
`,
    Dockerfile: `
ARG OPENCLAW_VERSION=${overrides.openclawDockerfileVersion ?? openclawVersion}
ARG ${openclawArg}_INTEGRITY=${overrides.openclawDockerfileIntegrity ?? openclawIntegrity}
ARG ${openclawArg}_TARBALL=${overrides.openclawDockerfileTarball ?? openclawTarball}
${openclawSelector(
  overrides.openclawDockerfileSelectorVersion ?? openclawVersion,
  overrides.openclawDockerfileSelectorArgVersion,
)}
`,
    "agents/openclaw/manifest.yaml": `
expected_version: "${overrides.openclawManifestVersion ?? openclawVersion}"
`,
    "nemoclaw/package.json": JSON.stringify({
      openclaw: {
        build: {
          openclawVersion: overrides.openclawPackageVersion ?? openclawVersion,
        },
      },
    }),
    "agents/hermes/Dockerfile.base": `
ARG HERMES_SEMVER=${hermesSemver}
`,
    "agents/hermes/manifest.yaml": `
expected_version: "${overrides.hermesManifestVersion ?? hermesSemver}"
`,
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents.trimStart());
  }
}

function withFixture(
  prefix: string,
  overrides: FixtureOverrides,
  assertion: (root: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    writeFixture(root, overrides);
    assertion(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("dependency pin drift check", () => {
  it("accepts matching operational consumers without a committed mirror (#5242)", () => {
    withFixture("nemoclaw-dependency-pins-match-", {}, (root) => {
      expect(verifyDependencyPins(root)).toEqual([]);
    });
  });

  it("accepts a coordinated authority and consumer change (#5242)", () => {
    withFixture(
      "nemoclaw-dependency-pins-change-",
      {
        openshellMin: "2.3.4",
        openshellMax: "2.4.0",
        openclawVersion: "2031.2.3",
        hermesSemver: "8.9.10",
      },
      (root) => expect(verifyDependencyPins(root)).toEqual([]),
    );
  });

  it("accepts the blueprint maximum in a multi-release manifest allowlist (#5242)", () => {
    withFixture(
      "nemoclaw-dependency-pins-multi-release-",
      { installerHashExtraVersion: "1.2.3" },
      (root) => expect(verifyDependencyPins(root)).toEqual([]),
    );
  });

  it("reports exact operational consumer drift (#5242)", () => {
    withFixture(
      "nemoclaw-dependency-pins-drift-",
      {
        installerMin: "1.2.2",
        installerMax: "1.2.3",
        installerPinExpression: "1.2.4",
        installerHashVersion: "1.2.3",
        fallbackVersion: "1.2.3",
        minFallbackVersion: "1.2.2",
        supervisorMapVersion: "1.2.3",
        sandboxMapVersion: "1.2.3",
        brevVersion: "1.2.3",
        workflowPinVersion: "1.2.3",
        credentialVersion: "1.2.3",
        mcpImportVersion: "1.2.3",
        hermesDockerfileBoundaryVersion: "1.2.3",
        hermesTransactionBoundaryVersion: "1.2.3",
        hermesTransactionExpectedVersion: "1.2.3",
        hermesUpdateBoundaryVersion: "1.2.3",
        openclawDockerfileSelectorVersion: "2030.4.4",
        openclawDockerfileVersion: "2030.4.4",
        openclawDockerfileIntegrity: ALTERNATE_INTEGRITY,
        openclawDockerfileTarball: "https://registry.npmjs.org/openclaw/-/openclaw-2030.4.4.tgz",
        openclawManifestVersion: "2030.4.4",
        openclawPackageVersion: "2030.4.4",
        hermesManifestVersion: "7.8.8",
      },
      (root) => {
        expect(verifyDependencyPins(root)).toEqual([
          "OpenShell installer MIN_VERSION: expected 1.2.3, found 1.2.2",
          "OpenShell installer MAX_VERSION: expected 1.2.4, found 1.2.3",
          "OpenShell installer PIN_VERSION: expected $MAX_VERSION, found 1.2.4",
          "OpenShell release-manifest allowlist: expected one complete entry for 1.2.4",
          "OpenShell supported fallback version: expected 1.2.4, found 1.2.3",
          "OpenShell minimum fallback version: expected 1.2.3, found 1.2.2",
          "OpenShell supervisor manifest digest map: expected a reference to 1.2.4",
          "OpenShell sandbox build version map: expected a reference to 1.2.4",
          "Brev launchable stable OpenShell default: expected 1.2.4, found 1.2.3",
          ".github/workflows/e2e.yaml gateway auth OpenShell version: expected 1.2.4, found 1.2.3",
          "OpenShell credential-boundary manifest version: expected 1.2.4, found 1.2.3",
          "OpenShell credential-boundary import: expected 1.2.4, found 1.2.3",
          "Hermes Dockerfile credential-boundary manifest version: expected 1.2.4, found 1.2.3",
          "Hermes MCP transaction credential-boundary manifest version: expected 1.2.4, found 1.2.3",
          "Hermes MCP transaction expected OpenShell version: expected 1.2.4, found 1.2.3",
          "Hermes update script credential-boundary manifest version: expected 1.2.4, found 1.2.3",
          "Dockerfile reviewed OpenClaw selector must bind 2030.4.5 to OPENCLAW_2030_4_5_INTEGRITY and OPENCLAW_2030_4_5_TARBALL",
          "Dockerfile OPENCLAW_VERSION: expected 2030.4.5, found 2030.4.4",
          `Dockerfile OPENCLAW_2030_4_5_INTEGRITY: expected ${OPENCLAW_INTEGRITY}, found ${ALTERNATE_INTEGRITY}`,
          "Dockerfile OPENCLAW_2030_4_5_TARBALL: expected https://registry.npmjs.org/openclaw/-/openclaw-2030.4.5.tgz, found https://registry.npmjs.org/openclaw/-/openclaw-2030.4.4.tgz",
          "OpenClaw manifest expected_version: expected 2030.4.5, found 2030.4.4",
          "nemoclaw package OpenClaw build version: expected 2030.4.5, found 2030.4.4",
          "Hermes manifest expected_version: expected 7.8.9, found 7.8.8",
        ]);
      },
    );
  });

  it.each([
    {
      name: "an unsafe OpenShell maximum",
      overrides: { openshellMax: "../1.2.4" },
      failure: "nemoclaw-blueprint/blueprint.yaml max_openshell_version must match X.Y.Z",
    },
    {
      name: "an unsafe OpenClaw version",
      overrides: { openclawVersion: "2030/4/5" },
      failure: "Dockerfile.base OPENCLAW_VERSION must match X.Y.Z",
    },
    {
      name: "a stale base-image OpenClaw selector",
      overrides: { openclawBaseSelectorVersion: "2030.4.4" },
      failure:
        "Dockerfile.base reviewed OpenClaw selector must bind 2030.4.5 to OPENCLAW_2030_4_5_INTEGRITY and OPENCLAW_2030_4_5_TARBALL",
    },
  ])("rejects $name before checking consumers (#5242)", ({ overrides, failure }) => {
    withFixture("nemoclaw-dependency-pins-authority-", overrides, (root) => {
      expect(verifyDependencyPins(root)).toEqual([failure]);
    });
  });

  it("rejects an incomplete manifest allowlist entry for the blueprint maximum (#5242)", () => {
    withFixture(
      "nemoclaw-dependency-pins-incomplete-openshell-allowlist-",
      { installerHashOmitManifest: "openshell-sandbox-checksums-sha256.txt" },
      (root) => {
        expect(verifyDependencyPins(root)).toEqual([
          "OpenShell release-manifest allowlist: expected one complete entry for 1.2.4",
        ]);
      },
    );
  });

  it("rejects an ambiguous operational authority (#5242)", () => {
    withFixture(
      "nemoclaw-dependency-pins-ambiguous-",
      { dockerfileBaseExtra: `ARG OPENCLAW_VERSION=${OPENCLAW_VERSION}` },
      (root) => {
        expect(verifyDependencyPins(root)).toEqual([
          "Dockerfile.base OPENCLAW_VERSION: expected exactly one match",
        ]);
      },
    );
  });
});
