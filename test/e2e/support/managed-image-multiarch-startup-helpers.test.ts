// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DOCKER_ENGINE_27_MINIMUM_CLEANUP_PROCESS_TIMEOUT_MS,
  DOCKER_ENGINE_27_MINIMUM_PROBE_TIMEOUT_MS,
  dockerEngine27ReceiptDaemonName,
  dockerEngine27ReceiptIdentityArguments,
  finalizeDockerEngine27ReceiptProbe,
  requireDockerResourceAbsent,
  validateDockerEngine27SeedIsolation,
} from "../../../scripts/checks/docker-engine-27-receipt-transfer-e2e.ts";
import {
  protectedManagedImageDispatchEnvironment,
  qualifyProtectedHermesEvidence,
  readRegularArtifact,
} from "../live/managed-image-multiarch-startup-helpers.ts";

const sha = "a".repeat(40);
let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-multiarch-helper-"));
  const artifacts = path.join(temporaryRoot, "artifacts");
  fs.mkdirSync(artifacts);
  vi.stubEnv("E2E_ARTIFACT_DIR", artifacts);
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_WORKSPACE", temporaryRoot);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "protected-123-1");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT", path.join(artifacts, "contract.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE", path.join(artifacts, "evidence.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM", "linux/amd64");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA", sha);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("protected managed-image startup helpers", () => {
  it("preserves the probe failure and attempts fixture cleanup after daemon cleanup fails", () => {
    const cleanupFixture = vi.fn();

    expect(() =>
      finalizeDockerEngine27ReceiptProbe(
        new Error("receipt transfer failed"),
        () => {
          throw new Error("daemon cleanup failed");
        },
        cleanupFixture,
      ),
    ).toThrow(/receipt transfer failed.*daemon cleanup failed/u);
    expect(cleanupFixture).toHaveBeenCalledOnce();
  });

  it("derives one Docker 27 identity for probe and cleanup on each matrix platform", () => {
    const amd64 = dockerEngine27ReceiptDaemonName(123, 4, "linux/amd64");
    const arm64 = dockerEngine27ReceiptDaemonName(123, 4, "linux/arm64");
    const sharedIdentity = dockerEngine27ReceiptIdentityArguments(123, 4, "linux/amd64");
    const probeArgs = ["docker-engine-27-receipt-transfer-e2e.ts", ...sharedIdentity];
    const cleanupArgs = [
      "docker-engine-27-receipt-transfer-e2e.ts",
      "--cleanup-only",
      ...sharedIdentity,
    ];

    expect(amd64).toBe("nemoclaw-receipt-engine27-123-4-linux-amd64");
    expect(arm64).toBe("nemoclaw-receipt-engine27-123-4-linux-arm64");
    expect(amd64).not.toBe(arm64);
    expect(cleanupArgs.filter((arg) => arg !== "--cleanup-only")).toEqual(probeArgs);
    expect(sharedIdentity).toEqual([
      "--run-id",
      "123",
      "--run-attempt",
      "4",
      "--platform",
      "linux/amd64",
    ]);
  });

  it("bounds the complete Docker 27 probe and external cleanup", () => {
    expect(30 * 60_000).toBeGreaterThanOrEqual(DOCKER_ENGINE_27_MINIMUM_PROBE_TIMEOUT_MS);
    expect(90_000).toBeGreaterThanOrEqual(DOCKER_ENGINE_27_MINIMUM_CLEANUP_PROCESS_TIMEOUT_MS);
  });

  it("requires numeric root and every receipt seed isolation control", () => {
    const secureSeed = {
      Config: { User: "0" },
      HostConfig: {
        CapDrop: ["ALL"],
        Mounts: [
          {
            Type: "volume",
            Target: "/run/nemoclaw/managed-startup-receipt-transfer",
          },
        ],
        NetworkMode: "none",
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
      },
    };

    expect(() => validateDockerEngine27SeedIsolation(secureSeed)).not.toThrow();
    expect(() =>
      validateDockerEngine27SeedIsolation({ ...secureSeed, Config: { User: "0:0" } }),
    ).toThrow("receipt seed did not use numeric root");
    expect(() =>
      validateDockerEngine27SeedIsolation({
        ...secureSeed,
        HostConfig: { ...secureSeed.HostConfig, Privileged: true },
      }),
    ).toThrow("receipt seed was privileged");
    expect(() =>
      validateDockerEngine27SeedIsolation({
        ...secureSeed,
        HostConfig: { ...secureSeed.HostConfig, CapDrop: [] },
      }),
    ).toThrow("receipt seed retained capabilities");
  });

  it("proves cleanup only from Docker's explicit absence response", () => {
    expect(() =>
      requireDockerResourceAbsent(
        { status: 1, stderr: "Error: No such container: receipt-seed", stdout: "" },
        "receipt seed",
      ),
    ).not.toThrow();
    expect(() =>
      requireDockerResourceAbsent(
        {
          error: new Error("spawnSync docker ETIMEDOUT"),
          status: null,
          stderr: "",
          stdout: "",
        },
        "receipt seed",
      ),
    ).toThrow("receipt seed absence was not proven");
    expect(() =>
      requireDockerResourceAbsent(
        { status: 1, stderr: "permission denied", stdout: "" },
        "receipt seed",
      ),
    ).toThrow("receipt seed absence was not proven");
  });

  it("parses exact protected dispatch identity", () => {
    expect(protectedManagedImageDispatchEnvironment()).toMatchObject({
      baseSha: sha,
      cohort: "protected-123-1",
      headSha: sha,
      platform: "linux/amd64",
      runAttempt: 1,
      runId: 123,
      workflowSha: sha,
    });
  });

  it("rejects identity values outside the canonical contract", () => {
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "other-123-1");
    expect(() => protectedManagedImageDispatchEnvironment()).toThrow(
      "protected managed-image dispatch identity is invalid",
    );
  });

  it("requires an explicit protected candidate head independent of PR risk signals", () => {
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA", "");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", sha);

    expect(() => protectedManagedImageDispatchEnvironment()).toThrow(
      "NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA is required",
    );
  });

  it("reads a bounded file through its opened descriptor and rejects a symlink", () => {
    const artifacts = path.join(temporaryRoot, "artifacts");
    const artifact = path.join(artifacts, "contract.json");
    const symlink = path.join(artifacts, "contract-link.json");
    fs.writeFileSync(artifact, '{"contractVersion":1}');
    fs.symlinkSync(artifact, symlink);

    expect(readRegularArtifact(artifact, artifacts).toString("utf8")).toBe('{"contractVersion":1}');
    expect(() => readRegularArtifact(symlink, artifacts)).toThrow();
  });
});

