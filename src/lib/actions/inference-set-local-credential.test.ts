// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSanitizedResolvedOpenshellAsync } from "../adapters/openshell/sanitized-capture";
import { SANDBOX_EXEC_STARTED_MARKER } from "../adapters/sandbox/sandbox-exec-output";
import { NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT } from "../inference/native-local/agent-config";
import { readNativeLocalCredentialHandle } from "./inference-set-provider";
import { InferenceSetError } from "./inference-set-error";

vi.mock("../adapters/openshell/sanitized-capture", async (importOriginal) => ({
  ...(await importOriginal()),
  captureSanitizedResolvedOpenshellAsync: vi.fn(),
}));
const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
const issued = (scope: string) => `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
function marked(args: string[], value: string): string {
  const marker = args
    .at(-1)
    ?.match(new RegExp(`${SANDBOX_EXEC_STARTED_MARKER}_[0-9a-f]{32}`, "u"))?.[0];
  expect(marker).toBeDefined();
  return `${marker}\n${value}`;
}
afterEach(() => capture.mockReset());

describe("local supervisor credential reader", () => {
  it.each(["v7", "v8", `s${"a".repeat(64)}`])(
    "accepts only the complete issued %s reference",
    async (scope) => {
      const handle = issued(scope);
      const command = spawnSync("sh", ["-c", NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle },
      });
      expect(command.status).toBe(0);
      expect(command.stdout).toBe(handle);
      expect(command.stderr).toBe("");
      capture.mockImplementationOnce(async (args) => ({
        status: 0,
        output: "",
        stdout: marked(args, command.stdout),
        stderr: "",
      }));
      await expect(readNativeLocalCredentialHandle("hermes", "gateway-a")).resolves.toBe(handle);
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        [
          "sandbox",
          "exec",
          "--name",
          "hermes",
          "-g",
          "gateway-a",
          "--",
          "sh",
          "-c",
          expect.stringContaining(NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT),
        ],
        {
          ignoreError: true,
          includeStderr: true,
          includeStreams: true,
          outputLimitBytes: 512,
          timeout: 30_000,
        },
      );
    },
  );

  it.each([
    "synthetic-raw-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "openshell:resolve:env:v7_OPENAI_API_KEY",
    "openshell:resolve:env:sabc_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    `${issued("v7")}\n`,
    `synthetic-raw-secret\n${issued("v7")}`,
    `${issued("v7")}\nsynthetic-raw-secret`,
  ])("never emits invalid or multiline environment input case %#", (handle) => {
    const command = spawnSync("sh", ["-c", NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle },
    });
    expect(command.status).toBe(2);
    expect(command.stdout).toBe("");
    expect(command.stderr).toBe("");
  });

  it("retries only the explicit pending signal and then reads a fresh exec", async () => {
    const command = spawnSync("sh", ["-c", NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(command.status).toBe(75);
    expect(command.stdout).toBe("");
    expect(command.stderr).toBe("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n");
    capture.mockImplementationOnce(async (args) => ({
      status: command.status,
      output: "",
      stdout: marked(args, ""),
      stderr: command.stderr,
    }));
    capture.mockImplementationOnce(async (args) => ({
      status: 0,
      output: "",
      stdout: marked(args, issued("v8")),
      stderr: "",
    }));
    const sleep = vi.fn(async () => undefined);
    await expect(readNativeLocalCredentialHandle("hermes", "gateway-a", { sleep })).resolves.toBe(
      issued("v8"),
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
  });

  it("bounds pending attachment reads to ten attempts", async () => {
    capture.mockImplementation(async (args) => ({
      status: 75,
      output: "",
      stdout: marked(args, ""),
      stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n",
    }));
    const sleep = vi.fn(async () => undefined);
    await expect(readNativeLocalCredentialHandle("hermes", "gateway-a", { sleep })).rejects.toThrow(
      "provider-bound local inference credential handle",
    );
    expect(capture).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
  });

  it.each([
    { status: 2, value: "synthetic-raw-secret" },
    { status: 0, value: "synthetic-raw-secret" },
    { status: 0, value: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN" },
    { status: 0, value: "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY" },
    { status: 0, value: issued("v8"), signal: "SIGTERM" as const },
    { status: 0, value: issued("v8"), error: new Error("synthetic-secret-diagnostic") },
    { status: 75, value: "" },
  ])(
    "rejects invalid or ambiguous exec case %# without retrying or disclosing output",
    async ({ status, value, ...rest }) => {
      capture.mockImplementationOnce(async (args) => ({
        status,
        output: value,
        stdout: marked(args, value),
        stderr: "synthetic-secret-diagnostic",
        ...rest,
      }));
      const sleep = vi.fn(async () => undefined);
      await expect(
        readNativeLocalCredentialHandle("hermes", "gateway-a", { sleep }),
      ).rejects.toThrow(
        new InferenceSetError(
          "OpenShell did not expose a provider-bound local inference credential handle to sandbox 'hermes'. The inference route was not changed.",
        ),
      );
      expect(capture).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
