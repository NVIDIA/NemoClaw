// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";
import JSON5 from "json5";
import { expect, it, vi } from "vitest";
import {
  buildNativeModelRestartCommand,
  NATIVE_RESTART_PROVIDER,
} from "../live/full-e2e-native-model.ts";

const original = "inference/vendor/valid-model";
const primary = `${NATIVE_RESTART_PROVIDER}/vendor/valid-model`;
const credential = "fixture-provider-credential";
const provider = {
  baseUrl: "https://inference.local/v1",
  apiKey: credential,
  api: "openai-completions",
  models: [{ id: "vendor/valid-model", name: "Configured model" }],
};

function fixture() {
  return {
    agents: {
      defaults: { model: { primary: original }, models: { [original]: { alias: "existing" } } },
    },
    models: { providers: { inference: provider } },
  };
}

function run(source: string, execFileSync = vi.fn().mockReturnValue("")) {
  const readFileSync = vi.fn().mockReturnValue(source);
  const stdout = vi.fn();
  const stderr = vi.fn();
  const processState = { stdout: { write: stdout }, stderr: { write: stderr }, exitCode: 0 };
  const modules = {
    "node:fs": { readFileSync },
    "node:child_process": { execFileSync },
    "/usr/local/lib/node_modules/openclaw/node_modules/json5": JSON5,
  };
  const command = buildNativeModelRestartCommand();
  vm.runInNewContext(command[4]!, {
    require: (name: keyof typeof modules) => modules[name],
    process: processState,
  });
  return { command, readFileSync, execFileSync, stdout, stderr, processState };
}

it("uses native config patch with the valid existing model and backend, keeping credentials inside the sandbox", () => {
  const source = `// native JSON5 comment\n${JSON5.stringify(fixture())}`;
  const result = run(source);
  expect(result.command.slice(0, 4)).toEqual([
    "/usr/bin/env",
    "HOME=/sandbox",
    "/usr/local/bin/node",
    "-e",
  ]);
  expect(result.readFileSync).toHaveBeenCalledExactlyOnceWith(
    "/sandbox/.openclaw/openclaw.json",
    "utf8",
  );
  expect(result.execFileSync).toHaveBeenCalledExactlyOnceWith(
    "/usr/local/bin/openclaw",
    ["config", "patch", "--stdin"],
    {
      input: JSON.stringify({
        models: { providers: { [NATIVE_RESTART_PROVIDER]: provider } },
        agents: { defaults: { model: { primary }, models: { [primary]: {} } } },
      }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.stdout).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ original, primary, model: "vendor/valid-model" }),
  );
  expect(JSON.stringify(result.stdout.mock.calls)).not.toContain(credential);
  expect(result.stderr).not.toHaveBeenCalled();
  expect(result.processState.exitCode).toBe(0);
});

it.each([
  { agents: {} },
  { ...fixture(), agents: { defaults: { model: { primary: "not-qualified" } } } },
  { ...fixture(), models: { providers: { inference: { ...provider, models: [] } } } },
  {
    ...fixture(),
    models: { providers: { inference: provider, [NATIVE_RESTART_PROVIDER]: provider } },
  },
  {
    ...fixture(),
    agents: { defaults: { model: { primary: original }, models: { [primary]: {} } } },
  },
])("refuses an unknown model or an existing test entry before changing native config", (config) => {
  const result = run(JSON.stringify(config));
  expect(result.execFileSync).not.toHaveBeenCalled();
  expect(result.stdout).not.toHaveBeenCalled();
  expect(result.processState.exitCode).toBe(1);
});

it("does not expose credential-bearing native command errors", () => {
  const result = run(
    JSON.stringify(fixture()),
    vi.fn().mockImplementation(() => {
      throw new Error(`native command diagnostic: ${credential}`);
    }),
  );
  expect(result.processState.exitCode).toBe(1);
  expect(result.stdout).not.toHaveBeenCalled();
  expect(result.stderr).toHaveBeenCalledExactlyOnceWith(
    "Could not prepare the native restart model.\n",
  );
});
