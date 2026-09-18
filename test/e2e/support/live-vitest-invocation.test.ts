// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLiveVitestArgs,
  DGX_EXPRESS_TEST_PATH,
  INFERENCE_ROUTING_TEST_PATH,
  LIVE_VITEST_PROJECT,
  MCP_BRIDGE_TEST_PATH,
  type LiveVitestSpawner,
  RISK_SIGNAL_REPORTER,
  resolveLiveSelector,
  runLiveVitestCommand,
  validateLiveProject,
  validateLiveSelector,
  validateLiveTestPath,
} from "../../../tools/e2e/live-vitest-invocation.mts";

const LIVE_VITEST_TOOL = path.resolve("tools/e2e/live-vitest-invocation.mts");
const TSX = path.resolve("node_modules", ".bin", "tsx");
const FULL_E2E_TEST_PATH = "test/e2e/live/full-e2e.test.ts";

describe("validateLiveProject (#6961)", () => {
  it("accepts the live project and defaults to it", () => {
    expect(validateLiveProject("e2e-live")).toBe(LIVE_VITEST_PROJECT);
    expect(validateLiveProject(undefined)).toBe(LIVE_VITEST_PROJECT);
  });

  it.each(["cli", "e2e-support", "e2e-live-extra", "integration"])(
    "rejects any other project [case %#]",
    (project) => {
      expect(() => validateLiveProject(project)).toThrow(/unsupported vitest project/);
    },
  );
});

describe("validateLiveTestPath (#6961)", () => {
  it("accepts a real live test path", () => {
    expect(validateLiveTestPath("test/e2e/live/registry-targets.test.ts")).toBe(
      "test/e2e/live/registry-targets.test.ts",
    );
  });

  it("rejects paths outside the live test root", () => {
    expect(() => validateLiveTestPath("test/e2e/support/thing.test.ts")).toThrow(
      /must be under test\/e2e\/live/,
    );
    expect(() => validateLiveTestPath("src/lib/onboard.ts")).toThrow(/must be under/);
  });

  it("rejects '..' traversal", () => {
    expect(() => validateLiveTestPath("test/e2e/live/../support/x.test.ts")).toThrow(/traverse/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateLiveTestPath("/etc/passwd")).toThrow(/unsupported character|absolute/);
  });

  it.each([
    "test/e2e/live/x.test.ts; rm -rf /",
    "test/e2e/live/$(whoami).test.ts",
    "test/e2e/live/x.test.ts && curl evil",
    "test/e2e/live/`id`.test.ts",
    "test/e2e/live/x.test.ts|cat",
  ])("rejects shell metacharacters [case %#]", (bad) => {
    expect(() => validateLiveTestPath(bad)).toThrow(/unsupported character/);
  });

  it("requires a .test.ts file", () => {
    expect(() => validateLiveTestPath("test/e2e/live/fixtures")).toThrow(/\.test\.ts/);
  });

  it("requires a non-empty path", () => {
    expect(() => validateLiveTestPath("")).toThrow(/required/);
    expect(() => validateLiveTestPath(undefined)).toThrow(/required/);
  });
});

describe("validateLiveSelector (#6961)", () => {
  it("accepts anchored title patterns", () => {
    expect(validateLiveSelector("^ubuntu-repo-cloud-openclaw$")).toBe(
      "^ubuntu-repo-cloud-openclaw$",
    );
    expect(validateLiveSelector("^skill-agent$")).toBe("^skill-agent$");
  });

  it("treats an absent or empty selector as no selector", () => {
    expect(validateLiveSelector(undefined)).toBeUndefined();
    expect(validateLiveSelector("")).toBeUndefined();
    expect(validateLiveSelector("   ")).toBeUndefined();
  });

  it.each(["^$(touch pwned)$", "^x$; rm -rf /", "^x$ && evil", "^`id`$", "^x|y$", "^x>out$"])(
    "rejects shell metacharacters in the expanded selector [case %#]",
    (bad) => {
      expect(() => validateLiveSelector(bad)).toThrow(/unsupported character/);
    },
  );
});

