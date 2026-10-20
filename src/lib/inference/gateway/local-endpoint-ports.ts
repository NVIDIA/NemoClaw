// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { isProtectedNemoClawHostPort } from "../../core/protected-host-ports";
import {
  listRecordedGatewayPorts,
  listRecordedModelRouterPorts,
  resolveHome,
} from "../../state/gateway-registry";

/** Apply host control-plane reservations at each local inference mutation boundary. */
export function isProtectedLocalInferencePort(
  port: number,
  options: { ownedProxy?: boolean; allowLegacyProxyDefault?: boolean } = {},
): boolean {
  const home = resolveHome();
  return (
    (!(options.ownedProxy === true && port === OLLAMA_PROXY_PORT) &&
      isProtectedNemoClawHostPort(port, listRecordedModelRouterPorts(home), options)) ||
    listRecordedGatewayPorts(home).includes(port)
  );
}
