#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

tls_dir="${RUNNER_TEMP}/nemoclaw-mcp-tls"
install -d -m 700 "${tls_dir}"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -nodes \
  -days 1 \
  -subj "/CN=NemoClaw MCP E2E Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "${tls_dir}/ca.key" \
  -out "${tls_dir}/ca.crt"

openssl req \
  -newkey rsa:2048 \
  -sha256 \
  -nodes \
  -subj "/CN=host.openshell.internal" \
  -addext "subjectAltName=DNS:host.openshell.internal,DNS:mcp-rebind.example.test" \
  -keyout "${tls_dir}/server.key" \
  -out "${tls_dir}/server.csr"

openssl x509 \
  -req \
  -sha256 \
  -days 1 \
  -in "${tls_dir}/server.csr" \
  -CA "${tls_dir}/ca.crt" \
  -CAkey "${tls_dir}/ca.key" \
  -CAcreateserial \
  -extfile <(printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:host.openshell.internal,DNS:mcp-rebind.example.test") \
  -out "${tls_dir}/server.crt"

# The self-signed certificate secures only the loopback origin hop from
# cloudflared, which is launched with --no-tls-verify for that local fixture.
# Successful sandbox MCP connections use the public trycloudflare URL and its
# publicly trusted edge certificate. The direct DNS-rebinding fixture is denied
# by policy before TLS, so sandboxes never install or trust this private test CA.
{
  echo "NEMOCLAW_MCP_TLS_CERT=${tls_dir}/server.crt"
  echo "NEMOCLAW_MCP_TLS_KEY=${tls_dir}/server.key"
} >>"${GITHUB_ENV}"
