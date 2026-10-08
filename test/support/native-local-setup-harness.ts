// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../src/lib/adapters/openshell/provider-adapter";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "../../src/lib/inference/native-local/contract";

export function nativeLocalSetupReceipt(
  binding: Omit<NativeLocalBinding, "credentialEnv">,
): NativeLocalProviderAttachment {
  const selected = { ...binding, credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV };
  const identity = nativeLocalIdentity(selected);
  return {
    ...selected,
    ...identity,
    schemaVersion: 1,
    providerId: `fixture-${identity.providerName}`,
  };
}

/** Stateful provider boundary; production selection and ownership checks still execute. */
export function createNativeLocalSetupHarness() {
  const providers = new Map<string, OpenShellProviderMetadata>();
  const authorities = new Map<string, NativeLocalProviderAttachment>();
  const profiles: Record<string, unknown>[] = [];
  const unsupported = () => {
    throw new Error("Unexpected native setup adapter operation");
  };
  const adapter = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(
      async ({ profilePath }) => {
        profiles.push(JSON.parse(fs.readFileSync(profilePath, "utf8")));
        return { ok: true };
      },
    ),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(
      async ({ target, providerName }) => {
        const value = providers.get(JSON.stringify([target, providerName]));
        return value
          ? { ok: true, value }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } };
      },
    ),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async (request) => {
      providers.set(JSON.stringify([request.target, request.name]), {
        name: request.name,
        type: request.type,
        credentialKeys: request.credentials.map(({ name }) => name),
        configKeys: request.config.map(({ key }) => key),
        revision: { id: `fixture-${request.name}`, resourceVersion: 1 },
      });
      return { ok: true };
    }),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(async (request) => {
      const key = JSON.stringify([request.target, request.providerName]);
      const previous = providers.get(key);
      if (!previous)
        return { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } };
      providers.set(key, {
        ...previous,
        credentialKeys: request.credentials.map(({ name }) => name),
        revision: {
          id: previous.revision!.id,
          resourceVersion: previous.revision!.resourceVersion + 1,
        },
      });
      return { ok: true };
    }),
    deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(
      async ({ target, providerName }) => {
        providers.delete(JSON.stringify([target, providerName]));
        return { ok: true };
      },
    ),
    inspectProviderProfile: vi.fn(unsupported),
    listProviders: vi.fn(unsupported),
    listProviderAttachments: vi.fn(unsupported),
    attachProvider: vi.fn(unsupported),
    detachProvider: vi.fn(unsupported),
    configureProviderRefresh: vi.fn(unsupported),
    getProviderRefreshStatus: vi.fn(unsupported),
  } satisfies OpenShellProviderAdapter;
  return {
    seed(receipt: NativeLocalProviderAttachment) {
      authorities.set(receipt.providerName, receipt);
      providers.set(
        JSON.stringify([{ kind: "named", gatewayName: receipt.gatewayName }, receipt.providerName]),
        {
          name: receipt.providerName,
          type: receipt.profileId,
          credentialKeys: [receipt.credentialEnv],
          configKeys: [],
          revision: { id: receipt.providerId, resourceVersion: 1 },
        },
      );
    },
    adapter,
    providers,
    authorities,
    profiles,
    getNativeLocalProviderAuthority: (name: string) => authorities.get(name),
    clearNativeLocalProviderAuthority: (receipt: NativeLocalProviderAttachment) => {
      const current = authorities.get(receipt.providerName);
      if (current?.providerId !== receipt.providerId) throw new Error("Fixture authority changed");
      authorities.delete(receipt.providerName);
    },
    setNativeLocalProviderAuthority: (receipt: NativeLocalProviderAttachment) => {
      authorities.set(receipt.providerName, receipt);
    },
  };
}

/** Exercise the real policy parser without contacting a developer gateway. */
export async function withNativePolicyFixture<T>(operation: () => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-setup-policy-"));
  const executable = path.join(directory, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  fs.writeFileSync(
    executable,
    `#!/bin/sh
set -eu
if [ "$#" = 6 ] && [ "$1" = settings ] && [ "$2" = get ] && [ "$3" = -g ] && [ "$5" = --global ] && [ "$6" = --json ]; then
  printf '%s\\n' '{"scope":"global","settings":{"providers_v2_enabled":"true"}}'
elif [ "$#" = 7 ] && [ "$1" = policy ] && [ "$2" = list ] && [ "$3" = -g ] && [ "$5" = --global ] && [ "$6" = --limit ] && [ "$7" = 1 ]; then
  printf '%s\\n' 'No global policy history found' >&2
else
  echo 'Unexpected policy fixture command' >&2
  exit 1
fi
`,
    { mode: 0o700 },
  );
  process.env.NEMOCLAW_OPENSHELL_BIN = executable;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.NEMOCLAW_OPENSHELL_BIN;
    else process.env.NEMOCLAW_OPENSHELL_BIN = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
