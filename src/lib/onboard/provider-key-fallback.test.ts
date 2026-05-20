// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveProviderKeyFallback } from "../../../dist/lib/onboard/provider-key-fallback";

const option = (key: string) => ({ key, label: key });

describe("resolveProviderKeyFallback", () => {
  it("maps generic install action keys to already-running provider options", () => {
    const options = [option("ollama"), option("vllm")];

    assert.equal(
      resolveProviderKeyFallback(options, "install-ollama", { isWindowsHostOllama: false })?.key,
      "ollama",
    );
    assert.equal(
      resolveProviderKeyFallback(options, "install-vllm", { isWindowsHostOllama: false })?.key,
      "vllm",
    );
  });

  it("prefers Windows-host start when install-windows-ollama is requested after install already exists", () => {
    const options = [option("ollama"), option("start-windows-ollama")];

    assert.equal(
      resolveProviderKeyFallback(options, "install-windows-ollama", {
        isWindowsHostOllama: false,
      })?.key,
      "start-windows-ollama",
    );
  });

  it("allows Windows-host install/start requests to collapse to ollama only for Windows-host Ollama", () => {
    const options = [option("ollama")];

    assert.equal(
      resolveProviderKeyFallback(options, "install-windows-ollama", {
        isWindowsHostOllama: true,
      })?.key,
      "ollama",
    );
    assert.equal(
      resolveProviderKeyFallback(options, "start-windows-ollama", {
        isWindowsHostOllama: true,
      })?.key,
      "ollama",
    );
  });

  it("does not satisfy Windows-host requests with WSL or Linux local Ollama", () => {
    const options = [option("ollama")];

    assert.equal(
      resolveProviderKeyFallback(options, "install-windows-ollama", {
        isWindowsHostOllama: false,
      }),
      undefined,
    );
    assert.equal(
      resolveProviderKeyFallback(options, "start-windows-ollama", {
        isWindowsHostOllama: false,
      }),
      undefined,
    );
  });
});
