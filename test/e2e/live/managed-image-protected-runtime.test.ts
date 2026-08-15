// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PROTECTED_MANAGED_IMAGE_AGENTS } from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import { test } from "../fixtures/e2e-test.ts";
import { qualifyProtectedManagedImageRuntime } from "./managed-image-protected-runtime-helpers.ts";

const TIMEOUT_MS = 220 * 60_000;

test("exact all-agent managed images retain GPU, Ollama, NIM, vLLM, rollback, and cleanup (#7744)", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "qualify all managed agents with GPU-backed Ollama",
      "qualify all managed agents with GPU-backed vLLM",
      "qualify all managed agents with GPU-backed NVIDIA NIM",
      "prove all-agent managed bootstrap rollback and exact cleanup",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, secrets }) => {
  await artifacts.target.declare({
    id: "managed-image-protected-runtime",
    boundary:
      "exact PR image digests for every managed agent through Docker/OpenShell GPU, host-local Ollama, NVIDIA NIM, vLLM, transactional rollback, and owned cleanup",
    agents: [...PROTECTED_MANAGED_IMAGE_AGENTS],
    providers: ["ollama", "nim", "vllm"],
    credentialBoundary:
      "The NVIDIA key is staged only to the host-side NGC login and NIM container; managed sandboxes receive only generated local route tokens.",
  });
  await qualifyProtectedManagedImageRuntime(
    { artifacts, cleanup, host, progress },
    secrets.optional("NVIDIA_API_KEY") ?? "",
  );
});