function protectedEvidence(platform: "linux/amd64" | "linux/arm64") {
  const contracts = ["openclaw", "hermes", "langchain-deepagents-code"].map((agent, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    const base = agent === "openclaw" ? "sandbox-base" : `${agent}-sandbox-base`;
    return {
      agent,
      digest,
      platform,
      reference: `localhost:5000/nemoclaw-managed-protected/${agent}@${digest}`,
      localContentId: `sha256:${String(index + 4).repeat(64)}`,
      baseReference: `ghcr.io/nvidia/nemoclaw/${base}@sha256:${String(index + 7).repeat(64)}`,
    };
  });
  const identity = {
    baseSha: sha,
    headSha: sha,
    workflowSha: sha,
    platform,
    cohort: "protected-123-1",
    runId: 123,
    runAttempt: 1,
  };
  return {
    identity,
    evidence: {
      kind: "nemoclaw-protected-managed-image-multiarch-v1",
      ...identity,
      run: { id: 123, attempt: 1 },
      contracts,
      contractSha256: `sha256:${"d".repeat(64)}`,
      directRuns: contracts.map(({ agent, digest, platform, reference }) => ({
        agent,
        digest,
        platform,
        reference,
      })),
    },
  };
}

describe("protected Hermes evidence from a trusted older workflow", () => {
  it("accepts existing native qualification without running the image again (#13809)", async () => {
    const { identity, evidence } = protectedEvidence("linux/amd64");
    const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
    const value = {
      ...source,
      directRuns: source.directRuns.map((run) =>
        run.agent === "hermes" ? { ...run, hermesDiscordStatus: "passed" } : run,
      ),
    };
    const qualify = vi.fn(async () => {});
    await expect(qualifyProtectedHermesEvidence(value, identity, qualify)).resolves.toMatchObject({
      directRuns: value.directRuns,
    });
    expect(qualify).not.toHaveBeenCalled();
  });

  it.each(["linux/amd64", "linux/arm64"] as const)(
    "qualifies the immutable Hermes image on %s before accepting legacy evidence (#13809)",
    async (platform) => {
      const { identity, evidence } = protectedEvidence(platform);
      const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
      const qualify = vi.fn(async () => {});
      const qualified = await qualifyProtectedHermesEvidence(source, identity, qualify);
      expect(qualify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agent: "hermes",
          reference: evidence.contracts[1]!.reference,
          platform,
        }),
      );
      expect(qualified.directRuns[1]).toMatchObject({ hermesDiscordStatus: "passed" });
      expect(source.directRuns[1]).not.toHaveProperty("hermesDiscordStatus");
    },
  );

  it("preserves native contract failure instead of qualifying the image (#13809)", async () => {
    const { identity, evidence } = protectedEvidence("linux/amd64");
    const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
    const failure = new Error("native writer failed");
    await expect(
      qualifyProtectedHermesEvidence(source, identity, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("rejects a mismatched identity before executing the image (#13809)", async () => {
    const { identity, evidence } = protectedEvidence("linux/amd64");
    const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
    const qualify = vi.fn(async () => {});
    await expect(
      qualifyProtectedHermesEvidence({ ...source, headSha: "b".repeat(40) }, identity, qualify),
    ).rejects.toThrow("identity is invalid");
    expect(qualify).not.toHaveBeenCalled();
  });

  it.each(["failed", null])(
    "preserves an explicit native result %s from the producer (#13809)",
    async (result) => {
      const { identity, evidence } = protectedEvidence("linux/amd64");
      const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
      const value = {
        ...source,
        directRuns: source.directRuns.map((run) =>
          run.agent === "hermes" ? { ...run, hermesDiscordStatus: result } : run,
        ),
      };
      const qualify = vi.fn(async () => {});
      await expect(qualifyProtectedHermesEvidence(value, identity, qualify)).rejects.toThrow();
      expect(qualify).not.toHaveBeenCalled();
    },
  );
});

it.each(["linux/amd64", "linux/arm64"] as const)(
  "runs legacy Hermes qualification through the live consumer on %s (#13809)",
  async (platform) => {
    const { identity, evidence } = protectedEvidence(platform);
    const { runId: _runId, runAttempt: _attempt, ...source } = evidence;
    const contractBytes = Buffer.from(JSON.stringify(source.contracts));
    source.contractSha256 = `sha256:${createHash("sha256").update(contractBytes).digest("hex")}`;
    const artifactDirectory = path.join(temporaryRoot, "artifacts");
    fs.writeFileSync(path.join(artifactDirectory, "contract.json"), contractBytes);
    fs.writeFileSync(path.join(artifactDirectory, "evidence.json"), JSON.stringify(source));
    fs.mkdirSync(path.join(temporaryRoot, "ci"));
    fs.writeFileSync(
      path.join(temporaryRoot, "ci/protected-managed-image-multiarch-activation-v1.json"),
      JSON.stringify({
        agents: source.contracts.map(({ agent }) => agent),
        contractVersion: 1,
        jobId: "managed-image-multiarch-startup",
        platforms: ["linux/amd64", "linux/arm64"],
      }),
    );
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM", identity.platform);
    let run: (fixtures: unknown) => Promise<void> = async () => {
      throw new Error("live consumer was not registered");
    };
    vi.doMock("../fixtures/e2e-test.ts", () => ({
      expect,
      test: (_name: string, _options: unknown, callback: typeof run) => {
        run = callback;
      },
    }));
    const shell = vi.fn(async () => ({ exitCode: 0, timedOut: false }));
    try {
      vi.resetModules();
      await import("../live/managed-image-multiarch-startup.test.ts");
      await run({
        cleanup: { trackDisposable() {} },
        progress: { phase() {} },
        shellProbe: { run: shell },
      });
      expect(
        shell.mock.calls.map((call) => (call as unknown as [{ args: string[] }])[0].args),
      ).toEqual([
        ["run", "build:cli"],
        [
          "--import",
          "tsx",
          "scripts/checks/run-hermes-discord-runtime-contract.mts",
          "--image",
          source.contracts[1]!.reference,
          "--platform",
          platform,
        ],
        expect.arrayContaining(["scripts/checks/docker-engine-27-receipt-transfer-e2e.ts"]),
      ]);
    } finally {
      vi.doUnmock("../fixtures/e2e-test.ts");
      vi.resetModules();
    }
  },
);
