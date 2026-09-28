// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";

import {
  classifyWebSearchEnvBoundary,
  verifyWebSearchInsideSandbox,
  type WebSearchVerifyDeps,
} from "./web-search-verify";

function deps(output: string | null | Array<string | null>) {
  const outputs = Array.isArray(output) ? [...output] : [output];
  const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => {
    const result = outputs.shift() ?? null;
    return result === null
      ? {
          outcome: {
            kind: "failed" as const,
            error: { kind: "invocation" as const, message: "failed" },
          },
          stdout: "",
          stderr: "",
        }
      : { outcome: { kind: "completed" as const, exitCode: 0 }, stdout: result, stderr: "" };
  });
  return {
    runBuffered,
    commandExecutor: { runBuffered },
    cliName: vi.fn(() => "nemoclaw"),
    webSearchEnvFor: vi.fn((provider) =>
      provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
    ),
    webSearchLabelFor: vi.fn((provider) =>
      provider === "tavily" ? "Tavily Search" : "Brave Search",
    ),
    log: vi.fn(),
    warn: vi.fn(),
  } satisfies WebSearchVerifyDeps & { runBuffered: typeof runBuffered };
}

describe("verifyWebSearchInsideSandbox", () => {
  it("verifies Hermes Tavily egress through JSON body credential rewriting", async () => {
    // Before config diagnostics and the egress probe, the secret-boundary check
    // classifies the selected env var in-sandbox.
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      "web:\n  backend: tavily\n",
      '__nemoclaw_tavily__:{"kind":"response","status":200,"has_results":true}\n',
    ]);

    await verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", d);

    expect(d.runBuffered).toHaveBeenCalledTimes(3);
    expect(d.runBuffered.mock.calls[1][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["cat", "/sandbox/.hermes/config.yaml"],
    });
    // The boundary probe classifies in-sandbox with `sh -c` (no login profiles)
    // and returns only a marked sentinel.
    expect(d.runBuffered.mock.calls[0][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["sh", "-c", expect.stringContaining("printenv TAVILY_API_KEY")],
      timeoutMilliseconds: 10_000,
    });
    expect(d.runBuffered.mock.calls[0][0].command[2]).not.toContain("cat ");
    expect(d.runBuffered.mock.calls[2][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["/opt/hermes/.venv/bin/python", "-I", "-c", expect.any(String)],
    });
    expect(d.log).toHaveBeenCalledWith("  ✓ Tavily Search egress verified inside sandbox");
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("blocks Hermes handoff when the sandbox env exposes a raw Tavily key (#7425)", async () => {
    const d = deps("__nemoclaw_wsenv__:raw-secret");

    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "hermes" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(false);
    expect(d.runBuffered).toHaveBeenCalledTimes(1);
    expect(d.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    );
  });

  it.each([
    {
      label: "unreadable Hermes config",
      agent: { name: "hermes" },
      provider: "tavily" as const,
      config: null,
      alert: "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    },
    {
      label: "malformed Hermes config",
      agent: { name: "hermes" },
      provider: "tavily" as const,
      config: "web: [\n",
      alert: "  ✗ SECURITY: the Tavily Search credential is exposed in the sandbox environment.",
    },
    {
      label: "disabled OpenClaw config",
      agent: { name: "openclaw" },
      provider: "brave" as const,
      config: JSON.stringify({ tools: { web: { search: { enabled: false } } } }),
      alert: "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    },
    {
      label: "unsupported OpenClaw provider",
      agent: { name: "openclaw" },
      provider: "brave" as const,
      config: JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "unsupported" } } },
      }),
      alert: "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    },
  ])(
    "blocks $label before configuration diagnostics (#7425)",
    async ({ agent, provider, config, alert }) => {
      const d = deps(["__nemoclaw_wsenv__:raw-secret", config]);

      const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
        "alpha",
        agent,
        provider,
        d,
      );

      expect(credentialBoundarySafe).toBe(false);
      expect(d.runBuffered).toHaveBeenCalledTimes(1);
      expect(d.warn).toHaveBeenCalledWith(alert);
    },
  );

  it("does not treat pinned Hermes dump-shaped output as an active Tavily backend", async () => {
    const d = deps(["__nemoclaw_wsenv__:absent", "active toolsets: web, shell\n"]);

    await verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search was configured but Hermes config does not select web.backend=tavily.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Check: nemoclaw alpha exec -- cat /sandbox/.hermes/config.yaml",
    );
    expect(d.runBuffered).toHaveBeenCalledTimes(2);
  });

  it("warns when the Hermes config is missing or malformed", async () => {
    const missing = deps(["__nemoclaw_wsenv__:absent", null]);
    await verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", missing);
    expect(missing.warn).toHaveBeenCalledWith(
      "  ⚠ Could not read Hermes config to verify Tavily Search.",
    );

    const malformed = deps(["__nemoclaw_wsenv__:absent", "web: [\n"]);
    await verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse Hermes config to verify Tavily Search.",
    );
  });

  it("verifies OpenClaw Brave Search egress through the subscription-token header", async () => {
    // Current schema: the provider-owned apiKey lives under
    // plugins.entries.brave.config.webSearch, not inline on tools.web.search.
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "brave" } } },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.runBuffered).toHaveBeenCalledTimes(3);
    expect(d.runBuffered.mock.calls[0][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["sh", "-c", expect.stringContaining("printenv BRAVE_API_KEY")],
      timeoutMilliseconds: 10_000,
    });
    expect(d.runBuffered.mock.calls[2][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: [
        "sh",
        "-lc",
        expect.stringContaining("X-Subscription-Token: openshell:resolve:env:BRAVE_API_KEY"),
      ],
    });
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("verifies OpenClaw Tavily Search egress through the bearer header", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "tavily" } } },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ results: [{ title: "NVIDIA" }] }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.runBuffered).toHaveBeenCalledTimes(3);
    expect(d.runBuffered.mock.calls[2][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: [
        "sh",
        "-lc",
        expect.stringContaining("Authorization: Bearer openshell:resolve:env:TAVILY_API_KEY"),
      ],
    });
    expect(d.runBuffered.mock.calls[2][0].command[2]).toContain("https://api.tavily.com/search");
    expect(d.log).toHaveBeenCalledWith("  ✓ Tavily Search egress verified inside sandbox");
  });

  it("does not accept an empty Tavily results array as successful verification", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "tavily" } } },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ results: [] }) + "\nHTTP_STATUS:200\n",
    ]);

    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "tavily",
      d,
    );

    expect(credentialBoundarySafe).toBe(true);
    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Tavily Search config exists, but egress verification returned HTTP 200.",
    );
    expect(d.log).not.toHaveBeenCalled();
  });

  it("still probes legacy configs that carry the apiKey inline on tools.web.search", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "openshell:resolve:env:BRAVE_API_KEY",
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    expect(d.runBuffered).toHaveBeenCalledTimes(3);
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("warns when OpenClaw Brave Search egress rejects the placeholder", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "openshell:resolve:env:BRAVE_API_KEY",
            },
          },
        },
      }),
      '{"message":"Unauthorized"}\nHTTP_STATUS:401\n',
    ]);

    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search config exists, but egress verification returned HTTP 401.",
    );
    expect(d.warn).toHaveBeenCalledWith(
      "    Re-run onboarding with --recreate-sandbox to migrate the Brave provider to the new profile.",
    );
  });

  it("refuses to probe when the apiKey is a literal secret rather than a placeholder", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              apiKey: "literal-secret-do-not-interpolate",
            },
          },
        },
      }),
    ]);

    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    // The config read and the sentinel-only boundary probe run, but no curl
    // probe interpolates the raw key.
    expect(d.runBuffered).toHaveBeenCalledTimes(2);
    expect(d.runBuffered.mock.calls[0][0]).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["sh", "-c", expect.any(String)],
    });
    const commandArguments = d.runBuffered.mock.calls.flatMap(([request]) => request.command);
    expect(commandArguments.join("\n")).not.toContain("literal-secret-do-not-interpolate");
    expect(d.warn).toHaveBeenCalledWith(
      "  ⚠ Brave Search apiKey in openclaw.json is not an OpenShell placeholder; skipping egress probe.",
    );
  });

  it("warns when OpenClaw config is malformed or disabled", async () => {
    const malformed = deps(["__nemoclaw_wsenv__:absent", "not-json"]);
    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", malformed);
    expect(malformed.warn).toHaveBeenCalledWith(
      "  ⚠ Could not parse openclaw.json to verify web search config.",
    );

    const disabled = deps([
      "__nemoclaw_wsenv__:absent",
      JSON.stringify({ tools: { web: { search: { enabled: false } } } }),
    ]);
    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", disabled);
    expect(disabled.warn).toHaveBeenCalledWith(
      "  ⚠ Web search was configured but tools.web.search is not enabled in openclaw.json.",
    );
  });

  it("warns for unknown agents after checking the selected credential boundary", async () => {
    const unknown = deps("__nemoclaw_wsenv__:absent");
    await verifyWebSearchInsideSandbox("alpha", { name: "other" }, "brave", unknown);
    expect(unknown.warn).toHaveBeenCalledWith(
      "  ⚠ Web search verification is not implemented for agent 'other'.",
    );
  });

  it("blocks handoff when the credential-boundary probe fails closed (#7425)", async () => {
    const throwing = deps(null);
    throwing.commandExecutor.runBuffered = vi.fn(async () => {
      throw new Error("boom");
    });
    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      throwing,
    );
    expect(credentialBoundarySafe).toBe(false);
    expect(throwing.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: could not verify the Brave Search credential isolation boundary.",
    );
  });

  it("raises a security alert when the sandbox env exposes a raw Brave key (#7425)", async () => {
    // The in-sandbox probe returns only the `raw-secret` sentinel — never the
    // key itself — so the guard does not pull the credential across the boundary.
    const d = deps("__nemoclaw_wsenv__:raw-secret");

    const credentialBoundarySafe = await verifyWebSearchInsideSandbox(
      "alpha",
      { name: "openclaw" },
      "brave",
      d,
    );

    expect(d.warn).toHaveBeenCalledWith(
      "  ✗ SECURITY: the Brave Search credential is exposed in the sandbox environment.",
    );
    expect(d.warn).toHaveBeenCalledWith("      nemoclaw onboard --recreate-sandbox");
    expect(credentialBoundarySafe).toBe(false);
    expect(d.runBuffered).toHaveBeenCalledTimes(1);
    expect(d.log).not.toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });

  it("accepts a resolve:env placeholder sentinel without a security alert", async () => {
    const d = deps([
      "__nemoclaw_wsenv__:placeholder",
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "brave" } } },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
            },
          },
        },
      }),
      JSON.stringify({ web: { results: [{ title: "NVIDIA" }] } }) + "\nHTTP_STATUS:200\n",
    ]);

    await verifyWebSearchInsideSandbox("alpha", { name: "openclaw" }, "brave", d);

    expect(d.warn.mock.calls.every((call) => !String(call[0] ?? "").includes("SECURITY"))).toBe(
      true,
    );
    expect(d.log).toHaveBeenCalledWith("  ✓ Brave Search egress verified inside sandbox");
  });
});

