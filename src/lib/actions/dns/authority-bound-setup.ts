// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createDnsSetupPolicyAuthorityRevalidator,
  type DnsSetupPolicyAuthorityRevalidatorDeps,
} from "../sandbox/policy-authority/revalidator";
import { runSetupDnsProxy, type SetupDnsProxyOptions, type SetupDnsProxyResult } from "./index";

export interface AuthorityBoundDnsSetupOptions extends SetupDnsProxyOptions {
  readonly recordedPolicyAuthority?: unknown;
}

export interface AuthorityBoundDnsSetupDeps {
  readonly getSandbox?: DnsSetupPolicyAuthorityRevalidatorDeps["getSandbox"];
  readonly inspectSandboxPolicyAuthority?: DnsSetupPolicyAuthorityRevalidatorDeps["inspectSandboxPolicyAuthority"];
  readonly runSetupDnsProxy?: typeof runSetupDnsProxy;
}

/** Run the hidden DNS repair command with one recorded/live authority receipt. */
export function runAuthorityBoundDnsSetup(
  options: AuthorityBoundDnsSetupOptions,
  deps: AuthorityBoundDnsSetupDeps = {},
): SetupDnsProxyResult {
  const revalidatePolicyAuthority = createDnsSetupPolicyAuthorityRevalidator(
    {
      gatewayName: options.gatewayName,
      recordedPolicyAuthority: options.recordedPolicyAuthority,
      sandboxName: options.sandboxName,
    },
    {
      getSandbox: deps.getSandbox,
      inspectSandboxPolicyAuthority: deps.inspectSandboxPolicyAuthority,
    },
  );
  revalidatePolicyAuthority(`start DNS proxy repair for sandbox '${options.sandboxName}'`);

  return (deps.runSetupDnsProxy ?? runSetupDnsProxy)(
    {
      gatewayName: options.gatewayName,
      sandboxName: options.sandboxName,
    },
    { revalidatePolicyAuthority },
  );
}
