// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveNemoclawStateDir } from "../../src/lib/state/paths";
import { describe, expect, test as it } from "../helpers/owned-test-resources";
import { runWithEnvAsync, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("config rotate-token CLI", () => {
  it(
    "stops after a failed OpenShell update without creating a provider or changing host state (#12940)",
    testTimeoutOptions(30_000),
    async ({ testHome }) => {
      const { bin, home } = testHome;
      writeSandboxRegistry(home, "alpha", {
        agent: "openclaw",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        provider: "inference",
      });
      const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
      const registryBefore = fs.readFileSync(registryPath, "utf8");

      const auditPath = path.join(resolveNemoclawStateDir(home), "operational-audit.jsonl");
      const auditBefore =
        '{"action":"config_set","sandbox":"alpha","timestamp":"2026-01-01T00:00:00.000Z"}\n';
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.writeFileSync(auditPath, auditBefore, { mode: 0o600 });

      const commandLog = path.join(home, "openshell-commands.log");
      const tokenStatus = path.join(home, "openshell-token-status");
      const openshell = path.join(bin, "openshell");
      fs.writeFileSync(
        openshell,
        [
          "#!/bin/sh",
          'printf \'%s\\n\' "$*" >> "$OPENSHELL_TEST_COMMAND_LOG"',
          'if [ "$1" = "--version" ]; then',
          "  printf 'openshell 0.1.3\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "provider" ] && [ "$2" = "update" ]; then',
          '  if [ "${NVIDIA_INFERENCE_API_KEY:-}" = "rotation-secret" ]; then',
          "    printf 'forwarded\\n' > \"$OPENSHELL_TEST_TOKEN_STATUS\"",
          "  fi",
          "  exit 7",
          "fi",
          "exit 98",
        ].join("\n"),
        { mode: 0o755 },
      );

      // Observe process-local staging at CLI exit; saveCredential does not write a file.
      const exitProbe = path.join(home, "credential-exit-probe.cjs");
      const stagedStatus = path.join(home, "credential-staged-status");
      fs.writeFileSync(
        exitProbe,
        [
          'const fs = require("node:fs");',
          'process.once("exit", () => {',
          "  fs.writeFileSync(process.env.NEMOCLAW_TEST_STAGED_STATUS,",
          '    process.env.NVIDIA_INFERENCE_API_KEY === undefined ? "unstaged" : "staged");',
          "});",
        ].join("\n"),
        { mode: 0o600 },
      );

      const result = await runWithEnvAsync(
        "sandbox config rotate-token alpha --from-env ROTATION_INPUT",
        testHome.environment({
          NEMOCLAW_OPENSHELL_BIN: openshell,
          OPENSHELL_TEST_COMMAND_LOG: commandLog,
          OPENSHELL_TEST_TOKEN_STATUS: tokenStatus,
          NEMOCLAW_TEST_STAGED_STATUS: stagedStatus,
          NVIDIA_INFERENCE_API_KEY: undefined,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require=" + exitProbe]
            .filter(Boolean)
            .join(" "),
          ROTATION_INPUT: "rotation-secret",
          VITEST: undefined,
          NEMOCLAW_TEST_BASE_HOME: undefined,
          NEMOCLAW_TEST_STATE_DIR: undefined,
        }),
      );

      expect(result.code).toBe(1);
      expect(result.out).toContain("Could not confirm the token update for provider 'inference'");
      expect(result.out).toContain("Inspect the OpenShell provider before retrying");
      expect(result.out).not.toContain("rotation-secret");
      expect(fs.readFileSync(commandLog, "utf8")).toBe(
        "--version\nprovider update inference --credential NVIDIA_INFERENCE_API_KEY\n",
      );
      expect(fs.readFileSync(tokenStatus, "utf8")).toBe("forwarded\n");
      expect(fs.readFileSync(stagedStatus, "utf8")).toBe("unstaged");
      expect(fs.readFileSync(auditPath, "utf8")).toBe(auditBefore);
      expect(fs.readFileSync(registryPath, "utf8")).toBe(registryBefore);
      expect(fs.existsSync(path.join(home, ".nemoclaw", "credentials.json"))).toBe(false);
    },
  );
});
