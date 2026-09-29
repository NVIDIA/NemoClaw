// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../../src/lib/adapters/openshell/provider-adapter-cli";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../../../src/lib/adapters/openshell/provider-adapter";

import {
  deleteProviderWithRecovery,
  detachSandboxProviders,
  type DetachSandboxProvidersDeps,
  emitProviderDetachResidualHint,
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../../src/lib/onboard/sandbox-provider-cleanup.js";

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
  it("covers the full set of per-sandbox messaging and search providers", async () => {
    expect([...SANDBOX_PROVIDER_SUFFIXES].sort()).toEqual(
      [
        "telegram-bridge",
        "discord-bridge",
        "wechat-bridge",
        "slack-bridge",
        "slack-app",
        "teams-bridge",
        "googlechat-bridge",
        "brave-search",
        "tavily-search",
      ].sort(),
    );
  });
});

describe("detachSandboxProviders", () => {
  it("issues 'sandbox provider detach' for every suffix in the shared set", async () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    const result = await detachSandboxProviders("spark-nemo", { runOpenshell });

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

  it("detects a same-name replacement after one detach and stops later detaches (#9833)", async () => {
    const calls: string[][] = [];
    const expectedIdentity = "identity-a";
    let liveIdentity = expectedIdentity;
    const runOpenshell = vi.fn((args: string[]) => {
      calls.push(args);
      liveIdentity = "identity-b";
      return { status: 0 };
    });
    const revalidateSandboxIdentity = vi.fn((_operation: string) => {
      liveIdentity === expectedIdentity ||
        (() => {
          throw new Error("sandbox identity changed");
        })();
    });
    const deps: DetachSandboxProvidersDeps = { runOpenshell, revalidateSandboxIdentity };

    await expect(detachSandboxProviders("alpha", deps)).rejects.toThrow(
      /sandbox identity changed/u,
    );
    expect(calls).toHaveLength(1);
    expect(revalidateSandboxIdentity.mock.calls.map(([operation]) => operation)).toEqual([
      expect.stringMatching(/^detaching provider /u),
      expect.stringMatching(/^confirming provider /u),
    ]);
  });

  it("treats provider-scoped NotFound / not attached outputs as success-equivalent", async () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach alpha alpha-telegram-bridge",
        {
          status: 1,
          stderr: "Error: provider 'alpha-telegram-bridge' not found",
        },
      ],
      [
        "sandbox provider detach alpha alpha-brave-search",
        { status: 2, stderr: "provider not attached to sandbox" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = await detachSandboxProviders("alpha", { runOpenshell });

    expect(result.failures).toEqual([]);
    expect(result.detached).toContain("alpha-discord-bridge");
    expect(result.detached).not.toContain("alpha-telegram-bridge");
    expect(result.detached).not.toContain("alpha-brave-search");
  });

  it("tolerates the compact NotAttached status spelling", async () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach gamma gamma-slack-bridge",
        { status: 9, stderr: "status: NotAttached, provider 'gamma-slack-bridge' is not bound" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = await detachSandboxProviders("gamma", { runOpenshell });

    expect(result.failures).toEqual([]);
    expect(result.detached).not.toContain("gamma-slack-bridge");
  });

  it("does not tolerate a bare sandbox-not-found diagnostic — stale attachment may remain", async () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach zulu zulu-telegram-bridge",
        { status: 1, stderr: "Error: status: NotFound, sandbox 'zulu' not found" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = await detachSandboxProviders("zulu", { runOpenshell });

    expect(result.failures).toEqual([
      {
        name: "zulu-telegram-bridge",
        output: "OpenShell sandbox not found: 'zulu'.",
      },
    ]);
  });

  it("does not tolerate unrelated gateway errors that incidentally contain 'not attached'", async () => {
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

    const result = await detachSandboxProviders("yankee", { runOpenshell });

    expect(result.failures).toEqual([
      {
        name: "yankee-telegram-bridge",
        output:
          "Error: internal gateway error: shield 'sentry' is not attached to its expected anchor",
      },
    ]);
  });

  it("retains a detach failure for a different missing sandbox even when absence is tolerated", async () => {
    const { runOpenshell } = buildRunOpenshell(
      new Map([
        [
          "sandbox provider detach phantom phantom-telegram-bridge",
          {
            status: 1,
            stderr: "Error: status: NotFound, sandbox 'other-box' not found",
          },
        ],
      ]),
    );
    const result = await detachSandboxProviders("phantom", {
      runOpenshell,
      tolerateMissingSandbox: true,
    });
    expect(result.failures).toEqual([
      {
        name: "phantom-telegram-bridge",
        output: "Error: status: NotFound, sandbox 'other-box' not found",
      },
    ]);
  });

  it("tolerates sandbox-not-found when tolerateMissingSandbox is set (opportunistic call)", async () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach phantom phantom-telegram-bridge",
        { status: 1, stderr: "Error: status: NotFound, sandbox 'phantom' not found" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = await detachSandboxProviders("phantom", {
      runOpenshell,
      tolerateMissingSandbox: true,
    });

    expect(result.failures).toEqual([]);
  });

  it("suppresses output for tolerated missing-sandbox detach probes", async () => {
    const { runOpenshell } = buildRunOpenshell(new Map(), {
      status: 1,
      stderr: "Error: status: NotFound, sandbox 'phantom' not found",
    });

    const result = await detachSandboxProviders("phantom", {
      runOpenshell,
      tolerateMissingSandbox: true,
    });

    expect(result.failures).toEqual([]);
    expect(runOpenshell).toHaveBeenCalledTimes(SANDBOX_PROVIDER_SUFFIXES.length);
    runOpenshell.mock.calls.forEach(([, opts]) => {
      expect(opts).toMatchObject({
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
  });

  it("collects non-tolerated failures without aborting the loop", async () => {
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach beta beta-telegram-bridge",
        { status: 1, stderr: "Error: status: Internal, gateway timeout" },
      ],
    ]);
    const { runOpenshell, calls } = buildRunOpenshell(responses);

    const result = await detachSandboxProviders("beta", { runOpenshell });

    const detachCalls = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    );
    expect(detachCalls).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(result.failures).toEqual([
      { name: "beta-telegram-bridge", output: "Error: status: Internal, gateway timeout" },
    ]);
    expect(result.detached).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length - 1);
  });

  it("includes Brave and Tavily search providers in the detach set", async () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    await detachSandboxProviders("spark-nemo", { runOpenshell });

    const braveCall = calls.find(
      (argv) =>
        argv[0] === "sandbox" &&
        argv[1] === "provider" &&
        argv[2] === "detach" &&
        argv[4] === "spark-nemo-brave-search",
    );
    expect(braveCall).toBeDefined();
    const tavilyCall = calls.find(
      (argv) =>
        argv[0] === "sandbox" &&
        argv[1] === "provider" &&
        argv[2] === "detach" &&
        argv[4] === "spark-nemo-tavily-search",
    );
    expect(tavilyCall).toBeDefined();
  });
});

