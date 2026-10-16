// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type {
  FakeOpenAiCompatibleRequest,
  FakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";
import { expectNativeLocalHermesTurn } from "../live/hermes-inference-switch-helpers.ts";

const authenticated = {
  auth: "ok",
  authorizationSent: true,
  bodyBytes: 100,
  method: "POST",
  model: "selected-model",
  path: "/v1/chat/completions",
} satisfies FakeOpenAiCompatibleRequest;

function evidenceFixture(
  newRequests: FakeOpenAiCompatibleRequest[],
  responseModel = "selected-model",
) {
  const requests = vi
    .fn()
    .mockReturnValueOnce([authenticated])
    .mockReturnValue([authenticated, ...newRequests]);
  const execShell = vi.fn().mockResolvedValue({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      model: responseModel,
      choices: [{ message: { content: "PONG" } }],
    }),
  });
  const onEvidence = vi.fn();
  return {
    execShell,
    onEvidence,
    options: {
      sandbox: { execShell } as unknown as SandboxClient,
      endpoint: { requests } as unknown as FakeOpenAiCompatibleServer,
      model: "selected-model",
      artifactName: "native-local-turn",
      redactionValues: [],
      onEvidence,
    },
  };
}

describe("Hermes native local live evidence", () => {
  it("requires a new authenticated upstream request and matching Hermes response", async () => {
    const fixture = evidenceFixture([authenticated]);
    await expect(expectNativeLocalHermesTurn(fixture.options)).resolves.toBeUndefined();
    expect(fixture.execShell).toHaveBeenCalledOnce();
    expect(fixture.onEvidence).toHaveBeenCalled();
  });

  it.each([
    { name: "stale request", requests: [] },
    { name: "unauthenticated request", requests: [{ ...authenticated, auth: "missing" }] },
    { name: "wrong upstream model", requests: [{ ...authenticated, model: "previous-model" }] },
    { name: "inventory only", requests: [{ ...authenticated, method: "GET", path: "/v1/models" }] },
  ])("rejects $name despite a successful Hermes response", async ({ requests }) => {
    const fixture = evidenceFixture(requests);
    await expect(expectNativeLocalHermesTurn(fixture.options)).rejects.toThrow();
    expect(fixture.execShell).toHaveBeenCalledOnce();
  });

  it("rejects a stale Hermes response even when the selected upstream receives a request", async () => {
    const fixture = evidenceFixture([authenticated], "previous-model");
    await expect(expectNativeLocalHermesTurn(fixture.options)).rejects.toThrow();
    expect(fixture.execShell).toHaveBeenCalledOnce();
  });
});
