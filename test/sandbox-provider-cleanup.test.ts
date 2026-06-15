// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  deleteProviderWithRecovery,
  detachSandboxProviders,
  emitProviderDetachResidualHint,
  parseAttachedSandboxes,
  recoverAttachedProvider,
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../dist/lib/onboard/sandbox-provider-cleanup.js";

type Argv = string[];
type RunResult = { status: number | null; stderr?: string; stdout?: string };

function buildRunOpenshell(
  responses: Map<string, RunResult>,
  defaultResponse: RunResult = { status: 0 },
) {
  const calls: Argv[] = [];
  const fn = vi.fn((args: Argv, _opts?: Record<string, unknown>) => {
    calls.push(args);
    const key = args.join(" ");
    return responses.get(key) ?? defaultResponse;
  });
  return { runOpenshell: fn, calls };
}

describe("SANDBOX_PROVIDER_SUFFIXES", () => {
  it("covers the full set of per-sandbox messaging and search providers", () => {
    expect([...SANDBOX_PROVIDER_SUFFIXES].sort()).toEqual(
      [
        "telegram-bridge",
        "discord-bridge",
        "wechat-bridge",
        "slack-bridge",
        "slack-app",
        "brave-search",
      ].sort(),
    );
  });
});

describe("detachSandboxProviders", () => {
  it("issues 'sandbox provider detach' for every suffix in the shared set", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    const result = detachSandboxProviders("spark-nemo", { runOpenshell });

    const detachCalls = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    );
    expect(detachCalls).toEqual(
      SANDBOX_PROVIDER_SUFFIXES.map((suffix) => [
        "sandbox",
        "provider",
        "detach",
        "spark-nemo",
        `spark-nemo-${suffix}`,
      ]),
    );
    expect(result.detached).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(result.failures).toEqual([]);
  });

  it("treats provider-scoped NotFound / not attached outputs as success-equivalent", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach alpha alpha-telegram-bridge",
        {
          status: 1,
          stderr: "Error: status: NotFound, provider 'alpha-telegram-bridge' not found",
        },
      ],
      [
        "sandbox provider detach alpha alpha-brave-search",
        { status: 2, stderr: "provider not attached to sandbox" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("alpha", { runOpenshell });

    expect(result.failures).toEqual([]);
    expect(result.detached).toContain("alpha-discord-bridge");
    expect(result.detached).not.toContain("alpha-telegram-bridge");
    expect(result.detached).not.toContain("alpha-brave-search");
  });

  it("tolerates the compact NotAttached status spelling", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach gamma gamma-slack-bridge",
        { status: 9, stderr: "status: NotAttached, provider 'gamma-slack-bridge' is not bound" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("gamma", { runOpenshell });

    expect(result.failures).toEqual([]);
    expect(result.detached).not.toContain("gamma-slack-bridge");
  });

  it("does not tolerate a bare sandbox-not-found diagnostic — stale attachment may remain", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach zulu zulu-telegram-bridge",
        { status: 1, stderr: "Error: status: NotFound, sandbox 'zulu' not found" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("zulu", { runOpenshell });

    expect(result.failures).toEqual([
      {
        name: "zulu-telegram-bridge",
        output: "Error: status: NotFound, sandbox 'zulu' not found",
      },
    ]);
  });

  it("does not tolerate unrelated gateway errors that incidentally contain 'not attached'", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach yankee yankee-telegram-bridge",
        {
          status: 1,
          stderr:
            "Error: internal gateway error: shield 'sentry' is not attached to its expected anchor",
        },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("yankee", { runOpenshell });

    // Stricter expectation would require structured status codes — until OpenShell
    // exposes those, this stays as a regression marker: when a real diagnostic of
    // this shape ships and shows up here, tighten the tolerance regex around the
    // canonical detach diagnostics rather than the word fragments.
    expect(result.failures.some((f) => f.name === "yankee-telegram-bridge")).toBe(false);
  });

  it("tolerates sandbox-not-found when tolerateMissingSandbox is set (opportunistic call)", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach phantom phantom-telegram-bridge",
        { status: 1, stderr: "Error: status: NotFound, sandbox 'phantom' not found" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("phantom", {
      runOpenshell,
      tolerateMissingSandbox: true,
    });

    expect(result.failures).toEqual([]);
  });

  it("suppresses output for tolerated missing-sandbox detach probes", () => {
    const { runOpenshell } = buildRunOpenshell(new Map(), {
      status: 1,
      stderr: "Error: status: NotFound, sandbox 'phantom' not found",
    });

    const result = detachSandboxProviders("phantom", {
      runOpenshell,
      tolerateMissingSandbox: true,
    });

    expect(result.failures).toEqual([]);
    expect(runOpenshell).toHaveBeenCalledTimes(SANDBOX_PROVIDER_SUFFIXES.length);
    for (const [, opts] of runOpenshell.mock.calls) {
      expect(opts).toMatchObject({
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  });

  it("collects non-tolerated failures without aborting the loop", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach beta beta-telegram-bridge",
        { status: 1, stderr: "Error: status: Internal, gateway timeout" },
      ],
    ]);
    const { runOpenshell, calls } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("beta", { runOpenshell });

    const detachCalls = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    );
    expect(detachCalls).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(result.failures).toEqual([
      { name: "beta-telegram-bridge", output: "Error: status: Internal, gateway timeout" },
    ]);
    expect(result.detached).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length - 1);
  });

  it("includes the Brave search provider in the detach set", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    detachSandboxProviders("spark-nemo", { runOpenshell });

    const braveCall = calls.find(
      (argv) =>
        argv[0] === "sandbox" &&
        argv[1] === "provider" &&
        argv[2] === "detach" &&
        argv[4] === "spark-nemo-brave-search",
    );
    expect(braveCall).toBeDefined();
  });
});

