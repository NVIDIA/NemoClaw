// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerDriverGatewayStart } from "./docker-driver-start";
import type { GatewayRecoveryOrchestration } from "./recovery";
import type { GatewayRegistration } from "./registration";
import type { GatewayStart } from "./start";

export { createDockerDriverGatewayStart } from "./docker-driver-start";
export { createGatewayRecoveryOrchestration } from "./recovery";
export { createGatewayRegistration } from "./registration";
export { createGatewayStart } from "./start";

export type GatewayLifecycleApplication = GatewayRegistration &
  DockerDriverGatewayStart &
  GatewayStart &
  GatewayRecoveryOrchestration;

export interface GatewayLifecycleApplicationDeps {
  dockerDriverStart: DockerDriverGatewayStart;
  recovery: GatewayRecoveryOrchestration;
  registration: GatewayRegistration;
  start: GatewayStart;
}

export function createGatewayLifecycleApplication({
  dockerDriverStart,
  recovery,
  registration,
  start,
}: GatewayLifecycleApplicationDeps): GatewayLifecycleApplication {
  return { ...registration, ...dockerDriverStart, ...start, ...recovery };
}
