// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  V00103_SUPERVISOR_MANIFEST_DIGEST,
  V00116_SUPERVISOR_MANIFEST_DIGEST,
} from "../helpers/openshell-release-fixtures";

import { selectPreparedGatewayRuntime } from "../helpers/prepared-gateway-runtime";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const PARSER = path.join(REPO_ROOT, "scripts/checks/extract-installer-pins.mts");
const INSTALLER_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/install-openshell.sh"),
  "utf8",
);
const BREV_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
  "utf8",
);
const BLUEPRINT_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "nemoclaw-blueprint/blueprint.yaml"),
  "utf8",
);
const SUPERVISOR_RUNTIME_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
  "utf8",
);
const REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function addSupervisorManifestPin(source: string, version: string, digest: string): string {
  const marker =
    "const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {\n";
  const result = source.replace(marker, `${marker}  "${version}": "${digest}",\n`);
  assert.notEqual(result, source, "supervisor manifest fixture mutation must change the map");
  return result;
}

function selectSharedGatewayStateResolver(source: string): string {
  const localResolver = `  function getDockerDriverGatewayStateDir(): string {
    const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    if (configured && configured.trim()) return path.resolve(configured.trim());
    const dir = gatewayBinding.resolveGatewayStateDirName(currentGatewayPort());
    return path.join(os.homedir(), ".local", "state", "nemoclaw", dir);
  }`;
  const sharedResolver = `  function getDockerDriverGatewayStateDir(): string {
    return gatewayBinding.resolveGatewayStateDirForPort({
      configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
      home: os.homedir(),
      port: currentGatewayPort(),
    });
  }`;
  const prospective = source.includes(sharedResolver)
    ? source
    : source.replace(localResolver, sharedResolver);
  expect(prospective, "shared gateway state resolver").toContain(sharedResolver);
  return prospective;
}

type RunOptions = {
  candidateParserBypass?: boolean;
  supervisorSymlink?: boolean;
  transformSupervisor?: (source: string) => string;
};

function writeRegularSupervisorRuntime(runtimePath: string, source: string): void {
  fs.writeFileSync(runtimePath, source);
}

function writeSymlinkedSupervisorRuntime(runtimePath: string, source: string): void {
  const realRuntime = path.join(path.dirname(runtimePath), "real-runtime.ts");
  fs.writeFileSync(realRuntime, source);
  fs.symlinkSync(realRuntime, runtimePath);
}

function runParser(options: RunOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-supervisor-trust-"));
  const scriptsDir = path.join(root, "scripts");
  const checksDir = path.join(scriptsDir, "checks");
  const blueprintDir = path.join(root, "nemoclaw-blueprint");
  const supervisorRuntimeDir = path.join(root, "src/lib/onboard");
  const installer = path.join(scriptsDir, "install-openshell.sh");
  const brevInstaller = path.join(scriptsDir, "brev-launchable-ci-cpu.sh");
  const blueprint = path.join(blueprintDir, "blueprint.yaml");
  const supervisorRuntime = path.join(supervisorRuntimeDir, "docker-driver-gateway-runtime.ts");
  tempDirs.push(root);
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(blueprintDir, { recursive: true });
  fs.mkdirSync(supervisorRuntimeDir, { recursive: true });

  const selected = {
    blueprint: BLUEPRINT_TEMPLATE,
    brevInstaller: BREV_TEMPLATE,
    installer: INSTALLER_TEMPLATE,
    supervisorRuntime: SUPERVISOR_RUNTIME_TEMPLATE,
  };
  fs.writeFileSync(installer, selected.installer);
  fs.writeFileSync(brevInstaller, selected.brevInstaller);
  fs.writeFileSync(blueprint, selected.blueprint);
  const supervisorSource =
    options.transformSupervisor?.(selected.supervisorRuntime) ?? selected.supervisorRuntime;
  const writeSupervisorRuntime = options.supervisorSymlink
    ? writeSymlinkedSupervisorRuntime
    : writeRegularSupervisorRuntime;
  writeSupervisorRuntime(supervisorRuntime, supervisorSource);
  fs.writeFileSync(
    path.join(checksDir, "extract-installer-pins.mts"),
    options.candidateParserBypass
      ? 'process.stdout.write("CANDIDATE_PARSER_EXECUTED\\n");\n'
      : fs.readFileSync(PARSER, "utf8"),
  );

  return spawnSync(
    "node",
    [
      "--no-warnings",
      PARSER,
      "--blueprint",
      blueprint,
      "--installer",
      installer,
      "--brev-installer",
      brevInstaller,
      "--supervisor-runtime",
      supervisorRuntime,
      "--format",
      "tsv",
    ],
    { encoding: "utf8" },
  );
}

