// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ExternalComponentContractError } from "./index";
import { prepareExternalComponent } from "./onboarding";

describe("external component onboarding lifecycle", () => {
  it("does not retry an incomplete activation automatically (#11340)", () => {
    expect(() =>
      prepareExternalComponent({
        externalComponentActivation: {
          schemaVersion: 1,
          resultClass: "ambiguous",
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
  });
});
