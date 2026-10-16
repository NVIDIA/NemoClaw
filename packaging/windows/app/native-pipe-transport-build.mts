// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type ts from "typescript";

const listenerModule = "dist/server-start-yuOHTviK.js";
const clientModule = "dist/client-I-RoP1Al.js";
const providerModule = "dist/provider-transport-fetch-DGSx4u4m.js";
const catalogModule = "dist/provider-catalog-live-runtime-EZZSw18v.js";
const localCatalogModule = "dist/provider-setup-CQYNqo2d.js";
const callModule = "dist/call-BWR5pPgw.js";
const portHelper = String.raw`
function __nemoPipePort() {
  const value = process.env.NEMOCLAW_MXC_GATEWAY_PIPE_PORT;
  if (value === undefined) return undefined;
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw Error("Invalid native gateway pipe port");
  return Number(value);
}
function __nemoPipeName(port) { return "\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-" + port; }
`;
const listenerHelper = String.raw`
function __nemoListenGateway(httpServer, port, bindHost) {
  const selected = __nemoPipePort();
  if (selected === undefined) return httpServer.listen(port, bindHost);
  if (selected !== port || !["127.0.0.1", "::1"].includes(bindHost))
    throw Error("Native gateway pipe requires the declared loopback port");
  return httpServer.listen({ path: __nemoPipeName(port) });
}
`;
const clientHelper = String.raw`
import { connect as __nemoConnectPipe } from "node:net";
function __nemoGatewaySocketOptions(url, options) {
  const selected = __nemoPipePort();
  if (selected === undefined) return options;
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || Number(target.port) !== selected)
    return options;
  if (target.protocol !== "ws:") throw Error("Native gateway pipe requires local ws transport");
  return { ...options, createConnection: () => __nemoConnectPipe(__nemoPipeName(selected)) };
}
`;
const providerHelper = String.raw`
import { request as __nemoProviderRequest } from "node:http";
import { Readable as __nemoProviderReadable } from "node:stream";
import { pipeline as __nemoProviderPipeline } from "node:stream/promises";
function __nemoBrokerFetchOptions(model, options) {
  const value = process.env.NEMOCLAW_MXC_BROKER_PIPE_PORT;
  const provider = process.env.NEMOCLAW_MXC_MODEL_PROVIDER ?? "nemoclawNative";
  if (value === undefined || typeof model.provider !== "string" || model.provider.toLowerCase() !== provider.toLowerCase()) return options;
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw Error("Invalid native broker pipe port");
  const base = new URL(model.baseUrl);
  const origin = "http://127.0.0.1:" + value;
  if (base.origin !== origin || base.username || base.password || base.pathname !== "/v1" || base.search || base.hash)
    throw Error("Native broker requires its declared local origin");
  if (options.dispatcherPolicy || options.resolveDispatcherPolicy || options.fetchImpl || process.env.OPENCLAW_PROXY_ACTIVE === "1")
    throw Error("Native broker has conflicting transport settings");
  const selected = { mode: "direct", connect: { socketPath: __nemoPipeName(Number(value)) } };
  const resolveDispatcherPolicy = (target) => {
    if (target.origin !== origin || target.username || target.password ||
        !["/v1/models", "/v1/chat/completions"].includes(target.pathname) || target.search || target.hash)
      throw Error("Native broker request escaped its declared endpoint");
    return selected;
  };
  resolveDispatcherPolicy(new URL(options.url));
  // Keep native guarded fetch as the owner of policy, redirects and timeouts.
  // Node's HTTP reader avoids the pinned fetch client's Windows pipe read hang.
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    resolveDispatcherPolicy(target);
    if (init?.redirect !== "manual") throw Error("Native broker requires guarded redirects");
    const request = new Request(url, init);
    return await new Promise((resolve, reject) => {
      const outgoing = __nemoProviderRequest({
        socketPath: selected.connect.socketPath, path: target.pathname,
        method: request.method, headers: Object.fromEntries(request.headers),
        signal: request.signal, agent: false,
      }, incoming => {
        try {
          const headers = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          const status = incoming.statusCode;
          const empty = request.method === "HEAD" || [204, 205, 304].includes(status);
          resolve(new Response(empty ? null : __nemoProviderReadable.toWeb(incoming), {
            status, statusText: incoming.statusMessage, headers,
          }));
          if (empty) incoming.resume();
        } catch (error) { incoming.destroy(); outgoing.destroy(); reject(error); }
      });
      outgoing.once("error", reject);
      if (request.body) {
        void __nemoProviderPipeline(__nemoProviderReadable.fromWeb(request.body), outgoing).catch(reject);
      } else outgoing.end();
    });
  };
  return { ...options, dispatcherPolicy: selected, resolveDispatcherPolicy, fetchImpl };
}
`;
const catalogHelper = String.raw`
import { request as __nemoCatalogRequest } from "node:http";
import { Readable as __nemoCatalogReadable } from "node:stream";
async function __nemoCatalogFetch(params, options) {
  const port = process.env.NEMOCLAW_MXC_BROKER_PIPE_PORT;
  if (port === undefined) return params.fetchGuard(options);
  const provider = process.env.NEMOCLAW_MXC_MODEL_PROVIDER;
  const token = process.env.NEMOCLAW_MXC_MODEL_TOKEN;
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 ||
      !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error("Invalid native catalog transport");
  const local = "http://127.0.0.1:" + port + "/v1/models";
  const endpoints = provider === "nvidia"
    ? [local, "https://integrate.api.nvidia.com/v1/models"]
    : provider === "openrouter" ? [local, "https://openrouter.ai/api/v1/models"] : [local];
  const featured = provider === "nvidia" && options.url === "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
  if (params.providerId !== provider || (!featured && !endpoints.includes(options.url)))
    throw Error("Native catalog request escaped the selected provider");
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 10000)]);
  const response = await new Promise((resolve, reject) => {
    const request = __nemoCatalogRequest({
      socketPath: __nemoPipeName(Number(port)), method: "GET",
      path: featured ? "/native/nvidia-featured-models" : "/v1/models",
      headers: { authorization: "Bearer " + token, accept: "application/json" }, signal,
    }, resolve);
    request.once("error", reject);
    request.end();
  });
  return {
    response: new Response(__nemoCatalogReadable.toWeb(response), { status: response.statusCode, headers: { "content-type": response.headers["content-type"] ?? "application/json" } }),
    finalUrl: options.url,
    release: async () => { response.destroy(); },
  };
}
`;
const identityHelper = String.raw`
function __nemoPipeRequiresIdentity(url) {
  const selected = __nemoPipePort();
  if (selected === undefined) return false;
  const target = new URL(url);
  return ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && Number(target.port) === selected;
}
`;

