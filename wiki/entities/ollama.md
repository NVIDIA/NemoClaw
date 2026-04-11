---
title: Ollama
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-inference]
tags: [inference, local, experimental]
---

# Ollama

Local inference runtime supported by NemoClaw as an experimental provider.

## Integration with NemoClaw

- During [onboarding](../concepts/installation.md), NemoClaw can discover Ollama
  on the host (or Windows host via WSL2)
- Lists available models for selection
- Records the context window from `ollama ps` (preferred) or `ollama show`
- Configures sandbox traffic routing through Docker hostnames
  (`host.docker.internal` on WSL2)

## Context Window

NemoClaw records the context window discovered during onboarding to prevent
OpenClaw from advertising a larger prompt budget than the model serves.
If context changes in Ollama, re-run onboarding to sync.

OpenClaw requires ≥16,000 token context window.

## Verification

Test the managed route from inside the sandbox (not the host port directly):

```bash
nemoclaw my-assistant connect
curl -sk https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer unused" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"Reply with exactly: OLLAMA_OK"}],"max_tokens":16}'
```

Direct requests to `http://host.docker.internal:11434` may be blocked by
sandbox policy even when the managed route works.

## See Also

- [Inference Routing](../concepts/inference-routing.md) — Provider routing details
- [OpenShell Gateway](openshell-gateway.md) — Routes Ollama calls
