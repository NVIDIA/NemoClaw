// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  candidateSha,
  cleanupFixtures,
  emittedOutput,
  fixture,
  run,
} from "./helpers/brev-launchable-e2e-fixture";

afterEach(cleanupFixtures);
describe("focused staging Brev Launchable lane", () => {
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
    const wrongImageResult = run(wrongImage.env);
    expect(wrongImageResult.status).not.toBe(0);
    expect(wrongImageResult.stderr).toContain("booted image does not match the producer handoff");
    expect(fs.readFileSync(wrongImage.calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(fs.existsSync(wrongImage.state)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(wrongImage.workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
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

  it("records and reports each runtime provenance mismatch before full E2E", () => {
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
      const bootResult = run(boot.env);
      expect(bootResult.status).not.toBe(0);
      expect(emittedOutput(bootResult, boot.workDir)).toContain(
        `Runtime provenance check failed: ${field} expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
      expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
      expect(fs.existsSync(boot.state)).toBe(false);
      const evidence = JSON.parse(
        fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8"),
      );
      expect(evidence.boot).toMatchObject({
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        [String(field)]: observed,
      });
      expect(evidence.validation).toMatchObject({
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "failed" },
        fullE2E: "not-run",
      });
      expect(evidence.validation.runtimeProvenance.checks).toHaveLength(8);
      expect(
        evidence.validation.runtimeProvenance.checks.filter(
          (check: { status: string }) => check.status === "failed",
        ),
      ).toEqual([{ field, expected, observed, status: "failed" }]);
    });

    const multiple = fixture({
      repoClean: false,
      repoSha: "b".repeat(40),
      runtimeOverrides: true,
    });
    const multipleResult = run(multiple.env);
    const multipleOutput = emittedOutput(multipleResult, multiple.workDir);
    expect(multipleResult.status).not.toBe(0);
    expect(multipleOutput).toContain("Runtime provenance check failed: repoSha");
    expect(multipleOutput).toContain("Runtime provenance check failed: repoClean");
    expect(multipleOutput).toContain("Runtime provenance check failed: runtimeOverrides");
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

  it("fails the lane when workspace deletion cannot be verified", () => {
    const { env, state } = fixture({ deleteFails: true });
    const result = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "1", POLL_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still exists after deletion");
    expect(fs.existsSync(state)).toBe(true);
  });
});