/** Change only the pinned gateway listener/client call sites, never Node prototypes. */
export function compileNativePipeTransport(relative: string, text: string, syntax?: typeof ts) {
  if (
    relative !== listenerModule &&
    relative !== clientModule &&
    relative !== providerModule &&
    relative !== catalogModule &&
    relative !== localCatalogModule &&
    relative !== callModule
  )
    return text;
  if (!syntax) throw new Error("Native gateway compilation requires the syntax parser.");
  const file = syntax.createSourceFile(
    relative,
    text,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.JS,
  );
  const edits: { start: number; end: number; replacement: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      relative === localCatalogModule &&
      syntax.isCallExpression(node) &&
      node.expression.getText(file) === "fetchWithSsrFGuard" &&
      node.arguments.length === 1
    )
      edits.push({
        start: node.getStart(file),
        end: node.end,
        replacement:
          "__nemoCatalogFetch({ ...params, providerId: process.env.NEMOCLAW_MXC_MODEL_PROVIDER, fetchGuard: fetchWithSsrFGuard }, " +
          node.arguments[0]!.getText(file) +
          ")",
      });
    if (
      relative === catalogModule &&
      syntax.isCallExpression(node) &&
      node.expression.getText(file) === "params.fetchGuard" &&
      node.arguments.length === 1
    )
      edits.push({
        start: node.getStart(file),
        end: node.end,
        replacement: "__nemoCatalogFetch(params, " + node.arguments[0]!.getText(file) + ")",
      });
    if (
      relative === callModule &&
      syntax.isFunctionDeclaration(node) &&
      node.name?.text === "shouldOmitDeviceIdentityForGatewayCall" &&
      node.body &&
      node.parameters.length === 1 &&
      node.parameters[0]?.name.getText(file) === "params"
    )
      edits.push({
        start: node.body.getStart(file) + 1,
        end: node.body.getStart(file) + 1,
        replacement: "\nif (__nemoPipeRequiresIdentity(params.url)) return false;\n",
      });
    if (
      relative === listenerModule &&
      syntax.isCallExpression(node) &&
      syntax.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "httpServer" &&
      node.expression.name.text === "listen" &&
      node.arguments.length === 2 &&
      node.arguments[0]?.getText(file) === "port" &&
      node.arguments[1]?.getText(file) === "bindHost"
    )
      edits.push({
        start: node.getStart(file),
        end: node.end,
        replacement: "__nemoListenGateway(httpServer, port, bindHost)",
      });
    if (
      relative === clientModule &&
      syntax.isNewExpression(node) &&
      node.expression.getText(file) === "WebSocket" &&
      node.arguments?.length === 2 &&
      node.arguments[0]?.getText(file) === "url" &&
      node.arguments[1]?.getText(file) === "transport.options"
    )
      edits.push({
        start: node.arguments[1].getStart(file),
        end: node.arguments[1].end,
        replacement: "__nemoGatewaySocketOptions(url, transport.options)",
      });
    if (
      relative === providerModule &&
      syntax.isCallExpression(node) &&
      node.expression.getText(file) === "fetchWithSsrFGuard" &&
      node.arguments.length === 1 &&
      node.arguments[0]?.getText(file) ===
        "useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions"
    )
      edits.push({
        start: node.arguments[0].getStart(file),
        end: node.arguments[0].end,
        replacement: "__nemoBrokerFetchOptions(model, " + node.arguments[0].getText(file) + ")",
      });
    syntax.forEachChild(node, visit);
  };
  visit(file);
  if (edits.length !== 1) throw new Error(`Pinned native gateway call site changed: ${relative}`);
  const edit = edits[0]!;
  return (
    portHelper +
    (relative === listenerModule
      ? listenerHelper
      : relative === clientModule
        ? clientHelper
        : relative === callModule
          ? identityHelper
          : relative === catalogModule || relative === localCatalogModule
            ? catalogHelper
            : providerHelper) +
    text.slice(0, edit.start) +
    edit.replacement +
    text.slice(edit.end)
  );
}
