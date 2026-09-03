// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HermesTransitionFailureStage = "publication" | "verification" | "activation";

export function createHermesTransitionFailureController(
  failureStage: HermesTransitionFailureStage,
  failure: Error,
  options: { readonly failOnlyFirstActivation?: boolean } = {},
): {
  readonly afterAssertion: () => void;
  readonly afterPublication: () => void;
  readonly beforeActivation: () => void;
} {
  let assertionCount = 0;
  let activationCount = 0;
  return {
    afterAssertion: () => {
      assertionCount += 1;
      if (failureStage === "verification" && assertionCount === 2) throw failure;
    },
    afterPublication: () => {
      if (failureStage === "publication") throw failure;
    },
    beforeActivation: () => {
      activationCount += 1;
      if (
        failureStage === "activation" &&
        (!options.failOnlyFirstActivation || activationCount === 1)
      ) {
        throw failure;
      }
    },
  };
}