describe("OpenShell supervisor manifest trust", () => {
  it("accepts the gateway runtime template that prepares the Docker driver environment (#11212)", () => {
    const result = runParser({ transformSupervisor: selectPreparedGatewayRuntime });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a repository mutation of the gateway-preparation runtime template (#11212)", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        selectPreparedGatewayRuntime(source).replace(
          "ghcr.io/nvidia/openshell/supervisor@${manifestDigest}",
          "registry.invalid/openshell/supervisor@${manifestDigest}",
        ),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it("accepts the selected base-trusted OpenShell 0.0.116 supervisor identity (#11229)", () => {
    const result = runParser();

    expect(result.status, result.stderr).toBe(0);
  });

  // source-shape-contract: security -- Exact prospective supervisor runtime bytes must be base-authorized before trusted CI can admit the dependent state-resolver change
  it("accepts the prospective shared gateway state resolver template (#10544)", () => {
    const prospective = selectSharedGatewayStateResolver(SUPERVISOR_RUNTIME_TEMPLATE);
    expect(prospective).toContain("gatewayBinding.resolveGatewayStateDirForPort({");
    const result = runParser({ transformSupervisor: () => prospective });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an operational mutation of the base-trusted prospective supervisor fixture", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        selectSharedGatewayStateResolver(source).replace(
          "ghcr.io/nvidia/openshell/supervisor@${manifestDigest}",
          "registry.invalid/openshell/supervisor@${manifestDigest}",
        ),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it.each([["0.0.103", V00103_SUPERVISOR_MANIFEST_DIGEST]] as const)(
    "accepts the base-trusted OpenShell %s supervisor identity before version selection (#8893)",
    (version, digest) => {
      const result = runParser({
        transformSupervisor: (source) => addSupervisorManifestPin(source, version, digest),
      });

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("rejects a replacement supervisor digest", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(V00116_SUPERVISOR_MANIFEST_DIGEST, REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted identities");
    expect(result.stderr).toContain(REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST);
  });

  it("rejects a trusted supervisor digest remapped to another version", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        addSupervisorManifestPin(source, "0.0.104", V00103_SUPERVISOR_MANIFEST_DIGEST),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted identities");
    expect(result.stderr).toContain("|0.0.104|");
  });

  it("rejects the OpenShell 0.0.116 supervisor identity remapped to another release", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        addSupervisorManifestPin(source, "0.0.115", V00116_SUPERVISOR_MANIFEST_DIGEST),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted identities");
    expect(result.stderr).toContain(`|0.0.115|${V00116_SUPERVISOR_MANIFEST_DIGEST}`);
  });

  it("prevents a selector and candidate parser from self-authorizing a replacement image", () => {
    const result = runParser({
      candidateParserBypass: true,
      transformSupervisor: (source) =>
        source.replace(V00116_SUPERVISOR_MANIFEST_DIGEST, REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use only base-trusted identities");
    expect(result.stdout).not.toContain("CANDIDATE_PARSER_EXECUTED");
  });

  it("rejects removing a required supervisor identity", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(/^  "0\.0\.116": "sha256:[a-f0-9]{64}",\n/mu, ""),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `missing=[ghcr.io/nvidia/openshell/supervisor|0.0.116|${V00116_SUPERVISOR_MANIFEST_DIGEST}]`,
    );
  });

  it("rejects duplicate supervisor versions", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        addSupervisorManifestPin(source, "0.0.116", V00103_SUPERVISOR_MANIFEST_DIGEST),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains duplicate versions: 0.0.116");
  });

  it("rejects a supervisor resolver that changes the trusted image repository", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(
          "ghcr.io/nvidia/openshell/supervisor@${manifestDigest}",
          "registry.invalid/openshell/supervisor@${manifestDigest}",
        ),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it("rejects bypassing the trusted resolver at its gateway environment consumer", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(
          "getDockerSupervisorImage: () => getOpenShellDockerSupervisorImage(versionOutput)",
          'getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:latest"',
        ),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it("rejects a local map that shadows the parsed supervisor identities", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(
          "  function getOpenShellDockerSupervisorImage(",
          `  const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS = {
    "0.0.103": "${REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST}",
  } as const;

  function getOpenShellDockerSupervisorImage(`,
        ),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it("rejects a post-map mutation of a parsed supervisor identity", () => {
    const result = runParser({
      transformSupervisor: (source) =>
        source.replace(
          '\n};\nconst QUALIFIED_STABLE_OPENSHELL_VERSION = "0.0.116";\n\n/** Resolve the canonical gateway name',
          `
};
(OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS as Record<string, string>)["0.0.103"] =
  "${REPLACEMENT_SUPERVISOR_MANIFEST_DIGEST}";
const QUALIFIED_STABLE_OPENSHELL_VERSION = "0.0.116";

/** Resolve the canonical gateway name`,
        ),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supervisor runtime operational template is not base-trusted");
  });

  it("rejects a symbolic-link supervisor runtime input", () => {
    const result = runParser({ supervisorSymlink: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "supervisor runtime input must be a regular file and not a symbolic link",
    );
  });
});
