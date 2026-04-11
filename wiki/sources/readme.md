---
title: "Source: README"
category: source
created: 2026-04-11
updated: 2026-04-11
tags: [readme, overview, quickstart]
---

# README

**Source:** `README.md` (repository root)

## Summary

The primary project README for NVIDIA NemoClaw. Covers the high-level pitch,
quick start guide, architecture overview, inference provider table, protection
layers, sandbox policy configuration, key commands, and links to documentation.

## Key Information

- NemoClaw is an open-source reference stack for running OpenClaw agents safely
- Alpha status since March 16, 2026
- One-line install: `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`
- Two-part architecture: thin TypeScript plugin + versioned Python blueprint
- Four protection layers: network, filesystem, process, inference
- Supports NVIDIA cloud, OpenAI, Anthropic, Gemini, Ollama, NIM, vLLM
- Default model: `nvidia/nemotron-3-super-120b-a12b`

## Pages Updated

- [overview.md](../overview.md)
- [OpenClaw](../entities/openclaw.md), [OpenShell](../entities/openshell.md),
  [Sandbox](../entities/sandbox.md), [NVIDIA Nemotron](../entities/nvidia-nemotron.md)
- [Installation](../concepts/installation.md), [CLI Commands](../concepts/cli-commands.md),
  [Inference Routing](../concepts/inference-routing.md), [Network Policy](../concepts/network-policy.md)
