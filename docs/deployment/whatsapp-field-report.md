---
title:
  page: "WhatsApp Inside NemoClaw — Field Report and Workaround"
  nav: "WhatsApp Field Report"
description:
  main: "Documents one team's experience trying to run WhatsApp (Baileys) inside a NemoClaw sandbox, the challenges encountered with the egress proxy, and a host-side bridge workaround."
  agent: "Covers WhatsApp Web (Baileys) compatibility challenges with OpenShell's TLS-intercepting egress proxy and the Noise Protocol. Includes a working bridge sidecar pattern for those who need WhatsApp alongside NemoClaw. Use when evaluating messaging channel options or troubleshooting WhatsApp connectivity."
keywords: ["nemoclaw whatsapp", "baileys proxy", "whatsapp bridge sidecar", "noise protocol", "openshell egress proxy"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "whatsapp", "deployment", "nemoclaw", "community"]
content:
  type: reference
  difficulty: advanced
  audience: ["developer", "engineer"]
status: draft
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 Alexandre Feder, Vecia
  SPDX-License-Identifier: Apache-2.0
-->

# WhatsApp Inside NemoClaw — Field Report

> **Community contribution.** This documents our experience deploying WhatsApp (via Baileys) inside a NemoClaw sandbox over 8 days. We may be missing configuration options or approaches that would resolve these issues — corrections and suggestions are very welcome.

## Context

We were deploying an OpenClaw agent for a small business (CrossFit gym in France) that needed WhatsApp as its primary messaging channel. OpenClaw supports WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys), which implements the WhatsApp Web protocol.

WhatsApp works perfectly with OpenClaw running standalone (outside NemoClaw). The challenges below are specific to running inside the sandbox.

**Environment:** NemoClaw v0.1.0, OpenShell v0.0.24, OpenClaw 2026.4.9, Ubuntu 22.04.

## What We Encountered

### Challenge 1: Noise Protocol and TLS Interception

WhatsApp Web uses the [Noise Protocol Framework](http://www.noiseprotocol.org/) (Noise_XX_25519_AESGCM_SHA256) for end-to-end authentication on top of TLS. The Noise handshake verifies the server's static key independently of the TLS certificate chain.

OpenShell's egress proxy terminates TLS using a per-sandbox ephemeral CA for credential injection and L7 inspection. As far as we could tell, this means the Noise handshake sees the proxy's certificate rather than WhatsApp's server key, and rejects the connection with status 405.

We tried various approaches to work around this:
- `access: full` policy — still appeared to terminate TLS (we may have misconfigured this)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` + `rejectUnauthorized: false` — bypassed the TLS certificate check but Noise Protocol still rejected
- Various proxy agent configurations (HttpsProxyAgent, tunnel-agent.httpsOverHttp) — the tunnel-agent approach got furthest: WebSocket OPEN fired for the first time, but then 405 after 2 seconds during the Noise handshake

We're not sure if there's a policy configuration (perhaps `tls: passthrough` or `tls: skip`) that would let this work. If there is, we'd love to know.

**Related issues:** [#361](https://github.com/NVIDIA/NemoClaw/issues/361), [#513](https://github.com/NVIDIA/NemoClaw/issues/513)

### Challenge 2: WebSocket Connection Timeout

Independently of the TLS/Noise issue, we noticed that the egress proxy appears to terminate established connections after approximately 2 minutes (as documented in [#409](https://github.com/NVIDIA/NemoClaw/issues/409)). WhatsApp Web requires a persistent WebSocket connection, so even if the Noise handshake succeeded, the connection would likely be dropped.

We couldn't find a configuration option to adjust this timeout. If one exists, that would help not just WhatsApp but any WebSocket-based integration.

### What We Ruled Out

- **Credential issues:** We tested with credentials generated seconds before the attempt — same result.
- **Baileys version:** Used `@whiskeysockets/baileys@7.0.0-rc.9` with `fetchLatestBaileysVersion()` — same version that works standalone.
- **Browser fingerprint:** Tried various `Browsers.*` configurations — the 405 occurs during Noise handshake, not browser identification.
- **Network connectivity:** Raw WebSocket to `wss://web.whatsapp.com/ws/chat` opens successfully from the sandbox — the TCP/TLS layer works. The failure is specifically in the Noise Protocol handshake that happens after the WebSocket is established.

## Workaround: Host-Side Bridge

For anyone who needs WhatsApp alongside NemoClaw, we found that running Baileys on the host (outside the sandbox) and relaying messages via the OpenClaw hooks API works well:

```
Host (direct internet)            Sandbox
┌──────────────────┐             ┌──────────────┐
│ Baileys Bridge   │ POST       │ OpenClaw     │
│ (Node.js)        │ /hooks/    │ Gateway      │
│                  │───────────→│              │
│ WhatsApp ←──────→│ agent      │ (agents)     │
│                  │←───────────│              │
│ HTTP :3001       │ reply      │ HTTP :18789  │
└──────────────────┘             └──────────────┘
```

### Key implementation details

- **Package:** `@whiskeysockets/baileys` (not `baileys` — different npm package, the unscoped one doesn't work)
- **Critical:** Must call `fetchLatestBaileysVersion()` and pass `version` to `makeWASocket()`. Without this, Baileys sends an outdated protocol version that WhatsApp rejects with 405 even from outside the sandbox.
- **Auth state:** `useMultiFileAuthState('./auth')` in a dedicated directory on the host, separate from sandbox credentials
- **Relay to gateway:** `POST /hooks/agent` with the hooks token (not the gateway auth token)
- **Outbound from sandbox:** Bridge exposes `POST /send` on the host. Sandbox crons reach it via the host IP. Requires a firewall rule (e.g., `ufw allow from 172.16.0.0/12 to any port 3001`) — the same pattern used for CLIProxy or any host service.
- **Pairing code mode:** For headless servers, pass `--pair <phone>` and use `sock.requestPairingCode()` instead of QR scanning.

### Disconnect handling

```javascript
sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
  const code = lastDisconnect?.error?.output?.statusCode;
  if (connection === "close") {
    if (code === DisconnectReason.loggedOut) {
      process.exit(0);  // Clean exit — don't auto-restart on logout
    } else if (code === 499) {
      setTimeout(start, 60000);  // Another session active — wait, don't restore creds
    } else {
      setTimeout(start, 3000);  // Network hiccup — reconnect
    }
  }
});
```

Status 499 ("replaced by another session") should **not** trigger credential restoration — that creates a reconnect loop. Wait 60 seconds and retry.

## Recommendation

If you're choosing a messaging channel for NemoClaw, **Telegram is the path of least resistance**. It uses standard HTTPS REST (no WebSocket, no certificate pinning, no custom handshake), works natively inside the sandbox, and is well-documented in [Set Up Telegram](set-up-telegram-bridge.md).

If you specifically need WhatsApp, the bridge pattern above works but adds operational complexity (separate process on the host, credential management, systemd service).

## Questions for the NemoClaw Team

We'd appreciate guidance on any of these:

1. Is there a policy configuration that allows true TLS passthrough (forwarding encrypted traffic without interception) for specific endpoints? If so, WhatsApp might work inside the sandbox.
2. Is the ~2-minute connection timeout (#409) planned to be configurable?
3. Is the bridge sidecar pattern something worth documenting officially for incompatible protocols, or is there a better approach we missed?

---

*Contributed by [Vecia](https://vecia.fr) — we deploy OpenClaw agents for small businesses. Feedback, corrections, and better approaches are welcome.*
