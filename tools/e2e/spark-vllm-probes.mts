// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import net, { isIP } from "node:net";

const VLLM_PORT = 8000;

export function vllmPublicationProbes(bridge: string, interfaces: unknown) {
  assert(
    interfaces && typeof interfaces === "object" && !Array.isArray(interfaces),
    "invalid interface inventory",
  );
  const allowed = ["127.0.0.1", bridge];
  const denied = new Set<string>();
  let externalIpv4 = false;
  let ipv6 = false;
  for (const [name, entries] of Object.entries(interfaces)) {
    assert(Array.isArray(entries), "invalid interface addresses");
    for (const { address, family, internal, scopeid } of entries) {
      assert(
        typeof address === "string" && !address.includes("%") && typeof internal === "boolean",
        "invalid interface address",
      );
      if (family === "IPv6") {
        assert(
          isIP(address) === 6 && Number.isSafeInteger(scopeid) && scopeid >= 0,
          "invalid IPv6 interface",
        );
        ipv6 = true;
        denied.add(scopeid ? `${address}%${name}` : address);
      } else {
        assert(family === "IPv4" && isIP(address) === 4, "invalid IPv4 interface");
        if (allowed.includes(address)) continue;
        externalIpv4 ||= !internal && !address.startsWith("127.");
        denied.add(address);
      }
    }
  }
  assert(externalIpv4, "vLLM publication proof requires an unintended non-loopback IPv4 address.");
  return {
    allowed: allowed.map((host) => `http://${host}:${VLLM_PORT}/health`),
    denied: [...denied],
    ipv6: ipv6 ? "configured" : "unconfigured",
  };
}

export function observeVllmConnection(
  address: string,
): Promise<{ address: string; port: number; result: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port: VLLM_PORT });
    const finish = (result: string) => {
      socket.destroy();
      resolve({ address, port: VLLM_PORT, result });
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? "unknown"));
    socket.setTimeout(3_000, () => finish("ETIMEDOUT"));
  });
}

export function vllmPublicationCurlArgs(urls: readonly string[]): string[] {
  return [
    "-q",
    "--noproxy",
    "*",
    "--globoff",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "3",
    "--max-time",
    "5",
    "--write-out",
    "%{exitcode} %{http_code}\n",
    ...urls.flatMap((url) => ["--output", "/dev/null", url]),
  ];
}

export const SPARK_EGRESS_PROBE =
  "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"";

export const SPARK_EXTRA_ARGS = '["--max-num-seqs","2"]';

export async function boundedSparkVllmProfilePlan() {
  const { loadManagedInferenceCatalog } =
    await import("../../src/lib/inference/serving/catalog-loader.ts");
  const { isHostLocalInferenceServingRecipe } =
    await import("../../src/lib/inference/serving/adapter-registry.ts");
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(
    ({ metadata }) => metadata.id === "vllm.dgx-spark-gb10.single-64gb.qwen3-6-35b-a3b-nvfp4",
  );
  const recipe = catalog.recipes.find(
    ({ metadata }) => metadata.id === preset?.spec.plan.recipeRef,
  );
  if (!preset || !recipe || !isHostLocalInferenceServingRecipe(recipe)) return undefined;
  return {
    catalogDigest: catalog.catalogDigest,
    preset,
    recipe,
    presetDigest: catalog.sources.find(
      (source) => source.kind === "ServingPreset" && source.id === preset.metadata.id,
    )!.digest,
    recipeDigest: catalog.sources.find(
      (source) => source.kind === "ServingRecipe" && source.id === recipe.metadata.id,
    )!.digest,
  };
}
