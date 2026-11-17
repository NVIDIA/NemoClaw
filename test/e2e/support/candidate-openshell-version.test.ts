// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import * as installerPins from "../../../scripts/checks/extract-installer-pins.mts";
import { runCandidateOpenShellCli } from "../../support/candidate-openshell-version-cli";
import evidence from "../fixtures/openshell-runtime-provenance-v0.1.7.json" with { type: "json" };
import {
  candidateOpenShellVersion,
  reviewedOpenShellMcpRuntime,
} from "../../../tools/e2e/candidate-openshell-version.mts";

const sha = "a".repeat(40);
const repository = "NVIDIA/NemoClaw";
const blueprint = readFileSync(
  new URL("../../../nemoclaw-blueprint/blueprint.yaml", import.meta.url),
  "utf8",
);
const blueprintVersions = [...blueprint.matchAll(/^max_openshell_version: "(\d+\.\d+\.\d+)"$/gm)];
assert.equal(blueprintVersions.length, 1, "Expected one blueprint OpenShell pin");
const pinnedVersion = blueprintVersions[0]![1]!;
// Independent upstream evidence is the oracle; production must not read this test fixture.
const expected017Runtime = {
  supervisorImage: evidence.supervisor.image,
  provenance: {
    schemaVersion: 1,
    sourceRepository: evidence.source.repository,
    releaseTag: evidence.releaseTag,
    sourceSha: evidence.source.commit,
    artifacts: {
      cli: { binarySha256: evidence.artifacts.cli.binarySha256 },
      gateway: { binarySha256: evidence.artifacts.gateway.binarySha256 },
      standaloneSandbox: { binarySha256: evidence.artifacts.standaloneSandbox.binarySha256 },
    },
  },
};
function sourceResponse(url: string) {
  const parsed = new URL(url, "https://api.github.com");
  expect(parsed.searchParams.get("ref")).toBe(sha);
  const path = parsed.pathname.replace(`/repos/${repository}/contents/`, "");
  const source = readFileSync(new URL(`../../../${path}`, import.meta.url));
  return {
    type: "file",
    path,
    encoding: "base64",
    size: source.length,
    content: source.toString("base64"),
  };
}