describe("runSandboxProviderPreDeleteCleanup", () => {
  it("emits no warning when every detach succeeds", async () => {
    const { runOpenshell } = buildRunOpenshell(new Map());
    const warn = vi.fn();

    const result = await runSandboxProviderPreDeleteCleanup("spark-nemo", { runOpenshell, warn });

    expect(warn).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
  });

  it("redacts the OpenShell failure output before warning", async () => {
    const tokenOutput =
      "Error: token AKIA0123456789ABCDEF failed: status Internal, gateway timeout";
    const responses = new Map<string, RunResult>([
      ["sandbox provider detach delta delta-telegram-bridge", { status: 1, stderr: tokenOutput }],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const warn = vi.fn();
    const redact = vi.fn((s: string) => s.replace(/AKIA[0-9A-Z]+/, "[REDACTED]"));

    const result = await runSandboxProviderPreDeleteCleanup("delta", {
      runOpenshell,
      warn,
      redact,
    });

    expect(result.failures).toHaveLength(1);
    expect(redact).toHaveBeenCalledWith(result.failures[0].output);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0] as string;
    expect(warning).toContain("<REDACTED>");
    expect(warning).not.toContain("AKIA0123456789ABCDEF");
    expect(warning).toContain("delta-telegram-bridge");
  });

  it("caps the warning output length to bound terminal noise on huge stderr", async () => {
    const longTail = "X".repeat(2000);
    const responses = new Map<string, RunResult>([
      [
        "sandbox provider detach echo echo-telegram-bridge",
        { status: 1, stderr: `internal gateway error: ${longTail}` },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const warn = vi.fn();

    await runSandboxProviderPreDeleteCleanup("echo", { runOpenshell, warn });

    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0] as string;
    expect(warning.length).toBeLessThan(900);
  });

  it("runs the detach pass before any caller-driven sandbox delete", async () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    await runSandboxProviderPreDeleteCleanup("foxtrot", { runOpenshell });
    runOpenshell(["sandbox", "delete", "foxtrot"], { ignoreError: true });

    const detachCount = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    ).length;
    const deleteIndex = calls.findIndex((argv) => argv[0] === "sandbox" && argv[1] === "delete");
    expect(detachCount).toBe(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(deleteIndex).toBeGreaterThan(detachCount - 1);
  });
});

describe("deleteProviderWithRecovery", () => {
  it.each([
    { status: 0 },
    { status: 1, stderr: "status: NotAttached, provider 'p' is not bound" },
    { status: 1, stderr: "provider 'p' not found" },
  ])("confirms every authorized attachment before the single delete retry: %#", async (detach) => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr: "provider 'p' is attached to sandbox(es): first, second",
      })
      .mockReturnValueOnce(detach)
      .mockReturnValueOnce(detach)
      .mockReturnValueOnce({ status: 0 });
    await expect(
      deleteProviderWithRecovery("p", {
        runOpenshell,
        allowedSandboxes: ["first", "second"],
      }),
    ).resolves.toEqual({ ok: true, recoveryFailures: [] });
    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "delete", "p"],
      ["sandbox", "provider", "detach", "first", "p"],
      ["sandbox", "provider", "detach", "second", "p"],
      ["provider", "delete", "p"],
    ]);
  });

  it("does not retry deletion when detach reports a different provider as missing", async () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr: "provider 'owned-provider' is attached to sandbox(es): mine",
      })
      .mockReturnValueOnce({ status: 1, stderr: "provider 'other-provider' not found" });

    const result = await deleteProviderWithRecovery("owned-provider", {
      runOpenshell,
      allowedSandboxes: ["mine"],
    });

    expect(result.ok).toBe(false);
    expect(result.recoveryFailures).toEqual([
      { sandbox: "mine", output: "provider 'other-provider' not found" },
    ]);
    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "delete", "owned-provider"],
      ["sandbox", "provider", "detach", "mine", "owned-provider"],
    ]);
  });

  it("waits for every typed detach before retrying an attached provider deletion", async () => {
    const events: string[] = [];
    let releaseDetach!: () => void;
    const pendingDetach = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const adapter: OpenShellProviderAdapter = {
      ...createCliOpenShellProviderAdapter({
        run: () => {
          throw new Error("unexpected transport");
        },
      }),
      deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
        events.push("delete");
        return events.length === 1
          ? {
              ok: false as const,
              error: {
                kind: "command" as const,
                reason: "attached" as const,
                message: "attached",
                attachedSandboxes: ["owned"],
              },
            }
          : { ok: true as const };
      }),
      detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
        events.push("detach-start");
        await pendingDetach;
        events.push("detach-complete");
        return { ok: true as const, value: { changed: true } };
      }),
    };
    const cleanup = deleteProviderWithRecovery("provider", {
      providerAdapter: adapter,
      allowedSandboxes: ["owned"],
    });
    await vi.waitFor(() => expect(events).toEqual(["delete", "detach-start"]));
    releaseDetach();
    await expect(cleanup).resolves.toMatchObject({ ok: true });
    expect(events).toEqual(["delete", "detach-start", "detach-complete", "delete"]);
  });

  it.each<OpenShellProviderError>([
    { kind: "timeout", message: "timed out" },
    { kind: "transport", reason: "connection_loss", message: "connection lost" },
    { kind: "command", reason: "uncertain", message: "outcome unknown" },
  ])(
    "preserves recovery state without another delete after a failed detach: $kind",
    async (error) => {
      const adapter: OpenShellProviderAdapter = {
        ...createCliOpenShellProviderAdapter({
          run: () => {
            throw new Error("unexpected transport");
          },
        }),
        deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
          ok: false,
          error: {
            kind: "command",
            reason: "attached",
            message: "attached",
            attachedSandboxes: ["owned"],
          },
        })),
        detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
          ok: false,
          error,
        })),
      };
      await expect(
        deleteProviderWithRecovery("provider", {
          providerAdapter: adapter,
          allowedSandboxes: ["owned"],
        }),
      ).resolves.toMatchObject({
        ok: false,
        recoveryFailures: [{ sandbox: "owned", output: error.message }],
      });
      expect(adapter.deleteProvider).toHaveBeenCalledOnce();
    },
  );

  it("does not detach or retry an uncertain delete even if its diagnostic names attachments", async () => {
    const adapter: OpenShellProviderAdapter = {
      ...createCliOpenShellProviderAdapter({
        run: () => {
          throw new Error("unexpected transport");
        },
      }),
      deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
        ok: false,
        error: {
          kind: "command",
          reason: "uncertain",
          message: "attached to sandbox(es): owned",
          attachedSandboxes: ["owned"],
        },
      })),
      detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(),
    };
    await expect(
      deleteProviderWithRecovery("provider", {
        providerAdapter: adapter,
        allowedSandboxes: ["owned"],
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(adapter.detachProvider).not.toHaveBeenCalled();
  });
  it("returns ok on first-attempt success without recovery", async () => {
    const { runOpenshell } = buildRunOpenshell(new Map());

    const result = await deleteProviderWithRecovery("happy-provider", { runOpenshell });

    expect(result.ok).toBe(true);
    expect(result.recoveryFailures).toEqual([]);
  });

  it("retries delete after force-detaching a sandbox from a wrapped diagnostic", async () => {
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
              "Error: × code: 'The system is not in a state required for the operation's\n" +
              "│ execution', message: \"provider 'p' is attached to\n" +
              '│ sandbox(es): orphan-one"',
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = await deleteProviderWithRecovery("p", { runOpenshell });

    expect(result.ok).toBe(true);
    expect(result.recoveryFailures).toEqual([]);
    expect(calls).toEqual([
      ["provider", "delete", "p"],
      ["sandbox", "provider", "detach", "orphan-one", "p"],
      ["provider", "delete", "p"],
    ]);
  });

  it("returns recovery failures and final delete failure when the retry still trips", async () => {
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

    const result = await deleteProviderWithRecovery("p", { runOpenshell });

    expect(result.ok).toBe(false);
    expect(result.recoveryFailures).toEqual([
      { sandbox: "stuck-sandbox", output: "gateway unreachable" },
    ]);
  });

  it("force-detaches when every attached sandbox is inside the allowed set", async () => {
    const calls: string[][] = [];
    let attempt = 0;
    const runOpenshell = vi.fn((args: string[]) => {
      calls.push(args);
      const isDelete = args[0] === "provider" && args[1] === "delete";
      const firstDeleteFails = isDelete && ++attempt === 1;
      return firstDeleteFails
        ? {
            status: 1,
            stdout: "",
            stderr:
              "Error: status: FailedPrecondition, message: \"provider 'p' is attached to sandbox(es): mine\"",
          }
        : { status: 0, stdout: "", stderr: "" };
    });

    const result = await deleteProviderWithRecovery("p", {
      runOpenshell,
      allowedSandboxes: ["mine"],
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["provider", "delete", "p"],
      ["sandbox", "provider", "detach", "mine", "p"],
      ["provider", "delete", "p"],
    ]);
  });

  it("fails closed without detaching when a sandbox outside the allowed set appears (security)", async () => {
    const calls: string[][] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      calls.push(args);
      return {
        status: 1,
        stdout: "",
        stderr:
          "Error: status: FailedPrecondition, message: \"provider 'p' is attached to sandbox(es): mine, someone-else\"",
      };
    });

    const result = await deleteProviderWithRecovery("p", {
      runOpenshell,
      allowedSandboxes: ["mine"],
    });

    expect(result.ok).toBe(false);
    expect(result.recoveryFailures).toEqual([]);
    // Only the initial delete ran; no `sandbox provider detach` was issued.
    expect(calls).toEqual([["provider", "delete", "p"]]);
  });
});

describe("emitProviderDetachResidualHint", () => {
  it("emits nothing when there are no failures", async () => {
    const warn = vi.fn();
    emitProviderDetachResidualHint("alpha", [], warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits a detach-then-delete sequence keyed to the sandbox name", async () => {
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
