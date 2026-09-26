// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions } from "./helpers";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-09-10T00-00-00-000Z";

function writeOpenShellStub(home: string, sandboxPresent: boolean): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  const openshellLog = path.join(home, "openshell-calls.log");
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `printf "%s\\n" "$*" >> ${JSON.stringify(openshellLog)}`,
      sandboxPresent
        ? 'case "$1 $2" in "sandbox get") echo "Name: gw1-sb"; exit 0 ;; esac'
        : 'case "$1 $2" in "sandbox get") echo "no such sandbox gw1-sb" >&2 ;; esac',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return openshellLog;
}

function writeRecoveryFixture(home: string) {
  const backupPath = path.join(
    home,
    ".nemoclaw",
    "gateways",
    "9000",
    "rebuild-backups",
    "gw1-sb",
    TIMESTAMP,
  );
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  const policy = "version: 1\nprocess:\n  environment:\n    SERVICE_API_KEY: retained\n";
  const sha256 = createHash("sha256").update(policy).digest("hex");
  const handoffPath = path.join(backupPath, `rebuild-policy-handoff.${sha256}.yaml`);
  const recordPath = path.join(backupPath, ".nemoclaw-rebuild-recovery.json");
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  const retainedPath = path.join(backupPath, "workspace-notes.txt");
  fs.writeFileSync(handoffPath, policy, { mode: 0o600 });
  fs.writeFileSync(retainedPath, "recovered later\n");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      sandboxName: "gw1-sb",
      timestamp: TIMESTAMP,
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      backupComplete: true,
      dir: "/sandbox/.openclaw",
      backupPath,
      blueprintDigest: null,
      rebuildPolicyHandoff: { file: path.basename(handoffPath), sha256 },
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    recordPath,
    `${JSON.stringify({
      schemaVersion: 3,
      transactionId: TRANSACTION_ID,
      sandboxName: "gw1-sb",
      backupTimestamp: TIMESTAMP,
      gatewayName: "nemoclaw-9000",
      gatewayPort: 9000,
      phase: "restore",
    })}\n`,
    { mode: 0o600 },
  );
  return { backupPath, handoffPath, manifestPath, recordPath, retainedPath };
}

