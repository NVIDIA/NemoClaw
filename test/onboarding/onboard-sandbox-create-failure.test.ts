// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectSandboxCreateFailureDiagnostics,
  printSandboxCreateFailureDiagnostics,
} from "../../src/lib/onboard/sandbox-create-failure.js";

describe("sandbox create failure diagnostics", () => {
  it.each([
    ["default port", 8080, undefined, "openshell-docker-gateway"],
    ["non-default port", 9123, undefined, "openshell-docker-gateway-9123"],
    ["configured state", 9123, "configured-gateway", "configured-gateway"],
  ] as const)(
    "reads the selected %s gateway log before the legacy fallback (#10544)",
    (_scenario, gatewayPort, configuredDirName, expectedDirName) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-selected-log-"));
      const homeDir = path.join(tmp, "home");
      const gatewayStateDir = configuredDirName
        ? path.join(tmp, configuredDirName)
        : path.join(homeDir, ".local", "state", "nemoclaw", expectedDirName);
      const gatewayLogPath = path.join(gatewayStateDir, "openshell-gateway.log");
      fs.mkdirSync(gatewayStateDir, { recursive: true });
      fs.writeFileSync(gatewayLogPath, "selected gateway exited before sandbox creation\n");

      const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
        gatewayPort,
        gatewayStateDir: configuredDirName ? gatewayStateDir : undefined,
        homeDir,
        now: new Date("2026-05-12T20:35:00.000Z"),
      });

      const selectedStateRoot =
        gatewayPort === 8080
          ? path.join(homeDir, ".nemoclaw")
          : path.join(homeDir, ".nemoclaw", "gateways", String(gatewayPort));
      expect({
        bundleUsesSelectedPort: diagnostics?.dir.startsWith(
          path.join(selectedStateRoot, "onboard-failures"),
        ),
        gatewayLogPath: diagnostics?.gatewayLogPath,
        summaryIncludesFailure: diagnostics?.summaryLines.includes(
          "gateway signature=create-stream-exited-before-sandbox",
        ),
      }).toEqual({
        bundleUsesSelectedPort: true,
        gatewayLogPath,
        summaryIncludesFailure: true,
      });
    },
  );

  it("preserves only the verified sandbox evidence before cleanup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const replacementId = "828d0e10-b2dc-4e64-86c6-8a9b1f352f02";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const replacementStateDir = path.join(logDir, "vm-driver", "sandboxes", replacementId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const replacementConsolePath = path.join(replacementStateDir, "rootfs-console.log");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");
    const gatewaySecret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const consoleSecret = "zxqv-console-secret-token";
    const opaqueSecret = "opaque-runtime-canary-7f31";

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(replacementStateDir, { recursive: true });
    fs.writeFileSync(
      consolePath,
      `Exec format error Authorization: Bearer ${consoleSecret} ${opaqueSecret}\n`,
    );
    fs.writeFileSync(replacementConsolePath, "replacement console detail\n");
    fs.writeFileSync(
      gatewayLogPath,
      [
        "old unrelated line",
        `2026-05-12T20:30:56Z INFO vm driver: create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `2026-05-12T20:30:56Z INFO vm driver: resolved image ref, preparing rootfs sandbox_id=${sandboxId} state_dir=${stateDir}`,
        `2026-05-12T20:34:28Z INFO vm driver: spawning VM launcher sandbox_id=${sandboxId} console_output=${consolePath}`,
        `[2026-05-12T20:34:29Z ERROR krun] sandbox_id=${sandboxId} api_key=${gatewaySecret} ${opaqueSecret} Building the microVM failed: Internal(Vm(VmSetup(VmCreate)))`,
        `2026-05-12T20:34:29Z WARN Sandbox failed to become ready sandbox_id=${sandboxId} sandbox_name=my-assistant reason=ProcessExited`,
        `[2026-05-12T20:34:29Z ERROR krun] console_output=${replacementConsolePath} reason=ProcessExited`,
        `2026-05-12T20:34:30Z INFO vm driver: create_sandbox received sandbox_id=${replacementId} sandbox_name=my-assistant`,
        `2026-05-12T20:34:30Z INFO vm driver: spawning VM launcher sandbox_id=${replacementId} console_output=${replacementConsolePath}`,
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      sandboxId,
      backupPath: "/tmp/pre-upgrade-backup",
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.sandboxId).toBe(sandboxId);
    expect(diagnostics?.copiedConsoleOutput).toBe(
      path.join(diagnostics!.dir, "rootfs-console.log"),
    );
    const consoleOutput = fs.readFileSync(
      path.join(diagnostics!.dir, "rootfs-console.log"),
      "utf-8",
    );
    expect(consoleOutput).toContain("rootfs-console signature=exec-format-error");
    const relevant = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
      "utf-8",
    );
    expect(relevant).toContain("gateway signature=vm-create-failed");
    expect(relevant).toContain(`sandbox_id=${sandboxId}`);
    expect(relevant).not.toContain(replacementId);
    expect(relevant).not.toContain(replacementConsolePath);
    const capturedOutput = `${relevant}\n${consoleOutput}\n${diagnostics?.summaryLines.join("\n")}`;
    expect({
      consolePrefixPresent: capturedOutput.includes("zxqv"),
      consoleSecretPresent: capturedOutput.includes(consoleSecret),
      gatewayPrefixPresent: capturedOutput.includes("sk-a"),
      gatewaySecretPresent: capturedOutput.includes(gatewaySecret),
      opaqueSecretPresent: capturedOutput.includes(opaqueSecret),
    }).toEqual({
      consolePrefixPresent: false,
      consoleSecretPresent: false,
      gatewayPrefixPresent: false,
      gatewaySecretPresent: false,
      opaqueSecretPresent: false,
    });
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "backup_path=/tmp/pre-upgrade-backup",
    );
  });

  it("does not fall back to same-name evidence when the verified ID is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-identity-miss-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "openshell-gateway.log"),
      "create_sandbox received sandbox_id=828d0e10-b2dc-4e64-86c6-8a9b1f352f02 sandbox_name=my-assistant\n",
    );

    const result = collectSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir,
        sandboxId: "691344ae-f514-41c1-b29e-db7f2f7ef257",
      });

    expect({
      failureRootExists: fs.existsSync(path.join(homeDir, ".nemoclaw", "onboard-failures")),
      result,
    }).toEqual({ failureRootExists: false, result: null });
  });

  it("rejects an identity-bound console path outside the sandbox state directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-outside-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const outsidePath = path.join(tmp, "outside-secret.txt");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(outsidePath, "outside-secret-value\n");
    fs.writeFileSync(
      path.join(logDir, "openshell-gateway.log"),
      [
        `create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant`,
        `sandbox_id=${sandboxId} state_dir=${stateDir} console_output=${outsidePath}`,
      ].join("\n"),
    );

    const result = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      sandboxId,
    });

    const bundleContents = fs
      .readdirSync(result!.dir)
      .map((name) => fs.readFileSync(path.join(result!.dir, name), "utf8"))
      .join("\n");
    expect({
      copiedConsoleOutput: result?.copiedConsoleOutput,
      gatewayEvidenceRetained: bundleContents.includes(`sandbox_id=${sandboxId}`),
      outsideContentCopied: bundleContents.includes("outside-secret-value"),
    }).toEqual({
      copiedConsoleOutput: null,
      gatewayEvidenceRetained: true,
      outsideContentCopied: false,
    });
  });

  it("retains verified gateway evidence when console metadata is unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-gateway-only-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "openshell-gateway.log"),
      `create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant\nERROR krun sandbox_id=${sandboxId} reason=ProcessExited\n`,
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      sandboxId,
    });

    expect({
      consoleCopy: diagnostics?.copiedConsoleOutput,
      gatewayFailure: fs
        .readFileSync(path.join(diagnostics!.dir, "openshell-gateway-relevant.log"), "utf8")
        .includes("gateway signature=process-exited"),
    }).toEqual({ consoleCopy: null, gatewayFailure: true });
  });

  it("retains only the ten newest failure bundles", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-retention-"));
    const homeDir = path.join(tmp, "home");
    const failureRoot = path.join(homeDir, ".nemoclaw", "onboard-failures");
    fs.mkdirSync(failureRoot, { recursive: true });
    const oldBundles = Array.from(
      { length: 12 },
      (_, index) =>
        `2027-01-01T00-00-${String(index).padStart(2, "0")}-000Z-old-${String(index)}`,
    );
    oldBundles.forEach((name) => fs.mkdirSync(path.join(failureRoot, name)));

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      now: new Date("2026-05-12T20:35:00.000Z"),
    });
    const retained = fs.readdirSync(failureRoot).sort();
    const expectedRetained = [path.basename(diagnostics!.dir), ...oldBundles.slice(-9)].sort();

    expect({
      retained,
      retentionPruned: diagnostics?.retentionPruned,
    }).toEqual({
      retained: expectedRetained,
      retentionPruned: true,
    });
  });

  it("prints saved diagnostics and retained backup details", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-print-"));
    const homeDir = path.join(tmp, "home");
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };

    try {
      const diagnostics = printSandboxCreateFailureDiagnostics("my-assistant", {
        homeDir,
        backupPath: "/tmp/pre-upgrade-backup",
        now: new Date("2026-05-12T20:35:00.000Z"),
      });

      expect(diagnostics?.dir).toContain(path.join(homeDir, ".nemoclaw", "onboard-failures"));
      expect(messages).toContain(`  Diagnostics saved: ${diagnostics!.dir}`);
      expect(messages).toContain("  State backup retained: /tmp/pre-upgrade-backup");
    } finally {
      console.error = originalError;
    }
  });

  it("preserves a bounded gateway tail when sandbox-specific lines are absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-tail-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      gatewayLogPath,
      [
        "2026-05-12T20:30:00Z INFO gateway starting",
        "2026-05-12T20:30:01Z WARN gateway exited before request dispatch",
      ].join("\n"),
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      now: new Date("2026-05-12T20:35:00.000Z"),
    });

    expect(diagnostics?.gatewayTailPath).toBe(
      path.join(diagnostics!.dir, "openshell-gateway-tail.log"),
    );
    expect(fs.readFileSync(diagnostics!.gatewayTailPath!, "utf-8")).toContain(
      "gateway signature=gateway-exited-before-dispatch",
    );
    expect(diagnostics?.summaryLines).toContain(
      "gateway signature=gateway-exited-before-dispatch",
    );
    expect(fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf-8")).toContain(
      "gateway_tail=",
    );
  });

  it("bounds gateway and console evidence captured before rollback (#10412)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-failure-bounded-"));
    const homeDir = path.join(tmp, "home");
    const logDir = path.join(homeDir, ".local", "state", "nemoclaw", "openshell-docker-gateway");
    const sandboxId = "691344ae-f514-41c1-b29e-db7f2f7ef257";
    const stateDir = path.join(logDir, "vm-driver", "sandboxes", sandboxId);
    const consolePath = path.join(stateDir, "rootfs-console.log");
    const gatewayLogPath = path.join(logDir, "openshell-gateway.log");
    fs.mkdirSync(stateDir, { recursive: true });
    Array.from({ length: 201 }, (_, index) =>
      fs.writeFileSync(path.join(stateDir, `entry-${String(index).padStart(3, "0")}`), ""),
    );
    fs.writeFileSync(consolePath, `${"😀".repeat(100_000)}Exec format error\n`);
    fs.writeFileSync(
      gatewayLogPath,
      `create_sandbox received sandbox_id=${sandboxId} sandbox_name=my-assistant\n${"old gateway output\n".repeat(100_000)}${[
        `sandbox_id=${sandboxId} state_dir=${stateDir} console_output=${consolePath}`,
        `ERROR krun sandbox_id=${sandboxId} sandbox_name=my-assistant reason=ProcessExited`,
      ].join("\n")}\n`,
    );

    const diagnostics = collectSandboxCreateFailureDiagnostics("my-assistant", {
      homeDir,
      sandboxId,
    });
    const gatewayEvidence = fs.readFileSync(
      path.join(diagnostics!.dir, "openshell-gateway-relevant.log"),
    );
    const consoleEvidence = fs.readFileSync(diagnostics!.copiedConsoleOutput!);
    const summary = fs.readFileSync(path.join(diagnostics!.dir, "summary.txt"), "utf8");

    expect({
      consoleBounded: consoleEvidence.byteLength <= 256 * 1024,
      consoleEndsWithFailure: consoleEvidence
        .toString("utf8")
        .endsWith(`rootfs-console signature=exec-format-error sandbox_id=${sandboxId}\n`),
      consoleHasInvalidUtf8: consoleEvidence.toString("utf8").includes("�"),
      consoleOutputTruncated: diagnostics?.consoleOutputTruncated,
      gatewayBounded: gatewayEvidence.byteLength <= 1024 * 1024,
      gatewayContainsFailure: gatewayEvidence
        .toString("utf8")
        .includes("gateway signature=process-exited"),
      gatewayLogTruncated: diagnostics?.gatewayLogTruncated,
      printedTruncationNotices: diagnostics?.summaryLines.slice(0, 2),
      stateEntriesOmitted: summary.includes("<additional entries omitted>"),
      listedStateEntries: (summary.match(/^  (?:entry-\d+|rootfs-console\.log)$/gmu) ?? []).length,
      summaryRecordsBounds:
        summary.includes("gateway_log_truncated=true") &&
        summary.includes("console_output_truncated=true"),
    }).toEqual({
      consoleBounded: true,
      consoleEndsWithFailure: true,
      consoleHasInvalidUtf8: false,
      consoleOutputTruncated: true,
      gatewayBounded: true,
      gatewayContainsFailure: true,
      gatewayLogTruncated: true,
      printedTruncationNotices: [
        "gateway log: earlier content omitted",
        "rootfs console: earlier content omitted",
      ],
      stateEntriesOmitted: true,
      listedStateEntries: 200,
      summaryRecordsBounds: true,
    });
  });
});
