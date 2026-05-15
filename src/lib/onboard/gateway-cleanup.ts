// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";

type DestroyGateway = () => boolean;

export function destroyGatewayForReuse(
  destroyGateway: DestroyGateway,
  successMessage: string,
  failureMessage: string,
): GatewayReuseState {
  if (destroyGateway()) {
    console.log(successMessage);
    return "missing";
  }
  console.warn(failureMessage);
  return "stale";
}

export function warnIfGatewayDestroyFails(
  destroyGateway: DestroyGateway,
  successMessage: string,
  failureMessage: string,
): void {
  if (destroyGateway()) {
    console.log(successMessage);
  } else {
    console.warn(failureMessage);
  }
}
