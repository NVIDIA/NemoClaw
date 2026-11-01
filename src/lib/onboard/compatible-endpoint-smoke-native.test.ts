// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeProviderLifecycle } from "../inference/native-provider";
import { customNativeProvider } from "../inference/native-provider/custom";
import type { NativeProviderAttachment } from "../inference/native-provider/contract";
import type { SandboxEntry } from "../state/registry";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import {
  writeFakeCurl,
  writeSmokeConfig,
} from "./__test-helpers__/compatible-endpoint-smoke-helpers";
import { createCompatibleEndpointSmoke } from "./compatible-endpoint-smoke";

describe("native compatible endpoint smoke", () => {
  it.each(["onboard", "rebuild"] as const)(
    "verifies the recorded native route and restored config during %s (#13195)",
    async (operation) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-compatible-smoke-"));
      const definition = customNativeProvider({
        provider: "compatible-endpoint",
        endpointUrl: "https://custom.example/team/v1",
        api: "openai-completions",
        credentialEnv: "TEAM_KEY",
        allowedIps: ["8.8.8.8"],
      });
      const attachment: NativeProviderAttachment = {
        schemaVersion: 1,
        profileId: definition.profileId,
        providerName: definition.providerName,
        providerId: "native-identity",
        endpointUrl: definition.endpointUrl,
        allowedIps: definition.allowedIps,
        custom: definition.custom,
      };
      const selection: SandboxEntry = {
        name: "native-smoke",
        gatewayName: "test-gateway",
        provider: "compatible-endpoint",
        model: "test-model",
        endpointUrl: definition.custom!.endpointUrl,
        credentialEnv: "TEAM_KEY",
        preferredInferenceApi: "openai-completions",
        nativeHostedProviderAttachment: attachment,
      };
      const verify = vi
        .spyOn(NativeProviderLifecycle.prototype, "verifyNativeProviderAttachment")
        .mockResolvedValue(attachment);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("smoke failed");
      });
      try {
        const configPath = writeSmokeConfig(tmp, "test-model");
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config.models.providers.inference.baseUrl = definition.endpointUrl;
        config.models.providers.inference.api = "openai-completions";
        config.models.providers.inference.apiKey = "openshell:resolve:env:v7_COMPATIBLE_API_KEY";
        fs.writeFileSync(configPath, JSON.stringify(config));
        const { binDir, callFile } = writeFakeCurl(
          tmp,
          `printf '%s' '{"choices":[{"message":{"content":"OK"}}]}'`,
        );
        const executor = {
          runBuffered: vi.fn(async (request: OpenShellSandboxBufferedCommandRequest) => {
            const script = request.command[2]!.replaceAll(
              "/sandbox/.openclaw/openclaw.json",
              configPath,
            );
            const result = spawnSync("sh", ["-c", script], {
              encoding: "utf8",
              env: {
                PATH: `${binDir}:${process.env.PATH}`,
                COMPATIBLE_API_KEY: "openshell:resolve:env:v7_COMPATIBLE_API_KEY",
              },
            });
            return {
              outcome: { kind: "completed" as const, exitCode: result.status ?? 1 },
              stdout: result.stdout,
              stderr: result.stderr,
            };
          }),
        };
        const run = vi.fn();
        const smoke = createCompatibleEndpointSmoke(
          run,
          executor,
          (value) => value,
          () => selection,
        );
        const invoke = () =>
          operation === "rebuild"
            ? smoke.verifyRebuilt({
                ...selection,
                provider: "compatible-endpoint",
                model: "test-model",
                sandboxName: selection.name,
                environment: {},
                gatewayName: selection.gatewayName!,
              })
            : smoke.verify({
                sandboxName: selection.name,
                provider: "compatible-endpoint",
                model: "test-model",
              });
        await invoke();
        expect(verify).toHaveBeenCalledWith(
          expect.objectContaining({
            expected: attachment,
            sandboxName: selection.name,
            target: { kind: "named", gatewayName: "test-gateway" },
          }),
        );
        expect(fs.readFileSync(callFile, "utf8")).toBe("1");
        expect(run).not.toHaveBeenCalled();
        expect(executor.runBuffered.mock.calls[0]![0].target).toEqual({
          kind: "named",
          gatewayName: "test-gateway",
        });

        config.models.providers.inference.baseUrl = "https://inference.local/v1";
        fs.writeFileSync(configPath, JSON.stringify(config));
        await expect(invoke()).rejects.toThrow(/smoke failed|verification failed/);
        expect(fs.readFileSync(callFile, "utf8")).toBe("1");

        selection.endpointUrl = "https://other.example/v1";
        await expect(invoke()).rejects.toThrow("Recorded custom native selection does not match");
        expect(executor.runBuffered).toHaveBeenCalledTimes(2);
      } finally {
        verify.mockRestore();
        exit.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("verifies the Deep Agents Code credential selection before its native request (#13798)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-dcode-smoke-"));
    const definition = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl: "http://10.2.3.4:19379/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["10.2.3.4"],
    });
    const attachment: NativeProviderAttachment = {
      schemaVersion: 1,
      profileId: definition.profileId,
      providerName: definition.providerName,
      providerId: "native-identity",
      endpointUrl: definition.endpointUrl,
      allowedIps: definition.allowedIps,
      custom: definition.custom,
    };
    const selection: SandboxEntry = {
      name: "dcode-smoke",
      gatewayName: "test-gateway",
      provider: "compatible-endpoint",
      model: "test-model",
      endpointUrl: definition.custom!.endpointUrl,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      nativeHostedProviderAttachment: attachment,
    };
    const verify = vi
      .spyOn(NativeProviderLifecycle.prototype, "verifyNativeProviderAttachment")
      .mockResolvedValue(attachment);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("smoke failed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { binDir, callFile } = writeFakeCurl(
        tmp,
        `printf '%s' '{"choices":[{"message":{"content":"OK"}}]}'`,
      );
      let credentialCheck = { exitCode: 0, stdout: "DCODE_INFERENCE_CREDENTIAL_OK\n", stderr: "" };
      const executor = {
        runBuffered: vi.fn(async (request: OpenShellSandboxBufferedCommandRequest) => {
          const result =
            request.command[0] === "/opt/venv/bin/python3"
              ? { ...credentialCheck, status: credentialCheck.exitCode }
              : spawnSync("sh", ["-c", request.command.at(-1)!], {
                  encoding: "utf8",
                  env: {
                    PATH: `${binDir}:${process.env.PATH}`,
                    COMPATIBLE_API_KEY: "openshell:resolve:env:v7_COMPATIBLE_API_KEY",
                  },
                });
          return {
            outcome: { kind: "completed" as const, exitCode: result.status ?? 1 },
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }),
      };
      const run = vi.fn();
      const smoke = createCompatibleEndpointSmoke(
        run,
        executor,
        (value) => value,
        () => selection,
      );
      const invoke = () =>
        smoke.verify({
          sandboxName: selection.name,
          provider: "compatible-endpoint",
          model: "test-model",
          agent: { name: "langchain-deepagents-code" },
        });

      await invoke();
      const [check, request] = executor.runBuffered.mock.calls.map(([call]) => call);
      expect(check!.command.slice(0, 3)).toEqual(["/opt/venv/bin/python3", "-I", "-c"]);
      expect(check!.command[3]).toContain("managed_inference_api_key");
      expect(check!.target).toEqual({ kind: "named", gatewayName: "test-gateway" });
      expect(request!.command[0]).toBe("/usr/local/lib/nemoclaw/dcode-managed-exec");
      expect(fs.readFileSync(callFile, "utf8")).toBe("1");
      expect(run).not.toHaveBeenCalled();

      credentialCheck = {
        exitCode: 1,
        stdout: "",
        stderr: "native local inference requires an issued OpenShell credential reference",
      };
      await expect(invoke()).rejects.toThrow("smoke failed");
      const diagnostics = error.mock.calls.flat().join("\n");
      expect(diagnostics).toContain(
        "LangChain Deep Agents Code cannot use the selected inference route inside the sandbox.",
      );
      expect(diagnostics).toContain("requires an issued OpenShell credential reference");
      expect(fs.readFileSync(callFile, "utf8")).toBe("1");

      executor.runBuffered.mockClear();
      delete selection.nativeHostedProviderAttachment;
      await invoke();
      expect(executor.runBuffered).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
      exit.mockRestore();
      error.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