describe("candidate OpenShell selection", () => {
  it("reads only immutable candidate data and selects the reviewed runtime", async () => {
    const request = vi.fn(async (url: string) => sourceResponse(url));
    await expect(candidateOpenShellVersion(repository, sha, request)).resolves.toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      scenario: "current trusted release",
      upgradeVersion: undefined,
      expectedVersion: pinnedVersion,
    },
    { scenario: "reviewed 0.1.7", upgradeVersion: "0.1.7", expectedVersion: "0.1.7" },
    {
      scenario: "already selected release",
      upgradeVersion: pinnedVersion,
      expectedVersion: pinnedVersion,
    },
  ])(
    "passes candidate selection through the MCP CLI output for $scenario",
    async ({ upgradeVersion, expectedVersion }) => {
      const actual = await runCandidateOpenShellCli({ upgradeVersion });
      const expected =
        expectedVersion === "0.1.7"
          ? expected017Runtime
          : reviewedOpenShellMcpRuntime(expectedVersion);
      expect(actual.selected).toBe(expectedVersion);
      expect(actual.status, actual.diagnostic).toBe(0);
      expect(actual.emitted.version).toBe(expectedVersion);
      expect(actual.emitted.supervisor_image).toBe(expected.supervisorImage);
      expect(JSON.parse(actual.emitted.runtime_provenance!)).toEqual(expected.provenance);
    },
  );

  it("rejects an unapproved candidate upgrade before emitting MCP CLI output", async () => {
    const actual = await runCandidateOpenShellCli({ upgradeVersion: "9.8.7", approved: false });
    expect(actual.status, actual.diagnostic).toBe(1);
    expect(actual.stderr).toContain("approval");
    expect(actual.outputExists).toBe(false);
  });

  it("returns the trusted verifier's selection without substituting a workflow pin", async () => {
    const verifier = vi.spyOn(installerPins, "validateInstallerSources").mockReturnValueOnce({
      releaseVersion: "9.8.7",
      pins: [],
      installerReleases: [],
      installerTemplateSha256: "",
      brevTemplateSha256: "",
    });
    try {
      await expect(
        candidateOpenShellVersion(repository, sha, async (url) => {
          const blob = sourceResponse(url);
          const source = `fixture ${blob.path}`;
          return { ...blob, content: Buffer.from(source).toString("base64"), size: source.length };
        }),
      ).resolves.toBe("9.8.7");
      expect(verifier).toHaveBeenCalledExactlyOnceWith({
        blueprintSource: "fixture nemoclaw-blueprint/blueprint.yaml",
        installerSource: "fixture scripts/install-openshell.sh",
        brevInstallerSource: "fixture scripts/brev-launchable-ci-cpu.sh",
        supervisorRuntimeSource: "fixture src/lib/onboard/docker-driver-gateway-runtime.ts",
      });
    } finally {
      verifier.mockRestore();
    }
  });

  it.each(["main", "a".repeat(39), `${sha}\nversion=9.9.9`])(
    "rejects mutable or malformed revision %s",
    async (revision) => {
      const request = vi.fn();
      await expect(candidateOpenShellVersion(repository, revision, request)).rejects.toThrow(
        "exact",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects a fork before reading it", async () => {
    const request = vi.fn();
    await expect(candidateOpenShellVersion("other/NemoClaw", sha, request)).rejects.toThrow(
      "exact",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { type: "symlink" },
    { size: 1024 * 1024 + 1 },
    { encoding: "none" },
    { path: "other" },
    { content: "AA==" },
    { size: 0 },
  ])("rejects invalid candidate files %j", async (mutation) => {
    await expect(
      candidateOpenShellVersion(repository, sha, async (url) => ({
        ...sourceResponse(url),
        ...mutation,
      })),
    ).rejects.toThrow("Invalid candidate");
  });

  it("propagates API failure without falling back to main", async () => {
    await expect(
      candidateOpenShellVersion(repository, sha, async () => {
        throw new Error("API denied");
      }),
    ).rejects.toThrow("API denied");
  });

  it.each([
    {
      name: "unknown release",
      target: /.*/,
      rewrite: (source: string) => source.replaceAll(pinnedVersion, "9.9.9"),
    },
    {
      name: "mismatched blueprint",
      target: /blueprint\.yaml$/,
      rewrite: (source: string) =>
        source.replace(/max_openshell_version: .*/, 'max_openshell_version: "9.9.9"'),
    },
    {
      name: "modified installer",
      target: /install-openshell\.sh$/,
      rewrite: (source: string) => `${source}\nprintf "unreviewed command"\n`,
    },
  ])("rejects $name through the trusted verifier", async ({ target, rewrite }) => {
    await expect(
      candidateOpenShellVersion(repository, sha, async (url) => {
        const blob = sourceResponse(url);
        const original = Buffer.from(blob.content, "base64").toString("utf8");
        const source = target.test(blob.path) ? rewrite(original) : original;
        return {
          ...blob,
          size: Buffer.byteLength(source),
          content: Buffer.from(source).toString("base64"),
        };
      }),
    ).rejects.toThrow();
  });
});

function prepareRuntimeFixture(
  directory: string,
  version: string,
  job: string,
  location = "local",
) {
  const runtime = reviewedOpenShellMcpRuntime(version);
  const workflow = YAML.parse(readFileSync(".github/workflows/e2e.yaml", "utf8"));
  const home = join(directory, "home");
  const bin = { local: join(home, ".local", "bin"), path: join(directory, "active-bin") }[
    location
  ]!;
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts/install-openshell.sh"), "exit 0\n");
  for (const [role, binary] of [
    ["cli", "openshell"],
    ["gateway", "openshell-gateway"],
    ["standaloneSandbox", "openshell-sandbox"],
  ] as const) {
    const bytes = Buffer.from(`fixture ${binary}`);
    writeFileSync(join(bin, binary), bytes, { mode: 0o755 });
    runtime.provenance.artifacts[role].binarySha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");
  }
  const step = workflow.jobs[job].steps.find(
    (step: { name: string }) => step.name === "Install OpenShell CLI",
  );
  return {
    runtime,
    bin,
    run: () =>
      spawnSync("bash", ["-c", step.run], {
        cwd: directory,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          E2E_ARTIFACT_DIR: directory,
          NEMOCLAW_MCP_BRIDGE_AGENT: "deepagents",
          OPENSHELL_RUNTIME_PROVENANCE: JSON.stringify(runtime.provenance),
        },
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}

describe("reviewed candidate MCP runtime evidence", () => {
  it("binds OpenShell 0.1.5 to the verified upstream release artifacts", () => {
    expect(reviewedOpenShellMcpRuntime("0.1.5")).toEqual({
      supervisorImage:
        "ghcr.io/nvidia/openshell/supervisor@sha256:fabcd01f656e9d23df4386f82e80b4f48b90f3452d7d5c58889007643a069161",
      provenance: {
        schemaVersion: 1,
        sourceRepository: "NVIDIA/OpenShell",
        releaseTag: "v0.1.5",
        sourceSha: "bdb956f2cd65a635f1294fccf1d138d263bf650f",
        artifacts: {
          cli: {
            binarySha256: "446f766842d2bf03abc37b56a3f5a3e46b96140b5b6c305d3f168d67921fd271",
          },
          gateway: {
            binarySha256: "c8fa78fd49f245978f64d038207ce0205d98fcdd48bf115bae8a0b9f4f4d5003",
          },
          standaloneSandbox: {
            binarySha256: "65aa2a2afb96e7d1351c1d197ded7a966e20bcad68e18a58a94621a8f23769bc",
          },
        },
      },
    });
  });

  it("binds OpenShell 0.1.7 to the reviewed upstream release evidence", () => {
    expect(evidence.releaseTag).toBe("v0.1.7");
    expect(reviewedOpenShellMcpRuntime("0.1.7")).toEqual(expected017Runtime);
  });

  it.each(
    [
      ["0.0.116", "mcp-bridge", "mcp-bridge-deepagents"],
      [
        "0.0.116",
        "openshell-credential-generation-window",
        "openshell-credential-generation-window",
      ],
      ["0.1.2", "mcp-bridge", "mcp-bridge-deepagents"],
      ["0.1.2", "openshell-credential-generation-window", "openshell-credential-generation-window"],
      ["0.1.3", "mcp-bridge", "mcp-bridge-deepagents"],
      ["0.1.3", "openshell-credential-generation-window", "openshell-credential-generation-window"],
      ["0.1.5", "mcp-bridge", "mcp-bridge-deepagents"],
      ["0.1.5", "openshell-credential-generation-window", "openshell-credential-generation-window"],
      ["0.1.7", "mcp-bridge", "mcp-bridge-deepagents"],
      ["0.1.7", "openshell-credential-generation-window", "openshell-credential-generation-window"],
    ].flatMap(([version, job, artifact]) => [
      [version, job, artifact, "local"],
      [version, job, artifact, "path"],
    ]),
  )(
    "records %s provenance after the %s installer produces matching binaries in %s with %s selection",
    (version, job, artifact, location) => {
      const directory = mkdtempSync(join(tmpdir(), "nemoclaw-mcp-provenance-"));
      try {
        const fixture = prepareRuntimeFixture(directory, version, job, location);
        const result = fixture.run();
        expect(result.status, result.stderr).toBe(0);
        const saved = JSON.parse(
          readFileSync(join(directory, artifact, "openshell-exact-main-provenance.json"), "utf8"),
        );
        expect(saved).toEqual(fixture.runtime.provenance);
        expect(saved.releaseTag).toBe(`v${version}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [
      ["mcp-bridge", "mcp-bridge-deepagents", "cli", "openshell"],
      ["mcp-bridge", "mcp-bridge-deepagents", "gateway", "openshell-gateway"],
      ["mcp-bridge", "mcp-bridge-deepagents", "standaloneSandbox", "openshell-sandbox"],
      [
        "openshell-credential-generation-window",
        "openshell-credential-generation-window",
        "cli",
        "openshell",
      ],
      [
        "openshell-credential-generation-window",
        "openshell-credential-generation-window",
        "gateway",
        "openshell-gateway",
      ],
      [
        "openshell-credential-generation-window",
        "openshell-credential-generation-window",
        "standaloneSandbox",
        "openshell-sandbox",
      ],
    ].flatMap(([job, artifact, role, binary]) => [
      [binary, job, artifact, "0.1.5", role],
      [binary, job, artifact, "0.1.7", role],
    ]),
  )(
    "rejects an altered %s binary in %s before writing %s provenance for OpenShell %s (%s)",
    (binary, job, artifact, version, role) => {
      const directory = mkdtempSync(join(tmpdir(), "nemoclaw-mcp-provenance-"));
      try {
        const fixture = prepareRuntimeFixture(directory, version, job);
        writeFileSync(join(fixture.bin, binary), "altered binary");
        const result = fixture.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `Installed OpenShell ${role} differs from reviewed provenance`,
        );
        expect(existsSync(join(directory, artifact, "openshell-exact-main-provenance.json"))).toBe(
          false,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["9.9.9", "0.1.3\nsupervisor_image=unreviewed", "", "__proto__"])(
    "rejects runtime evidence without a reviewed release: %j",
    (version) => {
      expect(() => reviewedOpenShellMcpRuntime(version)).toThrow(
        "no reviewed MCP runtime provenance",
      );
    },
  );
});
