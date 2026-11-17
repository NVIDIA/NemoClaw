// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createCliOpenShellProviderAdapter } from "./provider-adapter-cli";
import { selectedOpenShellGateway } from "./sandbox-observer";

const PROVIDER = "tg-mode-openclaw-telegram-bridge";

// OpenShell wraps this precondition failure across lines and splits the
// provider name at a hyphen (#13644).
function bindingOnlyDiagnostic(provider: string, marker: string, pipe: string): string {
  return [
    `Error:   ${marker} code: 'The system is not in a state required for the operation's`,
    `  ${pipe} execution', message: "credential_binding references provider '${provider.slice(0, 8)}`,
    `  ${pipe} ${provider.slice(8)}', but that provider is not attached to the`,
    `  ${pipe} sandbox"`,
  ].join("\n");
}

function detachWith(stderr: string) {
  const adapter = createCliOpenShellProviderAdapter({
    run: () => ({ status: 1, stdout: "", stderr }),
  });
  return adapter.detachProvider({
    target: selectedOpenShellGateway(),
    providerName: PROVIDER,
    sandboxName: "tg-mode-openclaw",
  });
}

describe("CLI OpenShell provider detach of a binding-only provider (#13644)", () => {
  it.each([
    ["x", "|"],
    ["×", "│"],
  ])("treats the provider as already detached (marker %s)", async (marker, pipe) => {
    await expect(detachWith(bindingOnlyDiagnostic(PROVIDER, marker, pipe))).resolves.toEqual({
      ok: true,
      value: { changed: false },
    });
  });

  it("keeps the diagnostic for another provider as a detach failure", async () => {
    const result = await detachWith(
      bindingOnlyDiagnostic("tg-mode-hermes-telegram-bridge", "×", "│"),
    );

    expect(result.ok).toBe(false);
  });

  it("keeps the same message with a different status code as a detach failure", async () => {
    const result = await detachWith(
      `Error:   × code: 'The caller does not have permission to execute the specified operation', message: "credential_binding references provider '${PROVIDER}', but that provider is not attached to the sandbox"`,
    );

    expect(result.ok).toBe(false);
  });
});
