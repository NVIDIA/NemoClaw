// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS } from "../../../tools/e2e/onboard-timeout-contract.mts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";

export interface RuntimeIdentityE2EScenario {
  readonly testId: "TC-INF-12" | "TC-INF-13";
  readonly providerType: string;
  readonly credentialKey: string;
  readonly clientIdEnvironmentName: string;
  readonly refreshTokenEnvironmentName: string;
  readonly clientSecretEnvironmentName: string;
  readonly tokenPath: string;
  readonly resourcePath: string;
  readonly reviewedResourcePath: string;
  readonly deniedMethod: "GET" | "POST";
  readonly deniedPath: string;
  readonly targetId: string;
}

export const RUNTIME_IDENTITY_E2E_SCENARIOS = [
  [
    "12",
    "",
    {
      testId: "TC-INF-12",
      providerType: "oauth2-runtime-conformance-v1",
      credentialKey: "E2E_ACCESS_TOKEN",
      clientIdEnvironmentName: "E2E_CLIENT_ID",
      refreshTokenEnvironmentName: "E2E_REFRESH_TOKEN",
      clientSecretEnvironmentName: "E2E_CLIENT_SECRET",
      tokenPath: "/oauth/token",
      resourcePath: "/resource",
      reviewedResourcePath: "/**",
      deniedMethod: "POST",
      deniedPath: "/resource",
      targetId: "runtime-identity-reference-real-oauth-lifecycle",
    },
  ],
  [
    "13",
    "Entra Graph ",
    {
      testId: "TC-INF-13",
      providerType: "entra-runtime-v1",
      credentialKey: "ENTRA_ACCESS_TOKEN",
      clientIdEnvironmentName: "ENTRA_CLIENT_ID",
      refreshTokenEnvironmentName: "ENTRA_REFRESH_TOKEN",
      clientSecretEnvironmentName: "ENTRA_CLIENT_SECRET",
      tokenPath: "/organizations/oauth2/v2.0/token",
      resourcePath: "/v1.0/me",
      reviewedResourcePath: "/v1.0/me",
      deniedMethod: "GET",
      deniedPath: "/v1.0/users",
      targetId: "entra-runtime-identity-real-oauth-lifecycle",
    },
  ],
] as const satisfies readonly (readonly [string, string, RuntimeIdentityE2EScenario])[];

export type RuntimeIdentityE2EContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "sandbox"
> & {
  skip: (note?: string) => never;
};

export const RUNTIME_IDENTITY_E2E_OPTIONS = {
  timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm live runtime identity prerequisites",
      "onboard a real OpenShell sandbox",
      "start the public OAuth issuer and protected resource",
      "plan the non-secret runtime identity reference",
      "apply and attach the runtime identity through OpenShell",
      "prove inference remains live after identity attachment",
      "call the protected resource with the injected bearer",
      "reject unreviewed credential delivery before bearer substitution",
      "rotate the credential and relaunch with its new placeholder",
      "verify secret-safe status and deterministic rollback",
    ],
  },
} as const;
