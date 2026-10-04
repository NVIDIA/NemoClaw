// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function logMissingNvidiaApiKeyHelp(helpUrl: string | null | undefined): void {
  console.error(
    "  NVIDIA_INFERENCE_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required for NVIDIA Endpoints in non-interactive mode.",
  );
  console.error("  Set with:");
  console.error("  export NVIDIA_INFERENCE_API_KEY=nvapi-...");
  if (helpUrl) {
    console.error(`  Get a key from ${helpUrl}`);
  }
}
