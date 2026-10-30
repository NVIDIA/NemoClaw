// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  capturePublicFetchFailureProbe,
  runOpenClawAgentAssertion,
} from "../live/openclaw-agent-assertion.ts";

import { reduceOpenClawToolEvidence } from "../live/common-egress-agent-helpers.ts";

const PUBLIC_FETCH_EXPECTATION = {
  url: "https://www.wikidata.org/w/api.php",
  content: "United States",
};
function publicFetchPayload(overrides = {}) {
  return {
    status: 200,
    url: PUBLIC_FETCH_EXPECTATION.url,
    finalUrl: PUBLIC_FETCH_EXPECTATION.url,
    text: "United States",
    ...overrides,
  };
}
function publicFetchSessionJsonLines(options: { isError?: boolean; payload?: object } = {}) {
  return [
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call1",
            name: "web_fetch",
            arguments: { url: PUBLIC_FETCH_EXPECTATION.url, maxChars: 8000 },
          },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "web_fetch",
        isError: options.isError,
        content: [{ type: "text", text: JSON.stringify(options.payload ?? publicFetchPayload()) }],
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}
const SECRET_SENTINEL = "nvidia-api-key-must-not-remain";

describe("OpenClaw agent assertion", () => {
  it("keeps OpenShell SSH configuration outside artifacts and removes its temporary file", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-assertion-"));
    const artifactRoot = join(fixtureRoot, "artifacts");
    const temporaryRoot = join(fixtureRoot, "tmp");
    mkdirSync(temporaryRoot);
    vi.stubEnv("TMPDIR", temporaryRoot);
    const sshConfigSentinel = `ProxyCommand connect -H bearer=${SECRET_SENTINEL}`;
    const shellResult = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: sshConfigSentinel,
      timedOut: false,
    };
    const sandbox = {
      exec: vi.fn(),
      openshell: vi.fn().mockResolvedValue(shellResult),
    } as unknown as SandboxClient;
    const host = {
      command: vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const configPath = args[1];
        expect(readFileSync(configPath!, "utf8")).toBe(sshConfigSentinel);
        expect(statSync(configPath!).mode & 0o777).toBe(0o600);
        return {
          ...shellResult,
          exitCode: 1,
          stderr: `credential=${SECRET_SENTINEL}`,
          stdout: "wrong reply",
        };
      }),
    } as unknown as HostCliClient;

    try {
      await expect(
        runOpenClawAgentAssertion(host, sandbox, new ArtifactSink(artifactRoot), {
          apiKey: SECRET_SENTINEL,
          expected: "PERSONAL_PUBLIC_FETCH_OK",
          label: "personal-public-fetch",
          persistCommandArtifacts: false,
          prompt: "fetch the fixed public reference",
          redactOutputInFailure: true,
          sandboxName: "personal-sandbox",
        }),
      ).rejects.toThrow(/agent output omitted; exit=1/u);

      expect(sandbox.openshell).toHaveBeenCalledWith(
        ["sandbox", "ssh-config", "personal-sandbox"],
        expect.objectContaining({ persistArtifacts: false }),
      );
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(existsSync(join(artifactRoot, "ssh"))).toBe(false);
      const persistedActions = readdirSync(join(artifactRoot, "actions"))
        .map((name) => readFileSync(join(artifactRoot, "actions", name), "utf8"))
        .join("\n");
      expect(persistedActions).not.toContain(SECRET_SENTINEL);
      expect(sandbox.exec).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("collects failed-turn records and a separate HTTP probe before preserving the reply failure", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-fetch-diagnostic-"));
    const result = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
    };
    const reduced = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        isError: true,
        payload: {
          status: "error",
          tool: "web_fetch",
          error: `Web fetch failed (503): ${SECRET_SENTINEL}`,
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const exec = vi.fn().mockImplementation(async (_sandbox, args) => ({
      ...result,
      stdout: args[0] === "node" ? "__NEMOCLAW_TOOL_EVIDENCE__=" + JSON.stringify(reduced) : "503",
    }));
    const sandbox = {
      exec,
      openshell: vi.fn().mockResolvedValue({ ...result, stdout: "Host openshell-test-sandbox" }),
    } as unknown as SandboxClient;
    const command = vi.fn().mockResolvedValue({ ...result, stdout: "wrong reply" });
    try {
      await expect(
        runOpenClawAgentAssertion(
          { command } as unknown as HostCliClient,
          sandbox,
          new ArtifactSink(fixtureRoot),
          {
            apiKey: SECRET_SENTINEL,
            expected: "REFERENCE_AGENT_OK",
            label: "c2",
            prompt: "fetch",
            sandboxName: "test-sandbox",
            publicFetchExpectation: PUBLIC_FETCH_EXPECTATION,
            persistCommandArtifacts: false,
            redactOutputInFailure: true,
          },
        ),
      ).rejects.toThrow("expected REFERENCE_AGENT_OK");
      expect(command).toHaveBeenCalledOnce();
      expect(exec).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(readFileSync(join(fixtureRoot, "actions/c2-attempt-1-reduced.json"), "utf8")),
      ).toMatchObject({
        webFetchDiagnostics: [{ httpStatus: 503, toolError: true, paired: true }],
      });
      expect(
        JSON.parse(readFileSync(join(fixtureRoot, "actions/c2-separate-http-probe.json"), "utf8")),
      ).toMatchObject({ httpStatus: 503, source: "separate-sandbox-curl-request" });
      const files = readdirSync(join(fixtureRoot, "actions"))
        .map((file) => readFileSync(join(fixtureRoot, "actions", file), "utf8"))
        .join("\n");
      expect(files).not.toContain(SECRET_SENTINEL);
      expect(files).not.toContain("wrong reply");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["agent-failure", 0, "valid"],
    ["reduced", 0, "valid"],
    ["reducer-failure", 1, ""],
    ["reducer-failure", 0, "invalid"],
  ])(
    "preserves recovery when %s persistence fails (exit %s, output %s)",
    async (suffix, exitCode, output) => {
      const result = {
        artifacts: { result: "", stderr: "", stdout: "" },
        command: [],
        durationMs: 1,
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "",
        timedOut: false,
      };
      const reduced = reduceOpenClawToolEvidence(
        publicFetchSessionJsonLines(),
        "",
        PUBLIC_FETCH_EXPECTATION,
      );
      const writeJson = vi
        .fn()
        .mockImplementation((path: string) =>
          path.endsWith(`-${suffix}.json`)
            ? Promise.reject(new Error(SECRET_SENTINEL))
            : Promise.resolve(),
        );
      const sandbox = {
        openshell: vi.fn().mockResolvedValue({ ...result, stdout: "Host openshell-test-sandbox" }),
        exec: vi.fn().mockResolvedValue({
          ...result,
          exitCode,
          stdout:
            output === "valid" ? "__NEMOCLAW_TOOL_EVIDENCE__=" + JSON.stringify(reduced) : output,
        }),
      } as unknown as SandboxClient;
      const command = vi
        .fn()
        .mockResolvedValueOnce({ ...result, exitCode: 1, stderr: "scope upgrade pending approval" })
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({
          ...result,
          stdout: JSON.stringify({
            status: "ok",
            result: { payloads: [{ text: "REFERENCE_AGENT_OK" }], meta: {} },
          }),
        });
      vi.useFakeTimers();
      try {
        const assertion = runOpenClawAgentAssertion(
          { command } as unknown as HostCliClient,
          sandbox,
          { writeJson } as unknown as ArtifactSink,
          {
            apiKey: SECRET_SENTINEL,
            expected: "REFERENCE_AGENT_OK",
            label: "c2",
            prompt: "fetch",
            sandboxName: "test-sandbox",
            publicFetchExpectation: PUBLIC_FETCH_EXPECTATION,
            persistCommandArtifacts: false,
            redactOutputInFailure: true,
          },
        );
        await Promise.all([
          expect(assertion).resolves.toEqual({ reply: "REFERENCE_AGENT_OK" }),
          vi.runAllTimersAsync(),
        ]);
        expect(command).toHaveBeenCalledTimes(3);
        expect(command.mock.calls[1]?.[1]).toEqual(
          expect.arrayContaining(["test-sandbox", "recover"]),
        );
        expect(writeJson).toHaveBeenCalledWith(
          `actions/c2-attempt-1-${suffix}.json`,
          expect.any(Object),
        );
        expect(writeJson).toHaveBeenCalledWith(
          "actions/c2-agent-retry-evidence.json",
          expect.objectContaining({
            outcome: "passed-after-retry",
            attempts: [
              {
                attempt: 1,
                outcome: "failed",
                failureClass: "transient-external",
                reconciled: true,
                retryScheduled: true,
              },
              { attempt: 2, outcome: "passed", retryScheduled: false },
            ],
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects success when required tool evidence cannot be persisted", async () => {
    const result = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
    };
    const reduced = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines(),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const writeJson = vi
      .fn()
      .mockImplementation((path: string) =>
        path.endsWith("-reduced.json")
          ? Promise.reject(new Error(SECRET_SENTINEL))
          : Promise.resolve(),
      );
    const sandbox = {
      openshell: vi.fn().mockResolvedValue({ ...result, stdout: "Host openshell-test-sandbox" }),
      exec: vi.fn().mockResolvedValue({
        ...result,
        stdout: "__NEMOCLAW_TOOL_EVIDENCE__=" + JSON.stringify(reduced),
      }),
    } as unknown as SandboxClient;
    const command = vi.fn().mockResolvedValue({
      ...result,
      stdout: JSON.stringify({
        status: "ok",
        result: { payloads: [{ text: "REFERENCE_AGENT_OK" }], meta: {} },
      }),
    });
    const validator = vi.fn().mockReturnValue(true);
    await expect(
      runOpenClawAgentAssertion(
        { command } as unknown as HostCliClient,
        sandbox,
        { writeJson } as unknown as ArtifactSink,
        {
          apiKey: SECRET_SENTINEL,
          expected: "REFERENCE_AGENT_OK",
          label: "c2",
          prompt: "fetch",
          sandboxName: "test-sandbox",
          publicFetchExpectation: PUBLIC_FETCH_EXPECTATION,
          toolEvidenceValidator: validator,
        },
      ),
    ).rejects.toThrow("failed-no-retry");
    expect(command).toHaveBeenCalledOnce();
    expect(validator).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(
      "actions/c2-agent-retry-evidence.json",
      expect.objectContaining({ outcome: "failed-no-retry" }),
    );
  });

  it("reports when the temporary OpenShell SSH configuration cannot be removed", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-cleanup-"));
    const temporaryRoot = join(fixtureRoot, "tmp");
    mkdirSync(temporaryRoot);
    vi.stubEnv("TMPDIR", temporaryRoot);
    const shellResult = {
      artifacts: { result: "", stderr: "", stdout: "" },
      command: [],
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "Host openshell-personal-sandbox",
      timedOut: false,
    };
    const sandbox = {
      exec: vi.fn(),
      openshell: vi.fn().mockResolvedValue(shellResult),
    } as unknown as SandboxClient;
    const host = {
      command: vi.fn().mockResolvedValue({
        ...shellResult,
        exitCode: 1,
        stdout: "wrong reply",
      }),
    } as unknown as HostCliClient;
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    try {
      await expect(
        runOpenClawAgentAssertion(host, sandbox, new ArtifactSink(join(fixtureRoot, "artifacts")), {
          apiKey: SECRET_SENTINEL,
          expected: "PERSONAL_PUBLIC_FETCH_OK",
          label: "personal-public-fetch",
          persistCommandArtifacts: false,
          prompt: "fetch the fixed public reference",
          redactOutputInFailure: true,
          sandboxName: "personal-sandbox",
        }),
      ).rejects.toThrow(/failed to remove temporary OpenShell SSH configuration/u);

      expect(readdirSync(temporaryRoot)).toHaveLength(1);
    } finally {
      remove.mockRestore();
      vi.unstubAllEnvs();
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

describe("public fetch failure probe", () => {
  it.each([503, 200])(
    "records a separate HTTP %s without retaining response content",
    async (httpStatus) => {
      const writeJson = vi.fn();
      const exec = vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: String(httpStatus),
        stderr: SECRET_SENTINEL,
      });
      await capturePublicFetchFailureProbe(
        { exec } as unknown as SandboxClient,
        { writeJson } as unknown as ArtifactSink,
        "test-sandbox",
        "c2",
        "https://www.wikidata.org/w/api.php?test=private",
      );
      expect(exec).toHaveBeenCalledWith(
        "test-sandbox",
        expect.arrayContaining(["--proto", "=https", "--output", "/dev/null", "--max-time", "15"]),
        expect.objectContaining({ persistArtifacts: false, timeoutMs: 20_000 }),
      );
      expect(writeJson).toHaveBeenCalledWith(
        "actions/c2-separate-http-probe.json",
        expect.objectContaining({ source: "separate-sandbox-curl-request", httpStatus }),
      );
      expect(JSON.stringify(writeJson.mock.calls)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(writeJson.mock.calls)).not.toContain("?test=private");
    },
  );

  it.each([false, true])(
    "preserves the assertion when probe persistence fails (transport failure: %s)",
    async (transportFailure) => {
      const writeJson = vi.fn().mockRejectedValue(new Error(SECRET_SENTINEL));
      const exec = transportFailure
        ? vi.fn().mockRejectedValue(new Error(SECRET_SENTINEL))
        : vi.fn().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "503" });
      await expect(
        capturePublicFetchFailureProbe(
          { exec } as unknown as SandboxClient,
          { writeJson } as unknown as ArtifactSink,
          "test-sandbox",
          "c2",
          "https://www.wikidata.org/",
        ),
      ).resolves.toBeUndefined();
      expect(exec).toHaveBeenCalledOnce();
      expect(JSON.stringify(writeJson.mock.calls)).not.toContain(SECRET_SENTINEL);
    },
  );

  it("records unavailable diagnostics without throwing the transport's sensitive message", async () => {
    const writeJson = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error(SECRET_SENTINEL));
    await capturePublicFetchFailureProbe(
      { exec } as unknown as SandboxClient,
      { writeJson } as unknown as ArtifactSink,
      "test-sandbox",
      "c2",
      "https://www.wikidata.org/",
    );
    expect(writeJson).toHaveBeenCalledWith(
      "actions/c2-separate-http-probe.json",
      expect.objectContaining({ unavailable: true }),
    );
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain(SECRET_SENTINEL);
  });
});
