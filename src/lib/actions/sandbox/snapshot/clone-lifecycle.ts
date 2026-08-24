// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  captureCreatedSandboxLifecycleRegistration,
  fingerprintSandboxLiveIdentity,
  revalidateCreatedSandboxLifecycleRegistration,
  type SandboxRecreateObservation,
} from "../../../onboard/sandbox-recreate-transaction";

export { fingerprintSandboxLiveIdentity };

export function createSnapshotCloneLifecycle(
  sandboxName: string,
  gatewayName: string,
  observe: (sandboxName: string, gatewayName: string) => SandboxRecreateObservation,
) {
  const lifecycleGeneration = randomUUID();
  const target = { sandboxName, gatewayName };
  return {
    capture: () =>
      captureCreatedSandboxLifecycleRegistration(
        target,
        lifecycleGeneration,
        { lifecycleGeneration },
        observe,
      ),
    revalidate: (registration: ReturnType<typeof captureCreatedSandboxLifecycleRegistration>) =>
      revalidateCreatedSandboxLifecycleRegistration(target, registration, observe),
  };
}
