// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesDiscordHttpProxyWebSocketUrl(host: string, port: number | string): string {
  return `http://${host}:${port}/gateway`;
}

export function hermesDiscordNodeHttpProbeSource(url: string): string {
  return `const http = require("node:http");
http.get(${JSON.stringify(url)}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    console.log("response " + response.statusCode + " " + body);
    process.exitCode = 3;
  });
}).on("error", (error) => {
  console.error(error.message);
  process.exitCode = 2;
});`;
}
