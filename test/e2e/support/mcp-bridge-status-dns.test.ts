// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { SOURCE_REQUIRE_HOOK } from "../../helpers/source-loader-options";
import { withMcpDnsAnswers } from "../live/mcp-bridge-shared-host";

it("controls public-pin status through the isolated bounded DNS resolver", async () => {
  const answers = [
    { address: "104.16.230.132", family: 4 },
    { address: "104.16.231.132", family: 4 },
  ];
  let observation: unknown;
  await withMcpDnsAnswers("shared.example.test", answers, async (nodeOptions) => {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        SOURCE_REQUIRE_HOOK,
        "-e",
        `
const childProcess = require("node:child_process");
const execFile = childProcess.execFile;
const launches = [];
childProcess.execFile = function(file, args, options, callback) {
  const child = execFile.call(this, file, args, options, callback);
  launches.push({
    hostname: args.at(-1),
    fixtureLoaded: child.spawnargs[1] === "--require",
    loaderEnvironmentCleared: options.env.NODE_OPTIONS === "" && options.env.NODE_PATH === "",
    timeout: options.timeout,
    killSignal: options.killSignal,
  });
  return child;
};
const { resolveHostAddressesBounded } = require("./src/lib/adapters/dns/resolve.js");
const { inspectMcpRecordedPublicTargetPins } = require("./src/lib/actions/sandbox/mcp-bridge-url-validation.js");
(async () => {
  const status = await inspectMcpRecordedPublicTargetPins(
    new URL("https://shared.example.test/mcp"),
    ["104.16.230.132", "104.16.231.132"],
    hostname => resolveHostAddressesBounded(hostname, 2_000),
  );
  const unrelated = await resolveHostAddressesBounded("127.0.0.1", 2_000);
  process.stdout.write(JSON.stringify({ status, unrelated, launches }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
      ],
      {
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    observation = JSON.parse(result.stdout);
  });
  expect(observation).toEqual({
    status: { state: "match", currentAddresses: answers.map(({ address }) => address) },
    unrelated: [{ address: "127.0.0.1", family: 4 }],
    launches: [
      {
        hostname: "shared.example.test",
        fixtureLoaded: true,
        loaderEnvironmentCleared: true,
        timeout: 2_000,
        killSignal: "SIGKILL",
      },
      {
        hostname: "127.0.0.1",
        fixtureLoaded: false,
        loaderEnvironmentCleared: true,
        timeout: 2_000,
        killSignal: "SIGKILL",
      },
    ],
  });
}, 30_000);
