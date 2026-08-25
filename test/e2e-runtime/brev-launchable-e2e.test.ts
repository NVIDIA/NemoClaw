// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  candidateSha,
  cleanupFixtures,
  emittedOutput,
  fixture,
  run,
} from "../helpers/brev-launchable-e2e-fixture";

afterEach(() => {
  cleanupFixtures();
  vi.unstubAllEnvs();
});

function identitySmokeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY: "1",
  };
  delete result.NVIDIA_INFERENCE_API_KEY;
  return result;
}

describe("focused staging Brev Launchable lane", () => {
  it("runs the strict lane without inherited lane controls (#9925)", () => {
    vi.stubEnv("BREV_CREATE_RECONCILE_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_BREV_DEFER_CLEANUP", "1");
    vi.stubEnv("NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY", "1");
    vi.stubEnv("NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY", "1");

    const { calls, env } = fixture();
    expect(env).not.toHaveProperty("BREV_CREATE_RECONCILE_SECONDS");
    expect(env).not.toHaveProperty("NEMOCLAW_BREV_DEFER_CLEANUP");
    expect(env).not.toHaveProperty("NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY");
    expect(env).not.toHaveProperty("NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY");

    const result = run(env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(calls, "utf8")).toContain("ssh preinstalled full-e2e.test.ts");
  });

  it("rejects explicit deferred cleanup when ambient identity mode is set (#9925)", () => {
    vi.stubEnv("NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY", "1");

    const { calls, env, workDir } = fixture();
    const result = run({ ...env, NEMOCLAW_BREV_DEFER_CLEANUP: "1" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(
      "deferred cleanup is accepted only in identity-smoke mode",
    );
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("publishes exact image evidence without Brev or inference access (#8924)", () => {
    const { calls, env, state, workDir } = fixture();
    const imageOnlyEnv: NodeJS.ProcessEnv = {
      ...env,
      NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "1",
    };
    delete imageOnlyEnv.BREV_API_KEY;
    delete imageOnlyEnv.BREV_LAUNCHABLE_ID;
    delete imageOnlyEnv.INSTANCE_NAME;
    delete imageOnlyEnv.NVIDIA_INFERENCE_API_KEY;
    const result = run(imageOnlyEnv);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).not.toMatch(/\bbrev\b|\bssh\b|sleep 300|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual(["lane.log", "launchable-image.json"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-image.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      kind: "nemoclaw-staging-launchable-image-v1",
      candidateSha,
      producer: {
        repository: "brevdev/nemoclaw-image",
        workflow: ".github/workflows/build-launchable-e2e-image.yml",
        runId: "123",
        status: "success",
      },
      image: {
        uri: "projects/brevdevprod/global/images/nemoclaw-test-image",
        family: "nemoclaw-brev-staging-cpu",
        imageRepositorySha: "b".repeat(40),
      },
      validation: {
        launchable: "not-run",
        runtime: "not-run",
        inference: "not-run",
      },
    });
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Launchable deployment, runtime, and inference validation did not run",
    );

    const wrongReceipt = fixture({ receiptSha: "b".repeat(40) });
    const wrongResult = run({
      ...wrongReceipt.env,
      NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "1",
    });
    expect(wrongResult.status).not.toBe(0);
    expect(wrongResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(wrongReceipt.calls, "utf8")).not.toMatch(/\bbrev\b|\bssh\b/u);
    expect(fs.existsSync(path.join(wrongReceipt.workDir, "launchable-image.json"))).toBe(false);
  });

  it("rejects an invalid image-publication mode before dispatch (#8924)", () => {
    const { calls, env, workDir } = fixture();
    const result = run({ ...env, NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "yes" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(
      "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY must be 0 or 1",
    );
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("boots the exact Launchable image, verifies its identity, and confirms workspace absence without inference (#9925)", () => {
    const { calls, env, state, workDir } = fixture();
    const result = run(identitySmokeEnv(env));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).toContain("create nclaw-e2e-test-1 --launchable env-staging123");
    expect(commands).toContain("ssh readiness attempt 1");
    expect(commands).toContain("NEMOCLAW_BOOT_IMAGE");
    expect(commands).toContain("repo_clean");
    expect(commands).not.toMatch(/full-e2e\.test\.ts|nvapi-test-value/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual([
      "cleanup.json",
      "lane.log",
      "launchable-identity.json",
    ]);

    const evidence = JSON.parse(
      fs.readFileSync(path.join(workDir, "launchable-identity.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: "nemoclaw-staging-launchable-identity-v1",
      candidateSha,
      producer: {
        repository: "brevdev/nemoclaw-image",
        workflow: ".github/workflows/build-launchable-e2e-image.yml",
        runId: "123",
        status: "success",
      },
      image: {
        uri: "projects/brevdevprod/global/images/nemoclaw-test-image",
        imageRepositorySha: "b".repeat(40),
      },
      workspace: { name: "nclaw-e2e-test-1", id: "ws-1" },
      validation: {
        workspaceReadiness: "passed",
        ssh: "passed",
        imageSelection: { status: "passed" },
        runtimeIdentity: { status: "passed" },
        onboarding: "not-run",
        inference: "not-run",
        fullE2E: "not-run",
      },
    });
    expect(evidence.validation.runtimeIdentity.checks).toHaveLength(8);
    expect(
      evidence.validation.runtimeIdentity.checks.every(
        (check: { status: string }) => check.status === "passed",
      ),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      workspaceName: "nclaw-e2e-test-1",
      workspaceId: "ws-1",
      status: "ABSENT",
    });
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Onboarding, inference, and full E2E did not run",
    );
  });

  it("defers identity workspace deletion to the reserved cleanup operation (#9925)", () => {
    const { calls, env, state, workDir } = fixture();
    const result = run({
      ...identitySmokeEnv(env),
      NEMOCLAW_BREV_DEFER_CLEANUP: "1",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(state)).toBe(true);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("brev delete");
    expect(fs.existsSync(`${workDir}.workspace-owner`)).toBe(true);

    const cleanupResult = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "3", POLL_SECONDS: "1" }, [
      "cleanup-owned-workspace",
    ]);
    expect(cleanupResult.status, `${cleanupResult.stdout}\n${cleanupResult.stderr}`).toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.existsSync(`${workDir}.workspace-owner`)).toBe(false);
    expect(
      fs
        .readFileSync(calls, "utf8")
        .split("\n")
        .filter((call) => call === "brev delete nclaw-e2e-test-1"),
    ).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      deleteAttempts: 1,
      status: "ABSENT",
    });
  });

  it.each([
    {
      name: "invalid identity mode",
      overrides: { NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY: "yes" },
      expected: "NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY must be 0 or 1",
    },
    {
      name: "conflicting modes",
      overrides: {
        NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY: "1",
        NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "1",
      },
      expected: "image-only and identity-smoke modes are mutually exclusive",
    },
    {
      name: "invalid deferred cleanup mode",
      overrides: { NEMOCLAW_BREV_DEFER_CLEANUP: "yes" },
      expected: "NEMOCLAW_BREV_DEFER_CLEANUP must be 0 or 1",
    },
    {
      name: "deferred cleanup outside identity mode",
      overrides: { NEMOCLAW_BREV_DEFER_CLEANUP: "1" },
      expected: "deferred cleanup is accepted only in identity-smoke mode",
    },
    {
      name: "inference credential",
      overrides: { NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY: "1" },
      expected: "identity-smoke mode must not receive NVIDIA_INFERENCE_API_KEY",
    },
  ])("rejects $name before dispatch (#9925)", ({ overrides, expected }) => {
    const { calls, env, workDir } = fixture();
    const result = run({ ...env, ...overrides });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(expected);
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("binds the producer run, verifies the clean booted SHA, runs E2E, and deletes (#6943)", () => {
    const { calls, env, sshAttempts, state, workDir } = fixture({
      sshReadyAfter: 6,
    });
    const result = run(env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).toContain("sleep 300");
    expect(commands.indexOf("sleep 300")).toBeLessThan(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
    );
    expect(commands).toContain("create nclaw-e2e-test-1 --launchable env-staging123");
    expect(commands.match(/ssh readiness attempt/gu)).toHaveLength(6);
    const readinessCommands = commands.slice(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
      commands.indexOf("NEMOCLAW_BOOT_IMAGE"),
    );
    expect(readinessCommands.split("\n").filter((line) => line === "brev refresh")).toHaveLength(2);
    expect(readinessCommands.indexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh readiness attempt 1"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeGreaterThan(
      readinessCommands.indexOf("ssh readiness attempt 5"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh readiness attempt 6"),
    );
    expect(readinessCommands).toContain("sleep 5");
    const readinessCall = commands
      .split("\n")
      .find((line) => line.startsWith("ssh readiness attempt 1: "));
    expect(readinessCall).toBeDefined();
    const readinessArgs = readinessCall?.split(": ").at(1)?.split(" ") ?? [];
    expect(readinessArgs).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "RequestTTY=no",
      "-o",
      "LogLevel=ERROR",
      "nclaw-e2e-test-1",
      "true",
    ]);
    expect(fs.readFileSync(sshAttempts, "utf8").trim()).toBe("6");
    expect(commands).toContain("ssh preinstalled full-e2e.test.ts");
    expect(commands).not.toContain("ssh full-e2e diagnostic");
    expect(commands).not.toContain("nvapi-test-value");
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).not.toMatch(
      /last failure|Readiness diagnostics budget|Readiness probe|Readiness SSH alias|Readiness classification/u,
    );
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Waiting up to 900 seconds for workspace SSH access",
    );
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).not.toContain(
      "Full E2E failure diagnostic",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual([
      "cleanup.json",
      "full-e2e.log",
      "lane.log",
      "launchable-e2e.json",
    ]);
    expect(fs.readFileSync(path.join(workDir, "full-e2e.log"), "utf8")).not.toContain(
      "nvapi-test-value",
    );
    const evidence = JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8"));
    expect(evidence).toMatchObject({
      candidateSha,
      fullE2e: "passed",
      producer: { runId: "123", status: "success" },
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "passed" },
        fullE2E: "passed",
      },
      boot: {
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        sourcePath: "/opt/nemoclaw-image/NemoClaw",
        repoSha: candidateSha,
        provisionSha: candidateSha,
        repoClean: true,
        runtimeOverrides: false,
      },
      workspace: { id: "ws-1" },
    });
    expect(evidence.validation.runtimeProvenance.checks).toEqual([
      { field: "schemaVersion", expected: 1, observed: 1, status: "passed" },
      {
        field: "sourceRepository",
        expected: "NVIDIA/NemoClaw",
        observed: "NVIDIA/NemoClaw",
        status: "passed",
      },
      {
        field: "sourcePath",
        expected: "/opt/nemoclaw-image/NemoClaw",
        observed: "/opt/nemoclaw-image/NemoClaw",
        status: "passed",
      },
      { field: "repoSha", expected: candidateSha, observed: candidateSha, status: "passed" },
      {
        field: "provisionSha",
        expected: candidateSha,
        observed: candidateSha,
        status: "passed",
      },
      {
        field: "imageRepositorySha",
        expected: "b".repeat(40),
        observed: "b".repeat(40),
        status: "passed",
      },
      { field: "repoClean", expected: true, observed: true, status: "passed" },
      { field: "runtimeOverrides", expected: false, observed: false, status: "passed" },
    ]);
  });

  it("blocks workspace execution for a wrong receipt, incomplete readiness, or wrong boot image", () => {
    const receipt = fixture({ receiptSha: "b".repeat(40) });
    const receiptResult = run(receipt.env);
    expect(receiptResult.status).not.toBe(0);
    expect(receiptResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(receipt.calls, "utf8")).not.toMatch(/brev create|full-e2e\.test\.ts/u);

    [
      fixture({ omitReceiptField: "project" }),
      fixture({ omitReceiptField: "imageName" }),
      fixture({ imageRepositorySha: "not-a-sha" }),
    ].forEach((malformed) => {
      const malformedResult = run(malformed.env);
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stderr).toContain("producer receipt does not match the candidate");
      expect(fs.readFileSync(malformed.calls, "utf8")).not.toMatch(
        /brev create|full-e2e\.test\.ts/u,
      );
    });

    const unready = fixture({ ready: false });
    const unreadyResult = run({ ...unready.env, BREV_READY_TIMEOUT_SECONDS: "1" });
    expect(unreadyResult.status).not.toBe(0);
    expect(fs.readFileSync(unready.calls, "utf8")).not.toMatch(/brev exec|full-e2e\.test\.ts/u);
    expect(fs.existsSync(unready.state)).toBe(false);

    const wrongImage = fixture({
      bootImage: "projects/brevdevprod/global/images/wrong-image",
    });
    const wrongImageResult = run(identitySmokeEnv(wrongImage.env));
    expect(wrongImageResult.status).not.toBe(0);
    expect(wrongImageResult.stderr).toContain("booted image does not match the producer handoff");
    expect(fs.readFileSync(wrongImage.calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(fs.existsSync(wrongImage.state)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(wrongImage.workDir, "launchable-identity.json"), "utf8"),
      ),
    ).toMatchObject({
      validation: {
        imageSelection: {
          status: "failed",
          expected: "projects/brevdevprod/global/images/nemoclaw-test-image",
          observed: "<redacted>",
        },
        runtimeIdentity: { status: "not-run", checks: [] },
        onboarding: "not-run",
        inference: "not-run",
        fullE2E: "not-run",
      },
    });
  });

  it("records and reports each runtime identity mismatch before onboarding (#9925)", () => {
    const cases = [
      {
        options: { repoSha: "b".repeat(40) },
        field: "repoSha",
        expected: candidateSha,
        observed: "b".repeat(40),
      },
      {
        options: { provisionSha: "b".repeat(40) },
        field: "provisionSha",
        expected: candidateSha,
        observed: "b".repeat(40),
      },
      {
        options: { provisionImageRepositorySha: "c".repeat(40) },
        field: "imageRepositorySha",
        expected: "b".repeat(40),
        observed: "c".repeat(40),
      },
      { options: { repoClean: false }, field: "repoClean", expected: true, observed: false },
      {
        options: { runtimeOverrides: true },
        field: "runtimeOverrides",
        expected: false,
        observed: true,
      },
      { options: { schemaVersion: 2 }, field: "schemaVersion", expected: 1, observed: 2 },
      {
        options: { sourceRepository: "example/NemoClaw" },
        field: "sourceRepository",
        expected: "NVIDIA/NemoClaw",
        observed: "<redacted>",
      },
      {
        options: { sourcePath: "/home/ubuntu/NemoClaw" },
        field: "sourcePath",
        expected: "/opt/nemoclaw-image/NemoClaw",
        observed: "<redacted>",
      },
    ];

    cases.forEach(({ options, field, expected, observed }) => {
      const boot = fixture(options);
      const bootResult = run(identitySmokeEnv(boot.env));
      expect(bootResult.status).not.toBe(0);
      expect(emittedOutput(bootResult, boot.workDir)).toContain(
        `Runtime identity check failed: ${field} expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
      expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
      expect(fs.existsSync(boot.state)).toBe(false);
      const evidence = JSON.parse(
        fs.readFileSync(path.join(boot.workDir, "launchable-identity.json"), "utf8"),
      );
      expect(evidence.validation).toMatchObject({
        imageSelection: { status: "passed" },
        runtimeIdentity: { status: "failed" },
        onboarding: "not-run",
        inference: "not-run",
        fullE2E: "not-run",
      });
      expect(evidence.validation.runtimeIdentity.checks).toHaveLength(8);
      expect(
        evidence.validation.runtimeIdentity.checks.filter(
          (check: { status: string }) => check.status === "failed",
        ),
      ).toEqual([{ field, expected, observed, status: "failed" }]);
    });

    const multiple = fixture({
      repoClean: false,
      repoSha: "b".repeat(40),
      runtimeOverrides: true,
    });
    const multipleResult = run(identitySmokeEnv(multiple.env));
    const multipleOutput = emittedOutput(multipleResult, multiple.workDir);
    expect(multipleResult.status).not.toBe(0);
    expect(multipleOutput).toContain("Runtime identity check failed: repoSha");
    expect(multipleOutput).toContain("Runtime identity check failed: repoClean");
    expect(multipleOutput).toContain("Runtime identity check failed: runtimeOverrides");
    expect(fs.readFileSync(multiple.calls, "utf8")).not.toContain("full-e2e.test.ts");
  }, 90_000);

  it("redacts a mismatched boot-image value before retaining failure evidence", () => {
    const credentialBearingValue =
      "projects/brevdevprod/global/images/guest-controlled-boot-secret";
    const boot = fixture({ bootImage: credentialBearingValue });
    const result = run(boot.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("booted image does not match the producer handoff");
    expect(emittedOutput(result, boot.workDir)).not.toContain(credentialBearingValue);
    expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
    const artifact = fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8");
    expect(artifact).not.toContain(credentialBearingValue);
    expect(JSON.parse(artifact)).toMatchObject({
      boot: { bootImage: "<redacted>" },
      validation: {
        imageSelection: {
          status: "failed",
          expected: "projects/brevdevprod/global/images/nemoclaw-test-image",
          observed: "<redacted>",
        },
        runtimeProvenance: { status: "not-run", checks: [] },
        fullE2E: "not-run",
      },
    });
  });

  it("redacts unconstrained runtime provenance before retaining or logging it", () => {
    const credentialBearingValue = "NVIDIA/guest-controlled-secret";
    const boot = fixture({ sourceRepository: credentialBearingValue });
    const result = run(boot.env);
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, boot.workDir);
    expect(output).not.toContain(credentialBearingValue);
    expect(output).toContain(
      'Runtime provenance check failed: sourceRepository expected "NVIDIA/NemoClaw", observed "<redacted>"',
    );
    expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
    const artifact = fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8");
    expect(artifact).not.toContain(credentialBearingValue);
    const evidence = JSON.parse(artifact);
    expect(evidence.boot.sourceRepository).toBe("<redacted>");
    expect(
      evidence.validation.runtimeProvenance.checks.find(
        (check: { field: string }) => check.field === "sourceRepository",
      ),
    ).toEqual({
      field: "sourceRepository",
      expected: "NVIDIA/NemoClaw",
      observed: "<redacted>",
      status: "failed",
    });
  });

  it("retains bounded redacted host diagnostics before failed-workspace cleanup (#6409)", () => {
    const { calls, env, state, workDir } = fixture({ e2eFails: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh preinstalled full-e2e.test.ts")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway state"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway state")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(commands.match(/ssh full-e2e diagnostic/gu)).toHaveLength(6);

    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("Full E2E failure diagnostics budget: up to 30 seconds");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway state: status 0; output:");
    expect(laneLog).toContain("ActiveState : inactive");
    expect(laneLog).toContain("NRestarts : 0");
    expect(laneLog).toContain("restart-policy is always: true");
    expect(laneLog).toContain("exec-start matches packaged gateway service: true");
    expect(laneLog).toContain("fragment-path is packaged unit path: true");
    expect(laneLog).toContain("drop-ins: absent");
    expect(laneLog).toContain("Full E2E failure diagnostic platform state: status 0; output:");
    expect(laneLog).toContain("gateway service requires Docker service: present");
    expect(laneLog).toContain("gateway service ordered after Docker service: present");
    expect(laneLog).toContain("Docker service wants gateway service: present");
    expect(laneLog).not.toContain("boot-id-prefix");
    expect(laneLog).toContain("boot-uptime-seconds 180");
    expect(laneLog).toContain("gateway-state-dir type=directory uid=1000 gid=1000 mode=750");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("1000 starting");
    expect(laneLog).toContain("1100 started");
    expect(laneLog).toContain("1200 other-systemd-event");
    expect(laneLog).toContain("1300 start-limit-hit");
    expect(laneLog).toContain("1400 restart-scheduled");
    expect(laneLog).toContain("1500 main-exited");
    expect(laneLog).toContain("1600 failed-result");
    expect(laneLog).toContain("1700 dependency-failed");
    expect(laneLog).toContain("2200 stopping");
    expect(laneLog).toContain("2300 deactivated");
    expect(laneLog).toContain("2400 stopped");
    expect(laneLog).toContain("Full E2E failure diagnostic Docker lifecycle: status 0; output:");
    expect(laneLog).toContain("900 docker-service starting");
    expect(laneLog).toContain("950 docker-service started");
    expect(laneLog).toContain("960 docker-socket started");
    expect(laneLog).toContain("970 docker-unit other-systemd-event");
    expect(laneLog).toContain("Full E2E failure diagnostic cloud-final state: status 0; output:");
    expect(laneLog).toContain("SubState : exited");
    expect(laneLog).toContain("active-enter-us: 1200");
    expect(laneLog).toContain("inactive-enter-us: 0");
    expect(laneLog).toContain("listener presence: present");
    expect(laneLog).toContain("listener owner: unexpected");
    expect(laneLog).not.toContain("s3cr3t");
    const diagnosticLines = laneLog
      .split("\n")
      .filter((line) => line.startsWith("Full E2E failure diagnostic "));
    expect(diagnosticLines).toHaveLength(6);
    diagnosticLines
      .filter((line) => line.includes("; output: "))
      .forEach((line) => {
        const payload = line.split("; output: ", 2)[1] ?? "";
        expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(512);
      });
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
        "s3cr3t",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      fullE2e: "failed",
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "passed" },
        fullE2E: "failed",
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("continues bounded diagnostics and cleanup after a probe error (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eFails: true,
      platformDiagnosticFails: true,
    });
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("Full E2E failure diagnostic platform state: status 42; output:");
    expect(laneLog).toContain("platform diagnostic safe detail");
    expect(laneLog).toContain("[REDACTED PRIVATE KEY]");
    expect(laneLog).toContain("[REDACTED LONG LINE]");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("Full E2E failure diagnostic port 8080 listener: status 0; output:");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh full-e2e diagnostic platform state")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway lifecycle"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway lifecycle")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["absent", "", ["listener presence: absent"]],
    [
      "expected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v2 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=97,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in an exact v1 cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=96,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v1 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=95,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "mixed owners",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        'LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=99,fd=4))',
      ].join("\n"),
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "mixed owners in one socket record",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3),("s3cr3t",pid=99,fd=4))',
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "unexpected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gatew",pid=94,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "unrelated cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("other-process",pid=93,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "owner unavailable",
      "LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*",
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "PID-like text inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t,pid=7,fd=8",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "an injected owner tuple inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=98,fd=3",pid=99,fd=4))',
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "one socket record without owner metadata",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        "LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:*",
      ].join("\n"),
      ["listener presence: present", "listener owner: unavailable"],
    ],
  ])(
    "classifies port 8080 listener evidence with %s (#6409)",
    (_name, listenerOutput, expectedEvidence) => {
      const { env, workDir } = fixture({
        e2eFails: true,
        listenerOutput,
      });
      const result = run(env);

      expect(result.status).not.toBe(0);
      const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
      expectedEvidence.forEach((entry) => expect(laneLog).toContain(entry));
      expect(laneLog).not.toContain("s3cr3t");
      expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject(
        { status: "ABSENT" },
      );
    },
  );

  it.each([
    [
      "a similarly prefixed executable",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; ignore_errors=no ; }",
      "nemoclaw-openshell-gateway-service-wrapper",
    ],
    [
      "an extra argument",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service --extra ; ignore_errors=no ; }",
      "--extra",
    ],
    [
      "a second serialized command",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service ; ignore_errors=no ; } { path=/usr/bin/true ; argv[]=/usr/bin/true ; ignore_errors=no ; }",
      "/usr/bin/true",
    ],
  ])("rejects gateway ExecStart with %s (#6409)", (_name, gatewayExecStart, rawValue) => {
    const { env, workDir } = fixture({ e2eFails: true, gatewayExecStart });
    const result = run(env);

    expect(result.status).not.toBe(0);
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("exec-start matches packaged gateway service: false");
    expect(laneLog).not.toContain(rawValue);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("keeps the E2E failure and cleanup when the diagnostic budget expires (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eDiagnosticTimesOut: true,
      e2eFails: true,
    });
    const result = run({
      ...env,
      FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain(
      "Full E2E failure diagnostic gateway state: status 124; output: probe timed out",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic platform state: not run; output: diagnostic budget exhausted",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic port 8080 listener: not run; output: diagnostic budget exhausted",
    );
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).not.toContain("ssh full-e2e diagnostic platform state");
    expect(commands.indexOf("ExecMainCode")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("protects and removes raw inference evidence without passing the credential to redactor arguments", () => {
    const { calls, env, state, workDir } = fixture();
    fs.mkdirSync(path.join(workDir, "full-e2e.log"));
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(calls, "utf8")).toContain(
      "python redactor arg-count 3 with environment secret and modes 600/700",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("nvapi-test-value");
    expect(
      fs
        .readdirSync(String(env.RUNNER_TEMP))
        .filter((entry) => entry.startsWith("brev-launchable-e2e.")),
    ).toEqual([]);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports only the final sanitized refresh and workspace SSH failures", () => {
    const { calls, env, state, workDir } = fixture({
      sshAliasConfigured: false,
      refreshError: `refresh final safe detail\npassword=hunter2\n${"x".repeat(5_000)}`,
      refreshStatus: 35,
      sshError:
        "hidden-user@example.internal: Permission denied (publickey); SSH final safe detail; kex_exchange_identification; password=ssh-secret; identityfile=/hidden/private-key\nAuthorization: Bearer short-token",
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "2" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toMatch(
      /timeout 5s ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR nclaw-e2e-test-1 true/u,
    );
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);

    const output = emittedOutput(result, workDir);
    expect(output).toContain(
      "Readiness Brev refresh last failure: status 35; error: refresh final safe detail",
    );
    expect(output).toContain("Readiness direct SSH last failure: status 34; error:");
    expect(output).toContain("SSH final safe detail");
    expect(output).toContain("kex_exchange_identification");
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: missing");
    expect(output).toContain("Readiness probe brev exec: failure; status 31;");
    expect(output).toContain("Readiness probe direct SSH: failure; status 34;");
    expect(output).toContain("Readiness classification: Brev refresh/configuration failure");
    expect(output).not.toContain("stale refresh detail");
    expect(output).not.toContain("stale SSH detail");
    const diagnosticErrorLines = fs
      .readFileSync(path.join(workDir, "lane.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes("; error:"));
    expect(diagnosticErrorLines).not.toHaveLength(0);
    diagnosticErrorLines.forEach((line) => {
      const error = line.split("; error: ", 2)[1]?.replace(/\)$/u, "") ?? "";
      expect(Buffer.byteLength(error)).toBeLessThanOrEqual(512);
    });
    expect(
      [
        "brev-test-secret",
        "exec-secret",
        "ssh-secret",
        "short-token",
        "hunter2",
        "hidden-user",
        "github-test-token",
        "nvapi-test-value",
        "/hidden/private-key",
        "workspace.hidden.internal",
        "exec.hidden.internal",
        "refresh.hidden.internal",
        "203.0.113.20",
        "identityfile /hidden/private-key",
        "user hidden-user",
      ].filter((secretOrConfiguration) => output.includes(secretOrConfiguration)),
    ).toEqual([]);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["Brev execution works but direct SSH fails", { brevExecStatus: 0 }],
    ["direct SSH recovered during diagnostics", { sshProbeStatus: 0 }],
    ["workspace shell is unreachable", {}],
  ])("classifies %s after the shared readiness deadline", (classification, probeOptions) => {
    const { calls, env, state, workDir } = fixture({
      ...probeOptions,
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(`Readiness classification: ${classification}`);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toMatch(/timeout 5s ssh -T .* nclaw-e2e-test-1 true/u);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports unavailable when SSH alias lookup fails", () => {
    const { env, state, workDir } = fixture({
      sshAliasQueryStatus: 42,
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: unavailable");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports unavailable when the SSH alias diagnostic times out", () => {
    const { env, state, workDir } = fixture({
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
      timeoutBlockDiagnostics: true,
    });
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "1",
      BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "2",
    });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: unavailable");
    expect(output).toContain(
      "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["BREV_SSH_TIMEOUT_SECONDS", "1+1"],
    ["BREV_SSH_TIMEOUT_SECONDS", "0"],
    ["BREV_SSH_TIMEOUT_SECONDS", ""],
    ["BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS", "0"],
    ["BREV_CREATE_RECONCILE_SECONDS", "0"],
    ["FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS", "0"],
    ["POLL_SECONDS", "0"],
    ["POLL_SECONDS", ""],
  ])("rejects invalid %s=%s before dispatch", (name, value) => {
    const { calls, env, workDir } = fixture();
    const result = run({ ...env, [name]: value });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(`${name} must be a positive integer`);
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("rejects arithmetic expansion in the poll interval before dispatch", () => {
    const { calls, env, workDir } = fixture();
    const marker = path.join(workDir, "arithmetic-expansion-ran");
    const result = run({ ...env, POLL_SECONDS: `$(touch ${marker})` });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain("POLL_SECONDS must be a positive integer");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("caps blocking readiness and failure diagnostics by separate deadlines", () => {
    const { calls, env, state, workDir } = fixture({
      timeoutBlockCommand: "brev refresh",
      timeoutBlockDiagnostics: true,
    });
    const startedAt = performance.now();
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "1",
      BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "4",
    });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    expect(elapsedMs).toBeLessThan(10_000);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 1s brev refresh");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
    expect(commands).toMatch(/timeout [12]s brev exec nclaw-e2e-test-1 true/u);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness diagnostics budget: up to 4 seconds");
    expect(output).toContain("Readiness probe brev exec: failure; status 124;");
    expect(output).toContain(
      "Readiness probe direct SSH: not run; status unavailable; error: diagnostic budget exhausted",
    );
    expect(output).toContain("diagnostic budget exhausted");
    expect(output).toContain(
      "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  }, 90_000);

  it("caps a blocking SSH probe by the workspace SSH deadline and deletes the workspace", () => {
    const { calls, env, state, workDir } = fixture({ timeoutBlockCommand: "ssh" });
    const startedAt = performance.now();
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "2" });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    expect(elapsedMs).toBeLessThan(10_000);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toMatch(/timeout [12]s ssh -T .*nclaw-e2e-test-1 true/u);
    expect(commands.match(/timeout [12]s ssh -T .*nclaw-e2e-test-1 true/gu)).toHaveLength(1);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  }, 90_000);

  it("caps the poll sleep by the shared readiness deadline", () => {
    const { calls, env, state, workDir } = fixture({
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "2",
      POLL_SECONDS: "9",
    });
    expect(result.status).not.toBe(0);
    const commands = fs.readFileSync(calls, "utf8");
    const readinessCommands = commands.slice(
      commands.indexOf("timeout 2s brev refresh"),
      commands.indexOf("timeout 60s brev delete"),
    );
    expect(readinessCommands).toMatch(/sleep [12]/u);
    expect(readinessCommands).not.toContain("sleep 9");
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("preserves the booted image when the provision receipt is missing", () => {
    const { calls, env, state, workDir } = fixture({ missingProvisionReceipt: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      candidateSha,
      boot: { bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image" },
      fullE2e: "pending",
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "not-run", checks: [] },
        fullE2E: "not-run",
      },
    });
  });

  it("deletes only the exact identity workspace named by its ownership receipt (#9925)", () => {
    const owned = fixture();
    fs.writeFileSync(
      owned.state,
      JSON.stringify({
        workspaces: [
          {
            id: "ws-1",
            name: owned.env.INSTANCE_NAME,
            status: "RUNNING",
            shell_status: "READY",
            build_status: "COMPLETED",
          },
        ],
      }),
    );
    const ownershipReceipt = `${owned.workDir}.workspace-owner`;
    fs.writeFileSync(
      ownershipReceipt,
      JSON.stringify({
        workspaceName: owned.env.INSTANCE_NAME,
        createState: "accepted",
        deleteAttempts: 0,
      }),
      { mode: 0o600 },
    );
    const ownedResult = run({ ...owned.env, BREV_DELETE_TIMEOUT_SECONDS: "3", POLL_SECONDS: "1" }, [
      "cleanup-owned-workspace",
    ]);
    expect(ownedResult.status, `${ownedResult.stdout}\n${ownedResult.stderr}`).toBe(0);
    expect(fs.existsSync(owned.state)).toBe(false);
    expect(fs.existsSync(ownershipReceipt)).toBe(false);
    expect(fs.readFileSync(owned.calls, "utf8")).toContain("brev delete nclaw-e2e-test-1");
    expect(
      JSON.parse(fs.readFileSync(path.join(owned.workDir, "cleanup.json"), "utf8")),
    ).toMatchObject({ workspaceId: "ws-1", status: "ABSENT" });

    const acceptedDelayed = fixture({ createAppearsAfterRefresh: 3 });
    const acceptedDelayedReceipt = `${acceptedDelayed.workDir}.workspace-owner`;
    fs.writeFileSync(
      acceptedDelayedReceipt,
      JSON.stringify({
        workspaceName: acceptedDelayed.env.INSTANCE_NAME,
        createState: "accepted",
        deleteAttempts: 0,
      }),
      { mode: 0o600 },
    );
    const acceptedDelayedResult = run(
      {
        ...acceptedDelayed.env,
        BREV_CREATE_RECONCILE_SECONDS: "2",
        BREV_DELETE_TIMEOUT_SECONDS: "3",
        POLL_SECONDS: "1",
      },
      ["cleanup-owned-workspace"],
    );
    expect(
      acceptedDelayedResult.status,
      `${acceptedDelayedResult.stdout}\n${acceptedDelayedResult.stderr}`,
    ).toBe(0);
    expect(fs.existsSync(acceptedDelayed.state)).toBe(false);
    expect(fs.readFileSync(acceptedDelayed.calls, "utf8")).toContain(
      "brev delete nclaw-e2e-test-1",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(acceptedDelayed.workDir, "cleanup.json"), "utf8")),
    ).toMatchObject({ workspaceId: "ws-1", status: "ABSENT" });

    const notOwned = fixture();
    fs.writeFileSync(
      notOwned.state,
      JSON.stringify({
        workspaces: [
          {
            id: "foreign-1",
            name: notOwned.env.INSTANCE_NAME,
            status: "RUNNING",
            shell_status: "READY",
            build_status: "COMPLETED",
          },
        ],
      }),
    );
    const notOwnedResult = run(notOwned.env, ["cleanup-owned-workspace"]);
    expect(notOwnedResult.status).toBe(0);
    expect(fs.existsSync(notOwned.state)).toBe(true);
    expect(fs.existsSync(notOwned.calls)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(notOwned.workDir, "cleanup.json"), "utf8")),
    ).toMatchObject({ workspaceId: "", status: "NOT_OWNED" });

    const preexisting = fixture();
    fs.writeFileSync(
      preexisting.state,
      JSON.stringify({
        workspaces: [
          {
            id: "foreign-2",
            name: preexisting.env.INSTANCE_NAME,
            status: "RUNNING",
            shell_status: "READY",
            build_status: "COMPLETED",
          },
        ],
      }),
    );
    const preexistingResult = run(identitySmokeEnv(preexisting.env));
    expect(preexistingResult.status).not.toBe(0);
    expect(preexistingResult.stderr).toContain("workspace name already exists");
    expect(fs.existsSync(preexisting.state)).toBe(true);
    expect(fs.existsSync(`${preexisting.workDir}.workspace-owner`)).toBe(false);
    expect(fs.readFileSync(preexisting.calls, "utf8")).not.toMatch(/brev create|brev delete/u);
    expect(
      JSON.parse(fs.readFileSync(path.join(preexisting.workDir, "cleanup.json"), "utf8")),
    ).toMatchObject({ workspaceId: "foreign-2", status: "NOT_OWNED" });
  });

  it("reconciles and deletes an identity workspace after an ambiguous create failure (#9925)", () => {
    const { calls, env, state, workDir } = fixture({
      createAppearsAfterRefresh: 3,
      createStatus: 17,
    });
    const result = run({
      ...identitySmokeEnv(env),
      BREV_CREATE_RECONCILE_SECONDS: "2",
      BREV_DELETE_TIMEOUT_SECONDS: "3",
      POLL_SECONDS: "1",
    });
    expect(result.status).toBe(17);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).toContain("brev delete nclaw-e2e-test-1");
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      workspaceName: "nclaw-e2e-test-1",
      workspaceId: "ws-1",
      status: "ABSENT",
    });
  });

  it("does not repeat a failed workspace deletion in reserved cleanup (#9925)", () => {
    const { calls, env, state, workDir } = fixture({ deleteFails: true });
    const result = run({
      ...identitySmokeEnv(env),
      BREV_DELETE_TIMEOUT_SECONDS: "1",
      POLL_SECONDS: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cleanup ended with PRESENT");
    expect(fs.existsSync(state)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      workspaceName: "nclaw-e2e-test-1",
      workspaceId: "ws-1",
      status: "PRESENT",
    });

    const reservedCleanup = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "1", POLL_SECONDS: "1" }, [
      "cleanup-owned-workspace",
    ]);
    expect(reservedCleanup.status).not.toBe(0);
    const deleteCalls = () =>
      fs
        .readFileSync(calls, "utf8")
        .split("\n")
        .filter((call) => call === "brev delete nclaw-e2e-test-1");
    expect(deleteCalls()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      deleteAttempts: 1,
      status: "PRESENT",
    });

    const exhaustedCleanup = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "1", POLL_SECONDS: "1" }, [
      "cleanup-owned-workspace",
    ]);
    expect(exhaustedCleanup.status).not.toBe(0);
    expect(deleteCalls()).toHaveLength(1);
  });
});
