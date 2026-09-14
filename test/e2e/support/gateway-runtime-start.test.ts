// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "../../helpers/owned-test-resources";
import { buildGatewayRuntimeStartScript } from "../fixtures/gateway-runtime-start.ts";

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
});
