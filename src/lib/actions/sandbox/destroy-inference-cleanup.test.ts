// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { stopSandboxInferenceResources } from "./destroy-execution";

afterEach(() => {
  vi.restoreAllMocks();
  resetDestroyModuleCache();
});

it.each([undefined, "nemoclaw-nim-alpha"])(
  "leaves Docker inference containers untouched for Podman with recorded NIM name %s",
  (nimContainer) => {
    const harness = createDestroyHarness();

    stopSandboxInferenceResources("alpha", {
      name: "alpha",
      openshellDriver: "podman",
      nimContainer,
    });

    expect(harness.stopNimSpy).not.toHaveBeenCalled();
    expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
  },
);

it.each([undefined, "docker", "vm"])(
  "retains convention-based Docker inference cleanup for driver %s",
  (openshellDriver) => {
    const harness = createDestroyHarness();
    stopSandboxInferenceResources("alpha", { name: "alpha", openshellDriver });
    expect(harness.stopNimSpy).toHaveBeenCalledExactlyOnceWith("alpha", { silent: true });
  },
);
