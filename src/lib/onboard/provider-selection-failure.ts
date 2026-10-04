// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSelectionFailureReason } from "./provider-selection";

export interface ReportProviderSelectionFailureInput {
  reason: ProviderSelectionFailureReason;
  availableProviderKeys: readonly string[];
  isWindowsHostOllama: boolean;
  rejectWindowsHostOllama(providerKey: string, windowsHostSelected: boolean): boolean;
  writeError(message: string): void;
}

export function reportProviderSelectionFailure(input: ReportProviderSelectionFailureInput): void {
  switch (input.reason.kind) {
    case "wsl-recorded-ollama-windows-host":
      input.writeError(
        `  Recorded provider '${input.reason.recordedProvider}' (WSL Ollama) is not available in this environment.`,
      );
      input.writeError(
        "  Hint: Windows-host Ollama is reachable here; re-run with NEMOCLAW_PROVIDER=ollama to use it explicitly.",
      );
      break;
    case "recorded-provider-unavailable":
      input.writeError(
        `  Recorded provider '${input.reason.recordedProvider}' is not available in this environment.`,
      );
      input.writeError(
        "  Set NEMOCLAW_PROVIDER explicitly, or restore the missing local-inference dependency.",
      );
      if (input.reason.windowsHostKey) {
        input.writeError(
          `  Hint: Windows-host Ollama is available here — re-run with NEMOCLAW_PROVIDER=${input.reason.windowsHostKey} to use it.`,
        );
      }
      break;
    case "unsupported-windows-host-ollama":
      input.rejectWindowsHostOllama(input.reason.providerKey, input.isWindowsHostOllama);
      break;
    case "hermes-provider-unavailable":
      input.writeError("  Hermes Provider is only available when onboarding Hermes Agent.");
      input.writeError("  Re-run with `nemohermes onboard` or `nemoclaw onboard --agent hermes`.");
      break;
    case "requested-provider-unavailable":
      input.writeError(
        `  Requested provider '${input.reason.providerKey}' is not available in this environment.`,
      );
      if (input.reason.providerKey === "vllm") {
        input.writeError(
          "  NEMOCLAW_PROVIDER=vllm requires an already-running local vLLM server, but none was detected.",
        );
        input.writeError(
          input.availableProviderKeys.includes("install-vllm")
            ? "  Re-run with NEMOCLAW_PROVIDER=install-vllm to install and start the managed vLLM runtime."
            : "  Start a compatible local vLLM server and retry, or choose another provider.",
        );
        break;
      }
      input.writeError(
        "  Re-run without NEMOCLAW_PROVIDER to choose an available provider, or install and start the requested provider before retrying.",
      );
      break;
  }
}
