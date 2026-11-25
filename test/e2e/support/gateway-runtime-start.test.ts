// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "../../helpers/owned-test-resources";
import {
  buildGatewayRuntimeStartScript,
  buildOpenClawGatewayWaitScript,
  initializeGatewayForCleanup,
} from "../fixtures/gateway-runtime-start.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

describe("Gateway restart subprocess", () => {
  test.for(
    ([[true], [false], [null], [null, false, true]] as const).flatMap((values) => [
      { values, failedSink: false },
      { values, failedSink: true },
    ]),
  )(
    "observes selected startup probes $values with a failed diagnostic sink $failedSink",
    ({ values, failedSink }, { resources }) => {
      const ready = values.at(-1) === true;
      const root = resources.home("nemoclaw-native-start-").home;
      const modules = path.join(root, "dist/lib/actions/sandbox");
      fs.mkdirSync(modules, { recursive: true });
      fs.writeFileSync(
        path.join(modules, "process-recovery.js"),
        `const fs = require("node:fs");
        const values = ${JSON.stringify(values)};
        exports.isSandboxGatewayRunningForStatus = async (...args) => {
          fs.appendFileSync("probes.jsonl", JSON.stringify(args) + "\\n");
          return values.shift();
        };
        exports.waitForStartedNativeGatewayProcess = async (...args) => {
          fs.writeFileSync("observed.json", JSON.stringify(args));
          if (${String(failedSink)}) console.log = () => { throw new Error("Diagnostic sink unavailable"); };
          if (typeof args[3].probe !== "function") return ${String(ready)};
          let result;
          for (let i = 0; i < ${values.length}; i++) {
            result = await args[3].probe(args[0], args[2], { startup: { timeoutMs: 15000 } });
          }
          return result;
        };`,
      );
      const result = spawnSync(
        process.execPath,
        ["-e", buildOpenClawGatewayWaitScript(), "alpha", "nemoclaw-18079", "43210"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            OPENSHELL_GATEWAY: "foreign",
            NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "900",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(ready ? 0 : 1);
      expect(JSON.parse(fs.readFileSync(path.join(root, "observed.json"), "utf8"))).toEqual([
        "alpha",
        "openclaw",
        "nemoclaw-18079",
        { environment: {}, defaultTimeoutSeconds: 43.21 },
      ]);
      expect(result.stderr).toMatch(ready ? /^$/ : /remaining dashboard deadline/);
      const probesPath = path.join(root, "probes.jsonl");
      const probes = fs.existsSync(probesPath)
        ? fs
            .readFileSync(probesPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      expect(probes).toEqual(
        values.map(() => ["alpha", "nemoclaw-18079", { startup: { timeoutMs: 15000 } }]),
      );
      const observations = result.stdout.trim()
        ? result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      expect(observations).toEqual(
        failedSink
          ? []
          : values.map((value, index) => ({
              kind: "native-readiness-observation",
              attempt: index + 1,
              elapsedMs: expect.any(Number),
              ready: value,
            })),
      );
      expect(observations.every((observation) => observation.elapsedMs >= 0)).toBe(true);
    },
  );
  test.for(["success", "missing", "failure"] as const)(
    "runs the startup owner with registered gateway identity: %s",
    (outcome, { resources }) => {
      const root = resources.home("nemoclaw-gateway-start-").home;
      const modules = path.join(root, "dist/lib");
      fs.mkdirSync(path.join(modules, "state"), { recursive: true });
      fs.mkdirSync(path.join(modules, "onboard"), { recursive: true });
      fs.writeFileSync(
        path.join(modules, "state/registry.js"),
        `exports.getSandbox = (name) => {
          if (name !== "alpha") throw new Error("Unexpected sandbox argument");
          return ${outcome === "missing" ? "null" : '{ gatewayName: "nemoclaw-8090" }'};
        };`,
      );
      fs.writeFileSync(
        path.join(modules, "onboard/gateway-binding.js"),
        "exports.resolveSandboxGatewayName = (sandbox) => sandbox.gatewayName;",
      );
      fs.writeFileSync(
        path.join(modules, "onboard.js"),
        `exports.startGatewayForRecovery = async (options) => {
          require("node:fs").writeFileSync("started.json", JSON.stringify(options));
          ${outcome === "failure" ? 'throw new Error("Gateway startup refused");' : ""}
        };`,
      );

      const result = spawnSync(
        process.execPath,
        ["-e", buildGatewayRuntimeStartScript(), "alpha"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: root, OPENSHELL_GATEWAY: "other" },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(outcome === "success" ? 0 : 1);
      const started = path.join(root, "started.json");
      const startRecord = fs.existsSync(started)
        ? JSON.parse(fs.readFileSync(started, "utf8"))
        : null;
      expect(startRecord).toEqual(outcome === "missing" ? null : { gatewayName: "nemoclaw-8090" });
      expect(result.stderr).toMatch(
        {
          success: /^$/,
          missing: /requires a registered sandbox/,
          failure: /Gateway startup refused/,
        }[outcome],
      );
    },
  );
  test.for(["success", "failure"] as const)(
    "initializes explicit cleanup gateway without sandbox metadata: %s",
    async (outcome, { resources }) => {
      const root = resources.home("nemoclaw-gateway-setup-").home;
      fs.mkdirSync(path.join(root, "dist/lib"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "dist/lib/onboard.js"),
        `exports.startGatewayForRecovery = async (options) => {
      require("node:fs").writeFileSync("started.json", JSON.stringify({ ...options, home: process.env.HOME, gateway: process.env.OPENSHELL_GATEWAY }));
      ${outcome === "failure" ? 'throw new Error("Startup refused");' : ""}
    };`,
      );
      const env = { HOME: root, OPENSHELL_GATEWAY: "nemoclaw-8090" };
      const host = {
        command: async (
          command: string,
          args: string[],
          options: { env?: NodeJS.ProcessEnv; cwd?: string },
        ) => {
          expect(options.env).toEqual(env);
          expect(options.cwd).toBe(REPO_ROOT);
          const result = spawnSync(command, args, {
            cwd: root,
            env: options.env,
            encoding: "utf8",
            timeout: 10_000,
          });
          expect(result.error).toBeUndefined();
          return {
            command: [command, ...args],
            exitCode: result.status,
            signal: result.signal,
            timedOut: false,
            stdout: result.stdout,
            stderr: result.stderr,
            artifacts: { stdout: "", stderr: "", result: "" },
          };
        },
      };
      const setup = initializeGatewayForCleanup(host, "nemoclaw-8090", { env, cwd: root });
      await expect(
        setup.then(
          () => null,
          (error: Error) => error.message,
        ),
      ).resolves.toEqual(outcome === "success" ? null : expect.stringContaining("Startup refused"));
      expect(JSON.parse(fs.readFileSync(path.join(root, "started.json"), "utf8"))).toEqual({
        gatewayName: "nemoclaw-8090",
        gateway: "nemoclaw-8090",
        home: root,
      });
    },
  );

  test("refuses a conflicting cleanup gateway environment before spawning", async () => {
    let calls = 0;
    const host = {
      command: async (): Promise<never> => {
        calls++;
        throw new Error("unexpected startup");
      },
    };
    await expect(
      initializeGatewayForCleanup(host, "nemoclaw", { env: { OPENSHELL_GATEWAY: "foreign" } }),
    ).rejects.toThrow("same explicit gateway");
    expect(calls).toBe(0);
  });
});
