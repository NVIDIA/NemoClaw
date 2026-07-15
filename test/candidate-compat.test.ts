// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildCandidatePlan,
  type CandidateReceipt,
  downloadCandidateArtifact,
  finalizeEvidence,
  materializeCandidate,
  parseCandidatePlan,
  parseCandidateReceipt,
  resolveCandidate,
  verifyCandidateInvocations,
  verifyDigest,
  verifyObservedVersion,
} from "../tools/candidate-compat.mts";

const SHA = "a".repeat(40);
const VERSION = "0.0.82";
const E2E_SOURCES = readFileSync(resolve(".github/workflows/e2e.yaml"), "utf8");
const ASSETS = [
  { name: "openshell-x86_64-unknown-linux-musl.tar.gz", role: "cli" as const },
  {
    name: "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
    role: "gateway" as const,
  },
  {
    name: "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
    role: "sandbox" as const,
  },
];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function releaseMetadata() {
  return {
    assets: ASSETS.map(({ name }, index) => ({
      browser_download_url: `https://github.com/NVIDIA/OpenShell/releases/download/v${VERSION}/${name}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
      name,
    })),
    draft: false,
    id: 82,
    tag_name: `v${VERSION}`,
  };
}

function receipt(overrides: Partial<CandidateReceipt> = {}): CandidateReceipt {
  const base = {
    artifacts: ASSETS.map(({ name, role }, index) => ({
      digest: String(index + 1).repeat(64),
      digestAlgorithm: "sha256" as const,
      kind: "archive" as const,
      name,
      role,
      url: `https://github.com/NVIDIA/OpenShell/releases/download/v${VERSION}/${name}`,
    })),
    component: "openshell" as const,
    nemoclawSha: SHA,
    officialSource: "github:NVIDIA/OpenShell:release:82",
    requestedCandidate: `v${VERSION}`,
    resolutionId: "d".repeat(64),
    resolvedCandidate: VERSION,
    schemaVersion: 1 as const,
  };
  return { ...base, ...overrides };
}