type HermesProbeFixture = {
  credential: string;
  dotenv?: Record<string, string | null>;
  status?: number;
  body?: unknown;
  error?: string;
};

type HermesProbeRequest = { url: string; json: Record<string, unknown>; timeout: number };

function executeHermesProbe(command: readonly string[], fixture: HermesProbeFixture) {
  const driver = [
    "import json, sys, types",
    "fixture = json.loads(sys.argv[1])",
    "requests = []",
    "def post(url, **kwargs):",
    "    requests.append(dict(url=url, **kwargs))",
    "    if fixture.get('error'):",
    "        raise RuntimeError(fixture['error'])",
    "    return types.SimpleNamespace(status_code=fixture.get('status', 200), json=lambda: fixture.get('body', {'results': [{}]}))",
    "sys.modules['httpx'] = types.SimpleNamespace(post=post)",
    "sys.modules['dotenv'] = types.SimpleNamespace(dotenv_values=lambda path: fixture.get('dotenv', {}))",
    "exec(compile(sys.argv[2], '<Hermes Tavily probe>', 'exec'), {'__name__': '__main__'})",
    "print('__requests__:' + json.dumps(requests))",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-", JSON.stringify(fixture), command[3]!], {
    input: driver,
    env: { PATH: process.env.PATH ?? "", TAVILY_API_KEY: fixture.credential },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const [stdout, requests] = result.stdout.split("__requests__:");
  return { stdout: stdout ?? "", requests: JSON.parse(requests!) as HermesProbeRequest[] };
}

async function verifyHermesProbe(fixture: HermesProbeFixture) {
  const d = deps([]);
  let execution: ReturnType<typeof executeHermesProbe> | undefined;
  d.runBuffered
    .mockResolvedValueOnce({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__nemoclaw_wsenv__:placeholder",
      stderr: "",
    })
    .mockResolvedValueOnce({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "web:\n  backend: tavily\n",
      stderr: "",
    })
    .mockImplementationOnce(async ({ command }) => {
      execution = executeHermesProbe(command, fixture);
      return {
        outcome: { kind: "completed", exitCode: 0 },
        stdout: execution.stdout,
        stderr: "",
      };
    });
  const safe = await verifyWebSearchInsideSandbox("alpha", { name: "hermes" }, "tavily", d);
  expect(d.runBuffered.mock.calls[2]![0].command.slice(0, 3)).toEqual([
    "/opt/hermes/.venv/bin/python",
    "-I",
    "-c",
  ]);
  expect(execution).toBeDefined();
  return { d, safe, execution: execution! };
}

describe("Hermes Tavily issued credential probe", () => {
  it.each(["openshell:resolve:env:v17_TAVILY_API_KEY", "openshell:resolve:env:v29_TAVILY_API_KEY"])(
    "uses the currently issued reference %s in the native JSON request",
    async (credential) => {
      const { d, safe, execution } = await verifyHermesProbe({
        credential,
        body: { results: [{ title: "upstream-body-must-stay-in-sandbox" }] },
      });

      expect(safe).toBe(true);
      expect(execution.requests).toEqual([
        {
          url: "https://api.tavily.com/search",
          json: { api_key: credential, query: "NVIDIA", max_results: 1 },
          timeout: 20,
        },
      ]);
      expect(d.runBuffered.mock.calls[2]![0].command.join("\n")).not.toContain(credential);
      expect(execution.stdout).not.toContain(credential);
      expect(execution.stdout).not.toContain("upstream-body-must-stay-in-sandbox");
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining("Tavily Search egress verified"));
      expect(d.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { credential: "", safe: true },
    { credential: "openshell:resolve:env:TAVILY_API_KEY", safe: true },
    { credential: "openshell:resolve:env:v17_OTHER_API_KEY", safe: true },
    { credential: "tvly-runtime-test-secret", safe: false },
    {
      credential: "tvly-runtime-test-secret",
      dotenv: { TAVILY_API_KEY: "openshell:resolve:env:v29_TAVILY_API_KEY" },
      safe: false,
    },
  ])("does not send an invalid runtime credential [case %#]", async ({ safe, ...fixture }) => {
    const result = await verifyHermesProbe(fixture);

    expect(result.safe).toBe(safe);
    expect(result.execution.requests).toEqual([]);
    expect(result.execution.stdout).not.toContain("tvly-runtime-test-secret");
    expect(result.d.warn).toHaveBeenCalled();
    expect(result.d.log).not.toHaveBeenCalled();
  });

  it.each([
    { override: "openshell:resolve:env:TAVILY_API_KEY", safe: true },
    { override: "openshell:resolve:env:v17_TAVILY_API_KEY", safe: true },
    { override: "tvly-dotenv-test-secret", safe: false },
  ])(
    "refuses a dotenv override after provider replacement [case %#]",
    async ({ override, safe }) => {
      const result = await verifyHermesProbe({
        credential: "openshell:resolve:env:v29_TAVILY_API_KEY",
        dotenv: { TAVILY_API_KEY: override },
      });

      expect(result.safe).toBe(safe);
      expect(result.execution.requests).toEqual([]);
      expect(result.execution.stdout).not.toContain(override);
      expect(result.d.warn).toHaveBeenCalled();
      expect(result.d.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 401, body: { detail: "rejected" } },
    { status: 200, body: { results: [] } },
  ])("does not claim search success for HTTP $status without results", async (response) => {
    const result = await verifyHermesProbe({
      credential: "openshell:resolve:env:v29_TAVILY_API_KEY",
      ...response,
    });

    expect(result.safe).toBe(true);
    expect(result.execution.requests).toHaveLength(1);
    expect(result.d.warn).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${response.status}`));
    expect(result.d.log).not.toHaveBeenCalled();
  });

  it("redacts request failures while retaining advisory egress behaviour", async () => {
    const result = await verifyHermesProbe({
      credential: "openshell:resolve:env:v29_TAVILY_API_KEY",
      error: "transport-test-secret-must-not-escape",
    });

    expect(result.safe).toBe(true);
    expect(result.execution.requests).toHaveLength(1);
    expect(result.execution.stdout).not.toContain("transport-test-secret-must-not-escape");
    expect(result.d.warn).toHaveBeenCalledWith(expect.stringContaining("request failed"));
    expect(result.d.log).not.toHaveBeenCalled();
  });
});

describe("classifyWebSearchEnvBoundary", () => {
  it("extracts the marked sentinel and tolerates surrounding shell noise", () => {
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:absent")).toBe("absent");
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:placeholder")).toBe("placeholder");
    expect(classifyWebSearchEnvBoundary("__nemoclaw_wsenv__:raw-secret")).toBe("raw-secret");
    // A login banner or MOTD before the marker must not mask a raw-secret result.
    expect(
      classifyWebSearchEnvBoundary("Welcome to the sandbox!\n__nemoclaw_wsenv__:raw-secret"),
    ).toBe("raw-secret");
    // A failed probe (null) or unmarked output cannot certify the boundary.
    expect(classifyWebSearchEnvBoundary(null)).toBe("unknown");
    expect(classifyWebSearchEnvBoundary(undefined)).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("")).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("raw-secret")).toBe("unknown");
    expect(classifyWebSearchEnvBoundary("unexpected output")).toBe("unknown");
  });
});
