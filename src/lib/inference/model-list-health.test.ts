// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), runCapture: vi.fn() }));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerContainerInspectFormat: mocks.inspect,
}));
vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  runCapture: mocks.runCapture,
}));

import { isLocalProviderProbeOutputHealthy } from "./local";
import {
  buildModelListProbeCommand,
  isOpenAiModelListBody,
  isOpenAiModelListResponse,
} from "./serving/model-inventory";
import { nimStatusByName, waitForNimHealth } from "./nim";
import * as wait from "../core/wait";

const MODELS_ENDPOINT = "http://127.0.0.1:8000/v1/models";

describe("model list health checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.inspect.mockReset();
    mocks.runCapture.mockReset();
  });

  it.each([
    ["an HTML page", "<html>dev server</html>"],
    ["a JSON error", '{"error":"nope"}'],
    ["a top-level array", "[]"],
    ["JSON null", "null"],
    ["a non-array data field", '{"data":{}}'],
  ])("rejects %s as a vLLM models response", (_name, body) => {
    expect(isOpenAiModelListBody(body)).toBe(false);
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, `${body}\n200`)).toBe(false);
  });

  it("accepts an OpenAI-style model list with status 200, even when empty", () => {
    expect(isOpenAiModelListBody('{"data":[]}')).toBe(true);
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, '{"data":[{"id":"m"}]}\n200')).toBe(
      true,
    );
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, '{"data":[]}\n200\n')).toBe(true);
  });

  it.each([
    ["a redirect", "302"],
    ["a client error", "404"],
    ["a server error", "503"],
    ["an accepted status", "202"],
  ])("rejects a valid model list answered with %s", (_name, status) => {
    const output = `{"data":[]}\n${status}`;
    expect(isOpenAiModelListResponse(output)).toBe(false);
    expect(isLocalProviderProbeOutputHealthy(MODELS_ENDPOINT, output)).toBe(false);
  });

  it("rejects model list output without a status line", () => {
    expect(isOpenAiModelListResponse('{"data":[]}')).toBe(false);
    expect(isOpenAiModelListResponse("\n200")).toBe(false);
  });

  it("asks curl to print the HTTP status after the body, keeping the URL last", () => {
    const command = buildModelListProbeCommand(["--max-time", "5"], MODELS_ENDPOINT);
    expect(command.slice(0, 2)).toEqual(["curl", "-sf"]);
    expect(command.slice(-3)).toEqual(["--write-out", "\\n%{http_code}", MODELS_ENDPOINT]);
  });

  it("keeps Ollama tag probes and status-code probes unchanged", () => {
    expect(isLocalProviderProbeOutputHealthy("http://127.0.0.1:11434/api/tags", "401")).toBe(true);
    expect(isLocalProviderProbeOutputHealthy("http://10.40.0.1:8000/health", "200")).toBe(true);
  });

  it("does not report NIM healthy for a non-model-list page", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The memory warning ends the wait after one probe, so false here comes
    // from rejecting the body, not from the container state.
    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        runCaptureImpl: () => "<html>dev server</html>\n200",
        inspectContainerState: () => "running",
        readContainerLogs: () =>
          "WARNING: Estimated memory (2 GB) exceeds usable GPU memory (1 GB).",
      }),
    ).toBe(false);
  });

  it("does not report NIM healthy for a model list answered with a redirect", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        runCaptureImpl: () => '{"data":[]}\n302',
        inspectContainerState: () => "running",
        readContainerLogs: () =>
          "WARNING: Estimated memory (2 GB) exceeds usable GPU memory (1 GB).",
      }),
    ).toBe(false);
  });

  it("checks the container before reporting NIM healthy", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inspectContainerState = vi.fn(() => "exited");

    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        runCaptureImpl: () => '{"data":[]}\n200',
        inspectContainerState,
        readContainerLogs: () => "",
      }),
    ).toBe(false);
    expect(inspectContainerState).toHaveBeenCalledTimes(1);
  });

  it("rejects NIM health when the recorded container cannot be inspected", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sleep = vi.spyOn(wait, "sleepSeconds").mockImplementation(() => {});
    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        runCaptureImpl: () => '{"data":[]}\n200',
        inspectContainerState: () => "",
      }),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot inspect NIM container nemoclaw-nim-test"),
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["created", "restarting"])(
    "waits for a %s NIM container to run before reporting healthy",
    (state) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const sleep = vi.spyOn(wait, "sleepSeconds").mockImplementation((seconds) => {
        now += seconds * 1000;
      });
      const inspect = vi.fn().mockReturnValueOnce(state).mockReturnValue("running");
      expect(
        waitForNimHealth(9000, 60, {
          container: "nemoclaw-nim-test",
          runCaptureImpl: () => '{"data":[]}\n200',
          inspectContainerState: inspect,
          readContainerLogs: () => "",
        }),
      ).toBe(true);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(5);
    },
  );

  it("reports NIM healthy when its container is running and the port returns a model list", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      waitForNimHealth(9000, 60, {
        container: "nemoclaw-nim-test",
        inspectContainerState: () => "running",
        runCaptureImpl: () => '{"data":[]}\n200',
      }),
    ).toBe(true);
  });

  it.each([
    ["an HTML page", "<html>dev server</html>\n200", false],
    ["a JSON error", '{"error":"nope"}\n200', false],
    ["a model list", '{"data":[]}\n200', true],
    ["a model list answered with a redirect", '{"data":[]}\n302', false],
  ])(
    "reports a running NIM container healthy only for a model list: %s",
    (_name, body, healthy) => {
      mocks.inspect.mockReturnValue("running");
      mocks.runCapture.mockReturnValue(body);

      expect(nimStatusByName("nemoclaw-nim-test", 9000)).toMatchObject({ running: true, healthy });
    },
  );
});