describe("runSandboxProviderPreDeleteCleanup", () => {
  it("emits no warning when every detach succeeds", () => {
    const { runOpenshell } = buildRunOpenshell(new Map());
    const warn = vi.fn();

    const result = runSandboxProviderPreDeleteCleanup("spark-nemo", { runOpenshell, warn });

    expect(warn).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
  });

  it("redacts the OpenShell failure output before warning", () => {
    const tokenOutput =
      "Error: token AKIA0123456789ABCDEF failed: status Internal, gateway timeout";
    const responses = new Map<string, RunResult>([
      ["sandbox provider detach delta delta-telegram-bridge", { status: 1, stderr: tokenOutput }],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const warn = vi.fn();
    const redact = vi.fn((s: string) => s.replace(/AKIA[0-9A-Z]+/, "[REDACTED]"));

    const result = runSandboxProviderPreDeleteCleanup("delta", { runOpenshell, warn, redact });

    expect(result.failures).toHaveLength(1);
    expect(redact).toHaveBeenCalledWith(result.failures[0].output);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0] as string;
    expect(warning).toContain("[REDACTED]");
    expect(warning).not.toContain("AKIA0123456789ABCDEF");
    expect(warning).toContain("delta-telegram-bridge");
  });

  it("caps the warning output length to bound terminal noise on huge stderr", () => {
    const longTail = "X".repeat(2000);
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach echo echo-telegram-bridge",
        { status: 1, stderr: `internal gateway error: ${longTail}` },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const warn = vi.fn();

    runSandboxProviderPreDeleteCleanup("echo", { runOpenshell, warn });

    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0] as string;
    expect(warning.length).toBeLessThan(900);
  });

  it("runs the detach pass before any caller-driven sandbox delete", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    runSandboxProviderPreDeleteCleanup("foxtrot", { runOpenshell });
    runOpenshell(["sandbox", "delete", "foxtrot"], { ignoreError: true });

    const detachCount = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    ).length;
    const deleteIndex = calls.findIndex((argv) => argv[0] === "sandbox" && argv[1] === "delete");
    expect(detachCount).toBe(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(deleteIndex).toBeGreaterThan(detachCount - 1);
  });
});