function writeSiblingRegistry(home: string): string {
  const stateRoot = path.join(home, ".nemoclaw", "gateways", "9000");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const registryPath = path.join(stateRoot, "sandboxes.json");
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({
      defaultSandbox: "gw1-sb",
      sandboxes: {
        "gw1-sb": {
          name: "gw1-sb",
          provider: "ollama-local",
          model: "nvidia/nemotron",
          agent: "openclaw",
          nemoclawVersion: "0.1.0",
          dashboardPort: 18_789,
          gatewayName: "nemoclaw-9000",
          gatewayPort: 9000,
          stopped: true,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return registryPath;
}

function writeSuccessfulRebuildWorkerPreload(home: string): {
  markerPath: string;
  preloadPath: string;
} {
  const siblingStateRoot = path.join(home, ".nemoclaw", "gateways", "9000");
  const markerPath = path.join(siblingStateRoot, "rebuild-worker-success.json");
  const preloadPath = path.join(home, "successful-rebuild-worker.cjs");
  fs.writeFileSync(
    preloadPath,
    [
      'const childProcess = require("node:child_process");',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const Module = require("node:module");',
      "const originalSpawn = childProcess.spawn;",
      "childProcess.spawn = function spawnWithWorkerPreload(command, args, options) {",
      '  const isOwningRegistryWorker = Array.isArray(args) && args.some((arg) => String(arg).endsWith("owning-registry-worker.js"));',
      "  if (isOwningRegistryWorker) {",
      "    options = {",
      "      ...options,",
      `      env: { ...options.env, NODE_OPTIONS: ${JSON.stringify(`--require=${preloadPath}`)} },`,
      "    };",
      "  }",
      "  return originalSpawn.call(this, command, args, options);",
      "};",
      "const originalLoad = Module._load;",
      "Module._load = function loadSuccessfulRebuildFixture(request, parent, isMain) {",
      '  if (process.env.NEMOCLAW_GATEWAY_PORT === "9000" && request === "../rebuild-pipeline") {',
      "    return {",
      "      rebuildSandbox: async (sandboxName, options, executionOptions) => {",
      '        if (sandboxName !== "gw1-sb" || options?.yes !== true || executionOptions?.throwOnError !== true) {',
      '          throw new Error("compiled worker received an invalid rebuild descriptor");',
      "        }",
      '        const stateRoot = path.join(process.env.HOME, ".nemoclaw", "gateways", process.env.NEMOCLAW_GATEWAY_PORT);',
      '        const registryPath = path.join(stateRoot, "sandboxes.json");',
      '        const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));',
      "        registry.sandboxes[sandboxName].stopped = false;",
      "        fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\\n`, { mode: 0o600 });",
      `        fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
      "          sandboxName,",
      "          gatewayPort: Number(process.env.NEMOCLAW_GATEWAY_PORT),",
      "          yes: options.yes,",
      "          throwOnError: executionOptions.throwOnError,",
      "        }), { mode: 0o600 });",
      "      },",
      "    };",
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { markerPath, preloadPath };
}

describe("CLI rebuild recovery routing", () => {
  it(
    "completes a sibling-root rebuild through the compiled worker",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-rebuild-sibling-"));
      try {
        const registryPath = writeSiblingRegistry(home);
        const { markerPath, preloadPath } = writeSuccessfulRebuildWorkerPreload(home);

        const result = runWithEnv(
          "gw1-sb rebuild --yes",
          {
            HOME: home,
            NODE_OPTIONS: `--require=${preloadPath}`,
          },
          30_000,
        );

        expect(result.code, result.out).toBe(0);
        expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual({
          sandboxName: "gw1-sb",
          gatewayPort: 9000,
          yes: true,
          throwOnError: true,
        });
        expect(JSON.parse(fs.readFileSync(registryPath, "utf8")).sandboxes["gw1-sb"].stopped).toBe(
          false,
        );
        expect(fs.existsSync(path.join(home, ".nemoclaw", "sandboxes.json"))).toBe(false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "retires a retained recovery record for an unregistered sandbox through the real CLI (#11394)",
    testTimeoutOptions(35_000),
    () => {
      // Success path with a retained backup and no registry row: the record
      // names its gateway, the fake gateway reports the sandbox absent, and
      // retirement removes only the credential-bearing handoff and marker.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-retire-recovery-ok-"));
      try {
        const localBin = path.join(home, "bin");
        fs.mkdirSync(localBin, { recursive: true });
        const openshellLog = path.join(home, "openshell-calls.log");
        fs.writeFileSync(
          path.join(localBin, "openshell"),
          [
            "#!/usr/bin/env bash",
            `printf "%s\\n" "$*" >> ${JSON.stringify(openshellLog)}`,
            'case "$1 $2" in "sandbox get") echo "no such sandbox gw1-sb" >&2 ;; esac',
            "exit 1",
          ].join("\n"),
          { mode: 0o755 },
        );

        const transactionId = "11111111-1111-4111-8111-111111111111";
        const timestamp = "2026-09-10T00-00-00-000Z";
        const backupPath = path.join(home, ".nemoclaw", "rebuild-backups", "gw1-sb", timestamp);
        fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
        const policy = "version: 1\nprocess:\n  environment:\n    SERVICE_API_KEY: retained\n";
        const sha256 = createHash("sha256").update(policy).digest("hex");
        const handoffPath = path.join(backupPath, `rebuild-policy-handoff.${sha256}.yaml`);
        const recordPath = path.join(backupPath, ".nemoclaw-rebuild-recovery.json");
        const manifestPath = path.join(backupPath, "rebuild-manifest.json");
        const retainedPath = path.join(backupPath, "workspace-notes.txt");
        fs.writeFileSync(handoffPath, policy, { mode: 0o600 });
        fs.writeFileSync(retainedPath, "recovered later\n");
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({
            version: 1,
            sandboxName: "gw1-sb",
            timestamp,
            agentType: "openclaw",
            agentVersion: null,
            expectedVersion: null,
            stateDirs: [],
            backupComplete: true,
            dir: "/sandbox/.openclaw",
            backupPath,
            blueprintDigest: null,
            rebuildPolicyHandoff: { file: path.basename(handoffPath), sha256 },
          }),
          { mode: 0o600 },
        );
        fs.writeFileSync(
          recordPath,
          `${JSON.stringify({
            schemaVersion: 3,
            transactionId,
            sandboxName: "gw1-sb",
            backupTimestamp: timestamp,
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
            phase: "restore",
          })}\n`,
          { mode: 0o600 },
        );

        const r = runWithEnv(`gw1-sb rebuild --retire-recovery ${transactionId} --yes`, {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        expect(r.out).toContain(
          `Retired rebuild recovery '${transactionId}' for sandbox 'gw1-sb' from ${backupPath}.`,
        );
        expect(r.code).toBe(0);
        expect(fs.readFileSync(openshellLog, "utf8").trim().split("\n")).toEqual([
          "sandbox get -g nemoclaw gw1-sb",
        ]);
        expect(fs.existsSync(handoffPath)).toBe(false);
        expect(fs.existsSync(recordPath)).toBe(false);
        expect(fs.readFileSync(retainedPath, "utf8")).toBe("recovered later\n");
        expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).not.toHaveProperty(
          "rebuildPolicyHandoff",
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "retires a retained recovery record from a sibling gateway root after its registry row is removed (#11394)",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-retire-recovery-ok-"));
      try {
        const openshellLog = writeOpenShellStub(home, false);
        const { backupPath, handoffPath, manifestPath, recordPath, retainedPath } =
          writeRecoveryFixture(home);

        const result = runWithEnv(`gw1-sb rebuild --retire-recovery ${TRANSACTION_ID} --yes`, {
          HOME: home,
          PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
        });

        expect(result.out).toContain(
          `Retired rebuild recovery '${TRANSACTION_ID}' for sandbox 'gw1-sb' from ${backupPath}.`,
        );
        expect(result.code).toBe(0);
        expect(fs.readFileSync(openshellLog, "utf8").trim().split("\n")).toEqual([
          "sandbox get -g nemoclaw-9000 gw1-sb",
        ]);
        expect(fs.existsSync(handoffPath)).toBe(false);
        expect(fs.existsSync(recordPath)).toBe(false);
        expect(fs.readFileSync(retainedPath, "utf8")).toBe("recovered later\n");
        expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).not.toHaveProperty(
          "rebuildPolicyHandoff",
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "preserves a sibling-root retirement failure and retained recovery path",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-retire-recovery-fail-"));
      try {
        writeOpenShellStub(home, true);
        const { backupPath, handoffPath, recordPath } = writeRecoveryFixture(home);

        const result = runWithEnv(`gw1-sb rebuild --retire-recovery ${TRANSACTION_ID} --yes`, {
          HOME: home,
          PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain(
          "Cannot retire rebuild recovery before confirmed sandbox deletion: OpenShell still reports sandbox 'gw1-sb' on recorded gateway 'nemoclaw-9000'",
        );
        expect(result.out).toContain(`Recovery remains at '${backupPath}'.`);
        expect(fs.existsSync(handoffPath)).toBe(true);
        expect(fs.existsSync(recordPath)).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects sibling-root retirement while owning-root legacy authority remains",
    testTimeoutOptions(35_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-retire-recovery-legacy-"));
      try {
        writeOpenShellStub(home, false);
        const { handoffPath, recordPath } = writeRecoveryFixture(home);
        const owningStateDir = path.join(home, ".nemoclaw", "gateways", "9000", "state");
        fs.mkdirSync(owningStateDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(owningStateDir, "shields-timer-gw1-sb.json"),
          "legacy authority\n",
          { mode: 0o600 },
        );

        const result = runWithEnv(`gw1-sb rebuild --retire-recovery ${TRANSACTION_ID} --yes`, {
          HOME: home,
          PATH: `${path.join(home, "bin")}:${process.env.PATH || ""}`,
        });

        expect(result.code).toBe(1);
        expect(result.out).toContain(
          "still has recovery artifacts from the removed Shields feature",
        );
        expect(fs.existsSync(handoffPath)).toBe(true);
        expect(fs.existsSync(recordPath)).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
