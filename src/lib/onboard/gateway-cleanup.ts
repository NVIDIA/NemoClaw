// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";

type DestroyGateway = () => boolean | Promise<boolean>;

export async function destroyGatewayForReuse(
  destroyGateway: DestroyGateway,
  successMessage: string,
  failureMessage: string,
): Promise<GatewayReuseState> {
  if (await destroyGateway()) {
    console.log(successMessage);
    return "missing";
  }
  console.warn(failureMessage);
  return "stale";
}