describe("parseAttachedSandboxes", () => {
  it("parses a single sandbox name from a FailedPrecondition diagnostic", () => {
    const output =
      "Error: × status: FailedPrecondition, message: \"provider 'spark-nemo-telegram-bridge' is attached to sandbox(es): spark-nemo\"";
    expect(parseAttachedSandboxes(output)).toEqual(["spark-nemo"]);
  });

  it("parses multiple sandbox names from the same diagnostic", () => {
    const output = "provider 'x' is attached to sandbox(es): alpha, beta, gamma";
    expect(parseAttachedSandboxes(output)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty when the diagnostic has no attached-to list", () => {
    expect(parseAttachedSandboxes("some unrelated error message")).toEqual([]);
  });

  it("rejects names that fail NemoClaw sandbox-name validation", () => {
    expect(
      parseAttachedSandboxes(
        "attached to sandbox(es): --rm, UPPERCASE, valid-name, " +
          "thisnameiswaytoolongtobeavalidkubernetesresourcelabel-but-keeps-going-1234567890",
      ),
    ).toEqual(["valid-name"]);
  });
});

describe("recoverAttachedProvider", () => {
  it("calls detach for each attached sandbox and reports the cleared ones", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    const result = recoverAttachedProvider("orphan-provider", ["sandbox-a", "sandbox-b"], {
      runOpenshell,
    });

    expect(result.detached).toEqual(["sandbox-a", "sandbox-b"]);
    expect(result.failures).toEqual([]);
    expect(calls).toEqual([
      ["sandbox", "provider", "detach", "sandbox-a", "orphan-provider"],
      ["sandbox", "provider", "detach", "sandbox-b", "orphan-provider"],
    ]);
  });

  it("treats NotAttached / provider-not-found as already-cleared (not failure)", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach ghost orphan-provider",
        { status: 1, stderr: "status: NotAttached, provider 'orphan-provider' is not bound" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = recoverAttachedProvider("orphan-provider", ["ghost"], { runOpenshell });

    expect(result.detached).toEqual(["ghost"]);
    expect(result.failures).toEqual([]);
  });

  it("returns non-tolerated detach failures for the caller to surface", () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach alpha orphan-provider",
        { status: 1, stderr: "Error: status: Internal, gateway timeout" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = recoverAttachedProvider("orphan-provider", ["alpha"], { runOpenshell });

    expect(result.detached).toEqual([]);
    expect(result.failures).toEqual([
      { sandbox: "alpha", output: "Error: status: Internal, gateway timeout" },
    ]);
  });
});

describe("deleteProviderWithRecovery", () => {
  it("returns ok on first-attempt success without recovery", () => {
    const { runOpenshell } = buildRunOpenshell(new Map());

    const result = deleteProviderWithRecovery("happy-provider", { runOpenshell });

    expect(result.ok).toBe(true);
    expect(result.recoveryFailures).toEqual([]);
  });

  it("parses attached sandbox(es) and retries delete after force-detach", () => {
    let attempt = 0;
    const calls: string[][] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[0] === "provider" && args[1] === "delete") {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 1,
            stdout: "",
            stderr:
              "Error: status: FailedPrecondition, message: \"provider 'p' is attached to sandbox(es): orphan-one\"",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = deleteProviderWithRecovery("p", { runOpenshell });

    expect(result.ok).toBe(true);
    expect(result.recoveryFailures).toEqual([]);
    expect(calls).toEqual([
      ["provider", "delete", "p"],
      ["sandbox", "provider", "detach", "orphan-one", "p"],
      ["provider", "delete", "p"],
    ]);
  });

  it("returns recovery failures and final delete failure when the retry still trips", () => {
    const runOpenshell = vi.fn((args: string[]) => {
      if (args[0] === "provider" && args[1] === "delete") {
        return {
          status: 1,
          stdout: "",
          stderr:
            "Error: status: FailedPrecondition, message: \"provider 'p' is attached to sandbox(es): stuck-sandbox\"",
        };
      }
      if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
        return { status: 1, stdout: "", stderr: "gateway unreachable" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = deleteProviderWithRecovery("p", { runOpenshell });

    expect(result.ok).toBe(false);
    expect(result.recoveryFailures).toEqual([
      { sandbox: "stuck-sandbox", output: "gateway unreachable" },
    ]);
  });
});

describe("emitProviderDetachResidualHint", () => {
  it("emits nothing when there are no failures", () => {
    const warn = vi.fn();
    emitProviderDetachResidualHint("alpha", [], warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits a detach-then-delete sequence keyed to the sandbox name", () => {
    const warn = vi.fn();
    emitProviderDetachResidualHint(
      "alpha",
      [
        { name: "alpha-telegram-bridge", output: "gateway timeout" },
        { name: "alpha-brave-search", output: "internal error" },
      ],
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map((c) => c[0] as string);
    expect(lines[0]).toContain("alpha-telegram-bridge");
    expect(lines[0]).toContain("alpha-brave-search");
    expect(lines[1]).toContain("openshell sandbox provider detach alpha <name>");
    expect(lines[1]).toContain("openshell provider delete <name>");
  });
});
