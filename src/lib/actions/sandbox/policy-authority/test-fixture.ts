// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Configure one deterministic inspection refusal without test-local branches. */
export function refusePolicyAuthorityInspectionOnCall<TArgs extends unknown[], TInspection>(
  inspectionMock: {
    mockImplementation: (implementation: (...args: TArgs) => TInspection) => unknown;
    mockImplementationOnce: (implementation: (...args: TArgs) => TInspection) => unknown;
  },
  callNumber: number,
  inspection: TInspection,
  message: string,
): void {
  for (let index = 1; index < callNumber; index += 1) {
    inspectionMock.mockImplementationOnce(() => inspection);
  }
  inspectionMock.mockImplementationOnce(() => {
    throw new Error(message);
  });
  inspectionMock.mockImplementation(() => inspection);
}
