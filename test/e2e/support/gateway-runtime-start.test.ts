// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "../../helpers/owned-test-resources";
import {
  buildGatewayRuntimeStartScript,
  initializeGatewayForCleanup,
} from "../fixtures/gateway-runtime-start.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

describe("Gateway restart subprocess", () => {
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
