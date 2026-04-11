---
title: NVIDIA Nemotron
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-about-overview]
tags: [model, inference, nvidia]
---

# NVIDIA Nemotron

Open-source LLM model family from NVIDIA. The default cloud inference model
for NemoClaw is `nvidia/nemotron-3-super-120b-a12b`, served via NVIDIA
Endpoints at `integrate.api.nvidia.com`.

## Usage in NemoClaw

Selected as the default production model during [onboarding](../concepts/installation.md).
Requires an NVIDIA API key obtained from <https://build.nvidia.com>.

Inference requests from the [sandbox](sandbox.md) are routed through the
[OpenShell gateway](openshell-gateway.md) — the agent never sees the raw API
key. See [inference routing](../concepts/inference-routing.md).

## See Also

- [Inference Routing](../concepts/inference-routing.md) — How model calls are routed
- [NVIDIA Agent Toolkit](nvidia-agent-toolkit.md) — Broader toolkit family