describe("OpenShell candidate compatibility contract", () => {
  // source-shape-contract: security -- The controller is read-only and candidate code is isolated from provenance resolution.
  it("keeps the manual controller read-only and runs digest-bound deterministic and live lanes (#6691)", () => {
    const source = readFileSync(resolve(".github/workflows/candidate-compatibility.yaml"), "utf8");
    const workflow = parseYaml(source) as {
      jobs: Record<string, unknown>;
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
      "candidate",
      "component",
      "nemoclaw_ref",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "deterministic",
      "evidence",
      "live",
      "resolve",
    ]);
    expect(source).toContain("candidate compatibility must be dispatched from main");
    expect(source).toContain("path: controller");
    expect(source).toContain("path: candidate-source");
    expect(source).toContain("RESOLUTION_ID: ${{ needs.resolve.outputs.resolution_id }}");
    expect(source).toContain("verify-invocations");
    expect(source).toContain("openshell-gateway-auth-source-contract.test.ts");
    expect(source).not.toMatch(/\b(?:git push|gh pr|npm publish|docker push)\b/u);
  });

  it("rejects unsupported, ambiguous, and unsafe candidate input before metadata access (#6691)", async () => {
    const fetcher = async () => {
      throw new Error("metadata must not be fetched");
    };
    await expect(
      resolveCandidate({
        candidate: "latest",
        component: "openshell",
        fetcher,
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("exact version");
    await expect(
      resolveCandidate({
        candidate: "v1.2.3\nINJECTED=1",
        component: "openshell",
        fetcher,
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("unsafe characters");
    await expect(
      resolveCandidate({
        candidate: "1.2.3",
        component: "hermes",
        fetcher,
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("component must be one of: openshell");
  });

  it("binds all required Linux runtime assets to official release digests (#6691)", async () => {
    const fetcher = async () => response(releaseMetadata());
    const first = await resolveCandidate({
      candidate: `v${VERSION}`,
      component: "openshell",
      fetcher,
      nemoclawSha: SHA,
    });
    const rerun = await resolveCandidate({
      candidate: `v${VERSION}`,
      component: "openshell",
      fetcher,
      nemoclawSha: SHA,
    });
    expect(first).toEqual(rerun);
    expect(first.artifacts.map(({ name, role }) => ({ name, role }))).toEqual(ASSETS);
    expect(first.resolutionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseCandidateReceipt(first, first.resolutionId)).toEqual(first);
    expect(() =>
      parseCandidateReceipt(
        {
          ...first,
          artifacts: first.artifacts.map((item, index) =>
            index === 1 ? { ...item, url: "https://127.0.0.1/internal" } : item,
          ),
        },
        first.resolutionId,
      ),
    ).toThrow("approved official HTTPS host");
  });

  it("fails closed when any required asset or SHA-256 provenance is absent (#6691)", async () => {
    const missingGateway = releaseMetadata();
    missingGateway.assets = missingGateway.assets.filter(({ name }) => !name.includes("gateway"));
    await expect(
      resolveCandidate({
        candidate: VERSION,
        component: "openshell",
        fetcher: async () => response(missingGateway),
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("missing openshell-gateway");
    const missingDigest = releaseMetadata();
    missingDigest.assets[2]!.digest = "";
    await expect(
      resolveCandidate({
        candidate: VERSION,
        component: "openshell",
        fetcher: async () => response(missingDigest),
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("non-empty string");
  });

  it("validates the initial URL and every redirect before writing an artifact (#6691)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-download-"));
    const body = "candidate archive";
    const candidateArtifact = {
      ...receipt().artifacts[0]!,
      digest: createHash("sha256").update(body).digest("hex"),
    };
    try {
      await expect(
        downloadCandidateArtifact(
          { ...candidateArtifact, url: "http://127.0.0.1/internal" },
          directory,
          0,
          async () => {
            throw new Error("unapproved initial URL must not be fetched");
          },
        ),
      ).rejects.toThrow("not approved");
      const requests: string[] = [];
      await expect(
        downloadCandidateArtifact(candidateArtifact, directory, 0, async (url, init) => {
          requests.push(url);
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            headers: { location: "http://127.0.0.1/internal" },
            status: 302,
          });
        }),
      ).rejects.toThrow("not approved");
      expect(requests).toEqual([candidateArtifact.url]);
      const target = await downloadCandidateArtifact(
        candidateArtifact,
        directory,
        0,
        async () => new Response(body),
      );
      expect(basename(target)).toBe("candidate-0.tar.gz");
      expect(readFileSync(target, "utf8")).toBe(body);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("materializes exact runtime binaries and records real wrapper invocations (#6691)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-materialize-"));
    const archives = new Map<string, Uint8Array>();
    try {
      const assets = receipt().artifacts.map((artifact) => {
        const binaryName = artifact.role === "cli" ? "openshell" : `openshell-${artifact.role}`;
        const source = join(directory, binaryName);
        const features =
          artifact.role === "cli"
            ? "# request-body-credential-rewrite websocket-credential-rewrite"
            : artifact.role === "sandbox"
              ? "# allow_all_known_mcp_methods"
              : "";
        writeFileSync(
          source,
          `#!/bin/sh\n${features}\nprintf '%s\\n' '${binaryName} ${VERSION}'\n`,
        );
        chmodSync(source, 0o700);
        const archive = join(directory, `${artifact.role}-exact.tar.gz`);
        expect(spawnSync("tar", ["-czf", archive, "-C", directory, binaryName]).status).toBe(0);
        const bytes = readFileSync(archive);
        archives.set(artifact.url, bytes);
        return {
          browser_download_url: artifact.url,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          name: artifact.name,
        };
      });
      const candidateReceipt = await resolveCandidate({
        candidate: `v${VERSION}`,
        component: "openshell",
        fetcher: async () => response({ assets, draft: false, id: 82, tag_name: `v${VERSION}` }),
        nemoclawSha: SHA,
      });
      const observed = await materializeCandidate(
        candidateReceipt,
        join(directory, "runtime"),
        async (url) => new Response(archives.get(url)),
      );
      const log = join(directory, "invocations.log");
      const env = {
        ...process.env,
        NEMOCLAW_CANDIDATE_INVOCATION_CONTEXT: `installer:${candidateReceipt.resolutionId}`,
        NEMOCLAW_CANDIDATE_INVOCATION_LOG: log,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: join(observed.binDirectory, "openshell-gateway"),
        NEMOCLAW_OPENSHELL_MAX_VERSION: VERSION,
        NEMOCLAW_OPENSHELL_MIN_VERSION: VERSION,
        NEMOCLAW_OPENSHELL_PIN_VERSION: VERSION,
        NEMOCLAW_OPENSHELL_SANDBOX_BIN: join(observed.binDirectory, "openshell-sandbox"),
        PATH: `${observed.binDirectory}:/usr/bin:/bin`,
      };
      const installer = spawnSync("bash", [resolve("scripts/install-openshell.sh")], {
        encoding: "utf8",
        env,
      });
      expect(installer.status, `${installer.stdout}\n${installer.stderr}`).toBe(0);
      expect(installer.stdout).toContain(`openshell already installed: ${VERSION}`);
      expect(
        verifyCandidateInvocations({
          invocationLog: readFileSync(log, "utf8"),
          lane: "installer",
          receipt: candidateReceipt,
        }),
      ).toMatchObject({ conclusion: "success", observedVersion: VERSION });
      expect(() =>
        verifyCandidateInvocations({
          invocationLog: `gateway\tlive:openshell-gateway-auth-contract:${candidateReceipt.resolutionId}\t--version\n`,
          lane: "live:openshell-gateway-auth-contract",
          receipt: candidateReceipt,
        }),
      ).toThrow("did not start the candidate runtime");
      expect(() =>
        verifyCandidateInvocations({
          invocationLog:
            "cli\tpreflight\t--version\ngateway\tpreflight\t--version\nsandbox\tpreflight\t--version\n",
          lane: "installer",
          receipt: candidateReceipt,
        }),
      ).toThrow("receipt-bound cli");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("selects only candidate-aware deterministic and live lanes (#6691)", () => {
    const plan = buildCandidatePlan("openshell", E2E_SOURCES);
    expect(parseCandidatePlan(plan, "openshell")).toEqual(plan);
    expect(
      plan.deterministic.filter(({ status }) => status === "selected").map(({ id }) => id),
    ).toEqual(["installer"]);
    expect(plan.live).toEqual([
      expect.objectContaining({
        id: "openshell-gateway-auth-contract",
        selector: "job",
        status: "selected",
      }),
    ]);
    expect(() => parseCandidatePlan({ ...plan, deterministic: [], live: [] }, "openshell")).toThrow(
      "every deterministic lane",
    );
  });

  it("rejects an empty persisted plan through the finalize CLI (#6691)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-finalize-"));
    try {
      const candidateReceipt = await resolveCandidate({
        candidate: `v${VERSION}`,
        component: "openshell",
        fetcher: async () => response(releaseMetadata()),
        nemoclawSha: SHA,
      });
      const receiptPath = join(directory, "receipt.json");
      const planPath = join(directory, "plan.json");
      const resultsPath = join(directory, "results");
      writeFileSync(receiptPath, JSON.stringify(candidateReceipt));
      writeFileSync(
        planPath,
        JSON.stringify({
          component: "openshell",
          deterministic: [],
          live: [],
          schemaVersion: 1,
        }),
      );
      mkdirSync(resultsPath);
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          resolve("tools/candidate-compat.mts"),
          "finalize",
          "--receipt",
          receiptPath,
          "--resolution-id",
          candidateReceipt.resolutionId,
          "--plan",
          planPath,
          "--results",
          resultsPath,
          "--run-id",
          "123",
          "--attempt",
          "1",
          "--output",
          join(directory, "evidence.json"),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("every deterministic lane exactly once");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("finalizes only complete receipt-bound deterministic and live evidence (#6691)", () => {
    const plan = buildCandidatePlan("openshell", E2E_SOURCES);
    const candidateReceipt = receipt();
    const results = ["installer", "live:openshell-gateway-auth-contract"].map((lane) => ({
      conclusion: "success" as const,
      lane,
      observedOutput: `openshell ${VERSION}`,
      observedVersion: VERSION,
      resolutionId: candidateReceipt.resolutionId,
    }));
    expect(
      finalizeEvidence({
        attempt: "2",
        plan,
        receipt: candidateReceipt,
        results,
        runId: "123",
      }),
    ).toMatchObject({ overall: "success", schemaVersion: 1 });
    expect(() =>
      finalizeEvidence({
        attempt: "2",
        plan,
        receipt: candidateReceipt,
        results: results.slice(1),
        runId: "123",
      }),
    ).toThrow("every selected compatibility lane");
    expect(() =>
      finalizeEvidence({
        attempt: "2",
        plan,
        receipt: candidateReceipt,
        results: [{ ...results[0]!, resolutionId: "f".repeat(64) }, results[1]!],
        runId: "123",
      }),
    ).toThrow("different candidate resolution");
  });

  it("detects digest and runtime version mismatches (#6691)", () => {
    expect(() =>
      verifyDigest(new TextEncoder().encode("candidate"), receipt().artifacts[0]!),
    ).toThrow("sha256 mismatch");
    expect(() => verifyObservedVersion(receipt(), "openshell 0.0.81")).toThrow(
      `does not match ${VERSION}`,
    );
  });
});
