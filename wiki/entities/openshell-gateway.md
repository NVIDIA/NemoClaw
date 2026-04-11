---
title: OpenShell Gateway
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [docs-reference-architecture, docs-about-how-it-works]
tags: [gateway, inference, security]
---

# OpenShell Gateway

The credential-owning proxy that sits between the [sandbox](sandbox.md) and
external inference providers. It intercepts all model API calls from the
sandbox and routes them to the configured provider.

## Key Properties

- Owns API keys — the sandbox never sees raw credentials
- Routes requests from `inference.local` to the active provider endpoint
- Supports hot-swapping providers at runtime without sandbox restart
- Started automatically during onboarding

## Inference Flow

```text
OpenClaw Agent (sandbox)
  → inference.local (CONNECT tunnel)
    → OpenShell Gateway (credential injection)
      → Provider Endpoint (NVIDIA, OpenAI, Anthropic, Ollama, etc.)
```

## Recovery After Reboot

```bash
openshell gateway start --name nemoclaw
```

## See Also

- [OpenShell](openshell.md) — Parent runtime
- [Inference Routing](../concepts/inference-routing.md) — Provider configuration
- [Sandbox](sandbox.md) — The container that routes through this gateway
