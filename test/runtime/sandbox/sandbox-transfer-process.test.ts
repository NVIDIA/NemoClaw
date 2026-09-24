// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SOURCE_REQUIRE_HOOK } from "../../helpers/source-loader-options";

const adapterPath = path.resolve("src/lib/adapters/openshell/sandbox-transfer-cli.ts");
const request = {
  direction: "upload",
  sandboxName: "alpha",
  target: { kind: "selected" },
  source: "/host/file",
  destination: "/sandbox/",
};

function runAdapter(script: string, input?: string) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--require", SOURCE_REQUIRE_HOOK, "-e", script],
    {
      encoding: "utf8",
      input,
      timeout: 15_000,
    },
  );
}

describe("transfer process boundary", () => {
  it("preserves stdin and raw stdout/stderr across an asynchronous transfer", () => {
    const child = `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        process.stdout.write('\\x1b[32mupstream progress\\x1b[0m\\n' + input);
        process.stderr.write('upstream diagnostic /path/with spaces\\n');
      });
    `;
    const result = runAdapter(
      `
      const { spawn } = require('node:child_process');
      const { createCliOpenShellSandboxTransferExecutor } = require(${JSON.stringify(adapterPath)});
      const executor = createCliOpenShellSandboxTransferExecutor({
        resolveBinary: () => process.execPath,
        spawnChild: (_binary, _args, options) => spawn(process.execPath, ['-e', ${JSON.stringify(child)}], options),
      });
      executor.run(${JSON.stringify(request)}).then(result => {
        result.release();
        process.exitCode = result.outcome.kind === 'completed' ? result.outcome.exitCode : 1;
      });
    `,
      "caller input\n",
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\x1b[32mupstream progress\x1b[0m\ncaller input\n");
    expect(result.stderr).toBe("upstream diagnostic /path/with spaces\n");
  });

  it.runIf(process.platform !== "win32")(
    "waits for the interrupted child to close even when it exits zero",
    () => {
      const child = `
      process.on('SIGTERM', () => {
        setTimeout(() => { process.stdout.write('child cleanup finished\\n'); process.exit(0); }, 20);
      });
      process.send('ready');
      setInterval(() => {}, 1000);
    `;
      const result = runAdapter(`
      const { spawn } = require('node:child_process');
      const { EventEmitter } = require('node:events');
      const { createCliOpenShellSandboxTransferExecutor } = require(${JSON.stringify(adapterPath)});
      const signals = new EventEmitter();
      const executor = createCliOpenShellSandboxTransferExecutor({
        resolveBinary: () => process.execPath,
        signalSource: { add: (signal, fn) => signals.on(signal, fn), remove: (signal, fn) => signals.off(signal, fn) },
        spawnChild: (_binary, _args, options) => {
          const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { ...options, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
          child.once('message', () => signals.emit('SIGTERM'));
          return child;
        },
      });
      executor.run(${JSON.stringify(request)}).then(result => {
        process.stdout.write(JSON.stringify(result.outcome) + '\\n');
        process.stdout.write('held=' + signals.listenerCount('SIGTERM') + '\\n');
        result.release();
        process.stdout.write('released=' + signals.listenerCount('SIGTERM') + '\\n');
      });
    `);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        'child cleanup finished\n{"kind":"failed","reason":"interrupted"}\nheld=1\nreleased=0\n',
      );
    },
  );
});
