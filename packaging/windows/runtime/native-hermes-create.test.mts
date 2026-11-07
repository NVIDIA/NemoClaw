// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { installedMxcWorkloadArguments } from "./mxc-installed-session.mts";

const workerCommand = ["C:\\Program Files\\NemoClaw\\worker.exe", "--hermes", "saved & state"];
const environment = { FIXTURE: "value with spaces", OPTION: "--tty" };
const cases = [
  ["./run-installed-native-hermes-turn.mts", "workloadRequest", "    console.log("],
  ["./run-installed-native-console-agent.mts", "workloadRequest", "      console.log("],
  ["../hermes/probe-official-components.mts", "args", "    const createFailure:"],
  ["../performance/probe-installed-readonly.mts", "args", "    const createFailure:"],
] as const;

for (const [file, variable, endMarker] of cases) {
  for (const variant of [false, true]) {
    test(`${file} submits its exact worker as the detached main process: ${variant}`, () => {
      const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
      const arrayStart = source.indexOf(
        `const ${variable} = ${variable === "workloadRequest" ? "{" : "["}`,
        source.indexOf("sandboxEnvironment"),
      );
      const commandStart = source.lastIndexOf("const workloadCommand =", arrayStart);
      const start = commandStart >= 0 ? commandStart : arrayStart;
      const end = source.indexOf(endMarker, arrayStart);
      assert(start >= 0 && end > start);
      let leaseChecks = 0;
      const lease = {};
      const context = {
        sandboxName: "owned-hermes",
        policyPath: "owned-policy.yaml",
        runtimeLease: lease,
        workload: "owned-workload",
        shareRoot: "owned-share",
        agentRuntimeRoot: "owned-home",
        environment,
        sandboxEnvironment: environment,
        dashboard: variant,
        modelPort: 21000,
        inferencePipePort: 21000,
        browserPipePort: 21001,
        dashboardPipePort: 21002,
        node: "owned-node.exe",
        worker: "owned-worker.mts",
        runtimeRoot: "owned-runtime",
        resultPath: "owned-result.json",
        nonce: "owned-nonce",
        tempControl: variant ? "temp-control" : null,
        adapterSha256: "owned-adapter-sha",
        installRoot: "owned-install",
        cacheExperiment: variant,
        cacheManifest: "owned-cache.json",
        nativeRuntimeWorkerCommand(observedLease: unknown, entry: unknown) {
          assert.equal(observedLease, lease);
          assert.equal(entry, "owned-workload");
          leaseChecks++;
          return workerCommand;
        },
      };
      const code = stripTypeScriptTypes(
        `(() => { const {${Object.keys(context).join(",")}} = context;\n${source.slice(start, end)}\nreturn ${variable}; })()`,
        { mode: "strip" },
      );
      const request = new Function("context", `return ${code}`)(context);
      const args: string[] =
        variable === "workloadRequest" ? installedMxcWorkloadArguments(request) : request;
      const boundary = args.indexOf("--");
      assert(boundary > 0, "The driver command is not the main-process command.");
      assert.equal(args.indexOf("--", boundary + 1), -1);
      const options = args.slice(0, boundary);
      assert.equal(options.filter((arg) => arg === "--detach").length, 1);
      const configured = JSON.parse(options[options.indexOf("--driver-config-json") + 1]).mxc;
      const expected =
        variable === "workloadRequest"
          ? workerCommand
          : [
              "owned-node.exe",
              "--experimental-strip-types",
              "--no-warnings",
              "owned-worker.mts",
              ...(file.includes("probe-official")
                ? [
                    "owned-runtime",
                    "owned-result.json",
                    "owned-nonce",
                    ...(variant ? ["temp-control", "owned-adapter-sha"] : []),
                  ]
                : [
                    "owned-install",
                    "owned-share",
                    "owned-nonce",
                    ...(variant ? ["owned-cache.json"] : []),
                  ]),
            ];
      assert.deepEqual(configured.command, expected);
      if (file.includes("console-agent"))
        assert.deepEqual(
          configured.loopback_pipe_ports,
          variant ? [21000, 21001, 21002] : [21000, 21001],
        );
      else if (file.includes("hermes-turn"))
        assert.deepEqual(configured.loopback_pipe_ports, [21000]);
      assert.deepEqual(args.slice(boundary + 1), expected);
      assert.equal(configured.cwd, file.includes("console-agent") ? "owned-home" : "owned-share");
      assert(options.includes(file.includes("console-agent") && !variant ? "--tty" : "--no-tty"));
      for (const [name, value] of Object.entries(environment))
        assert(
          options.some(
            (arg, index) => arg === "--env" && options[index + 1] === `${name}=${value}`,
          ),
        );
      if (variable === "workloadRequest") assert.equal(leaseChecks, 1);
    });
  }
}
