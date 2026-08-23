// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class DirectSandboxFallbackUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectSandboxFallbackUnavailableError";
  }
}

export class PinnedSandboxResourceIdentityChangedError extends Error {
  constructor(sandboxName: string) {
    super(
      `OpenShell container identity changed for sandbox '${sandboxName}'; ` +
        "refusing privileged execution against a different container.",
    );
    this.name = "PinnedSandboxResourceIdentityChangedError";
  }
}