describe("resolveLiveSelector (#6901)", () => {
  it.each([
    ["openclaw", "^mcp-bridge$"],
    ["hermes", "^mcp-bridge-hermes$"],
    ["deepagents", "^mcp-bridge-deepagents$"],
  ])(
    "infers the reviewed %s selector for trusted base-workflow compatibility",
    (agent, expected) => {
      expect(
        resolveLiveSelector(MCP_BRIDGE_TEST_PATH, undefined, {
          NEMOCLAW_MCP_BRIDGE_AGENT: agent,
        }),
      ).toBe(expected);
      expect(
        resolveLiveSelector(MCP_BRIDGE_TEST_PATH, expected, {
          NEMOCLAW_MCP_BRIDGE_AGENT: agent,
        }),
      ).toBe(expected);
    },
  );

  it("keeps the existing OpenClaw default for local MCP runs", () => {
    expect(resolveLiveSelector(MCP_BRIDGE_TEST_PATH, undefined, {})).toBe("^mcp-bridge$");
  });

  it("rejects an unsupported MCP agent or mismatched explicit selector", () => {
    expect(() =>
      resolveLiveSelector(MCP_BRIDGE_TEST_PATH, undefined, {
        NEMOCLAW_MCP_BRIDGE_AGENT: "all",
      }),
    ).toThrow(/unsupported NEMOCLAW_MCP_BRIDGE_AGENT/u);
    expect(() =>
      resolveLiveSelector(MCP_BRIDGE_TEST_PATH, "^mcp-bridge-hermes$", {
        NEMOCLAW_MCP_BRIDGE_AGENT: "openclaw",
      }),
    ).toThrow(/does not match agent/u);
  });

  it("does not infer selectors for unrelated live tests", () => {
    expect(
      resolveLiveSelector(FULL_E2E_TEST_PATH, undefined, {
        NEMOCLAW_MCP_BRIDGE_AGENT: "hermes",
      }),
    ).toBeUndefined();
  });
});

describe("buildLiveVitestArgs (#6961)", () => {
  it("builds the standard invocation with a selector", () => {
    expect(
      buildLiveVitestArgs({
        testPath: "test/e2e/live/registry-targets.test.ts",
        selector: "^ubuntu-repo-cloud-openclaw:",
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      "test/e2e/live/registry-targets.test.ts",
      "-t",
      "^ubuntu-repo-cloud-openclaw:",
      "--silent=false",
      "--reporter=default",
      `--reporter=${RISK_SIGNAL_REPORTER}`,
    ]);
  });

  it("omits the selector arguments for a single-file target", () => {
    expect(
      buildLiveVitestArgs({
        testPath: FULL_E2E_TEST_PATH,
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      FULL_E2E_TEST_PATH,
      "--silent=false",
      "--reporter=default",
      `--reporter=${RISK_SIGNAL_REPORTER}`,
    ]);
  });

  it("fails fast only for inference-routing (#9622)", () => {
    expect(buildLiveVitestArgs({ testPath: INFERENCE_ROUTING_TEST_PATH })).toContain("--bail=1");
    expect(buildLiveVitestArgs({ testPath: "test/e2e/live/onboard-resume.test.ts" })).not.toContain(
      "--bail=1",
    );
  });

  it("fails closed on an invalid input before producing any argv", () => {
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/live/x.test.ts",
        selector: "^x$; rm -rf /",
      }),
    ).toThrow(/unsupported character/);
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/support/x.test.ts",
        selector: "^x$",
        project: "e2e-live",
      }),
    ).toThrow(/must be under/);
  });
});

describe("runLiveVitestCommand (#6961)", () => {
  const validArgs = ["run", "--test-path", FULL_E2E_TEST_PATH];

  it.each([
    ["child status", { status: 7, signal: null }, 7],
    ["child signal", { status: null, signal: "SIGTERM" as NodeJS.Signals }, 143],
    ["missing status and signal", { status: null, signal: null }, 1],
  ])("preserves %s", (_label, result, expected) => {
    let spawned: Parameters<LiveVitestSpawner> | undefined;
    const spawn: LiveVitestSpawner = (...args) => {
      spawned = args;
      return result;
    };

    expect(runLiveVitestCommand(validArgs, spawn)).toBe(expected);
    expect(spawned).toEqual([
      "npx",
      [
        "vitest",
        "run",
        "--project",
        "e2e-live",
        FULL_E2E_TEST_PATH,
        "--silent=false",
        "--reporter=default",
        `--reporter=${RISK_SIGNAL_REPORTER}`,
      ],
      { stdio: "inherit" },
    ]);
  });

  it("surfaces child launch failures", () => {
    const launchError = new Error("spawn npx ENOENT");
    const spawn: LiveVitestSpawner = () => ({
      status: null,
      signal: null,
      error: launchError,
    });

    expect(() => runLiveVitestCommand(validArgs, spawn)).toThrow(launchError);
  });

  it("passes the inferred MCP selector to Vitest when trusted base YAML omits it", () => {
    let spawned: Parameters<LiveVitestSpawner> | undefined;
    const spawn: LiveVitestSpawner = (...args) => {
      spawned = args;
      return { status: 0 };
    };

    expect(
      runLiveVitestCommand(["run", "--test-path", MCP_BRIDGE_TEST_PATH], spawn, {
        NEMOCLAW_MCP_BRIDGE_AGENT: "hermes",
      }),
    ).toBe(0);
    expect(spawned?.[1]).toContain("-t");
    expect(spawned?.[1]).toContain("^mcp-bridge-hermes$");
  });

  it.each([
    ["unknown option", ["run", "--test-path", FULL_E2E_TEST_PATH, "--selctor", "^x$"]],
    ["bare selector", [...validArgs, "--selector"]],
  ])("rejects an %s before spawning Vitest", (_label, args) => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() => runLiveVitestCommand(args, spawn)).toThrow(/unsupported.*option|requires a value/);
    expect(spawned).toBe(false);
  });

  it("rejects a repeated supported option before spawning Vitest", () => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() =>
      runLiveVitestCommand(
        [...validArgs, "--test-path", "test/e2e/live/registry-targets.test.ts"],
        spawn,
      ),
    ).toThrow(/must not be repeated/);
    expect(spawned).toBe(false);
  });

  it.each([
    ["missing", []],
    ["unsupported", ["runx"]],
  ])("fails the workflow CLI for a %s subcommand", (_label, args) => {
    const result = spawnSync(TSX, [LIVE_VITEST_TOOL, ...args], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected "run"');
  });
});

it.each([
  ["spark-express-vllm", "^spark-express-vllm:"],
  ["dgx-station-express", "^dgx-station-express:"],
])("runs only the selected %s case from the shared DGX file", (target, selector) => {
  let spawned: Parameters<LiveVitestSpawner> | undefined;
  const spawn: LiveVitestSpawner = (...args) => {
    spawned = args;
    return { status: 0 };
  };
  expect(
    runLiveVitestCommand(
      ["run", "--test-path", DGX_EXPRESS_TEST_PATH, "--selector", selector],
      spawn,
      { E2E_TARGET_ID: target },
    ),
  ).toBe(0);
  expect(spawned?.[1]).toEqual(buildLiveVitestArgs({ testPath: DGX_EXPRESS_TEST_PATH, selector }));
  expect(spawned?.[1]).toContain(selector);
});

it.each([
  ["dgx-station-express", []],
  ["spark-express-vllm", []],
  [undefined, ["--selector", "^dgx-station-express:"]],
  ["unknown", ["--selector", "^dgx-station-express:"]],
  ["spark-express-vllm", ["--selector", "^dgx-station-express:"]],
  ["dgx-station-express", ["--selector", "^spark-express-vllm:"]],
  ["dgx-station-express", ["--selector", "^dgx"]],
] as const)("rejects a DGX selector mismatch before spawning: %s / %j", (target, selectorArgs) => {
  let spawned = false;
  const spawn: LiveVitestSpawner = () => {
    spawned = true;
    return { status: 0 };
  };
  expect(() =>
    runLiveVitestCommand(["run", "--test-path", DGX_EXPRESS_TEST_PATH, ...selectorArgs], spawn, {
      E2E_TARGET_ID: target,
    }),
  ).toThrow("DGX Express requires an explicit selector matching E2E_TARGET_ID");
  expect(spawned).toBe(false);
});

it.each([
  ["spark-express-vllm", "^spark-express-vllm:"],
  ["dgx-station-express", "^dgx-station-express:"],
])(
  "collects exactly the %s live case without executing hardware operations",
  (target, selector) => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "list",
        "--project",
        "e2e-live",
        DGX_EXPRESS_TEST_PATH,
        "--json",
        "-t",
        selector,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_PHASE_COLLECTION: "1",
          E2E_TARGET_ID: target,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const tests = JSON.parse(result.stdout);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ name: expect.stringMatching(new RegExp(selector)) });
  },
);

it.each(["test/e2e/live/./dgx-express.test.ts", "test/e2e/live//dgx-express.test.ts"])(
  "applies DGX selector checks to an equivalent test path: %s",
  (testPath) => {
    expect(validateLiveTestPath(testPath)).toBe(DGX_EXPRESS_TEST_PATH);
    expect(() =>
      runLiveVitestCommand(
        ["run", "--test-path", testPath],
        () => {
          throw new Error("unexpected spawn");
        },
        { E2E_TARGET_ID: "dgx-station-express" },
      ),
    ).toThrow("DGX Express requires an explicit selector matching E2E_TARGET_ID");
  },
);
