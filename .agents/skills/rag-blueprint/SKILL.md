---
name: rag-blueprint
version: "2.6.0"
description: "NVIDIA RAG Blueprint — deploy, configure, troubleshoot, and manage. Handles any RAG action: deploy, install, start, enable, disable, toggle, change, configure, troubleshoot, debug, fix, shutdown, stop, or tear down any RAG feature or service (Agentic RAG, VLM, guardrails, query rewriting, models, search, ingestion, observability, summarization, reasoning, and more)."
license: Apache-2.0
compatibility: >-
  NVIDIA RAG Blueprint repository checkout; Docker/Compose or Kubernetes/Helm
  for deployments; Python 3.11+ for library workflows; NVIDIA GPU tooling for
  self-hosted NIM services.
metadata:
  author: "NVIDIA RAG <foundational-rag-dev@exchange.nvidia.com>"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/rag"
  endpoint-openapi-schemas:
    - docs/api_reference/openapi_schema_rag_server.json
    - docs/api_reference/openapi_schema_ingestor_server.json
  argument-hint: deploy RAG | enable feature | disable feature | configure | troubleshoot | shutdown
  tags:
    - nvidia
    - blueprint
    - rag
    - deployment
    - configuration
    - troubleshooting
  languages:
    - python
    - typescript
    - shell
  frameworks:
    - fastapi
    - langchain
    - react
    - docker-compose
    - helm
  domain: ai-ml
allowed-tools: Bash(echo *) Bash(nvidia-smi *) Bash(curl --version *) Bash(docker ps *) Bash(docker info *) Bash(docker --version *) Bash(docker version *) Bash(docker logs *) Bash(docker inspect *) Bash(docker stats *) Bash(docker compose ps *) Bash(docker compose logs *) Bash(docker compose config *) Bash(docker compose version *) Bash(kubectl get *) Bash(kubectl describe *) Bash(kubectl version *) Bash(kubectl logs *) Bash(kubectl api-resources *) Bash(kubectl rollout status *) Bash(helm version *) Bash(helm list *) Bash(helm status *) Bash(oc get *) Bash(oc describe *) Bash(oc logs *) Bash(oc whoami *) Bash(oc version *) Bash(git rev-parse *) Bash(git describe *) Bash(git status *) Bash(python3 --version *) Bash(pip3 show *) Bash(df *) Bash(du *) Bash(cat /proc/*) Bash(cat /etc/os-release *) Bash(ss *) Bash(netstat *) Bash(ls *) Bash(grep *) Bash(lsof *) Bash(ps aux *) Read Grep Glob
---

# NVIDIA RAG Blueprint

## Purpose

Use this skill for NVIDIA RAG Blueprint operations: deployment, configuration,
troubleshooting, shutdown, and feature management across Docker, Helm, and
library deployments.

## Instructions

1. Match the user request to the intent routing table below.
2. Read the referenced playbook before making changes.
3. Use repository docs and deployment config files as the source of truth.
4. Verify the affected service or workflow after changes.

## Prerequisites

- NVIDIA RAG Blueprint repository checkout.
- Docker/Compose or Kubernetes/Helm for deployments.
- Python 3.11+ for library workflows.
- NVIDIA GPU tooling for self-hosted NIM services.

## Autonomy Principles

- Auto-detect everything: GPU, VRAM, drivers, Docker, CUDA, disk, OS, ports, existing services, NGC key, repo state.
- If it can be checked with a command, check it — don't ask the user.
- Ask only when user action is required: providing an API key, confirming data deletion, or choosing between equally valid options.
- Once analysis is done, route to the correct workflow and execute.

## Intent Detection

Determine what the user wants and route immediately:

| User Intent | Action |
|-------------|--------|
| Deploy, install, set up, start RAG | Read and follow `references/deploy.md` |
| Configure, enable, change, toggle a feature | Use the Configure section below |
| Troubleshoot, debug, fix, error, unhealthy | Read and follow `references/troubleshoot.md` |
| Stop, shutdown, tear down, clean up | Read and follow `references/shutdown.md` |

If the intent is ambiguous, infer from context (e.g., "RAG isn't working" → troubleshoot; "get RAG running" → deploy). Only ask if genuinely unclear.

---

## Configure

Requires a running RAG deployment. If services are not running, deploy first via `references/deploy.md`.

Match the user's request to a reference file, then read and follow it:

| Feature Keywords | Reference |
|-----------------|-----------|
| VLM, VLM embeddings, image captioning | `references/configure/vlm.md` |
| NeMo Guardrails | `references/configure/guardrails.md` |
| Agentic RAG, planning/execution agent, agentic streaming, stage events | `references/configure/agentic-rag.md` |
| Query rewriting, decomposition, multi-turn | `references/configure/query-and-conversation.md` |
| Ingestion (text-only, audio, Nemotron Parse, OCR, batch CLI, NV-Ingest, volume mount, performance) | `references/configure/ingestion.md` |
| Search, retrieval, hybrid search, multi-collection, metadata, filters, Elasticsearch filters, reranker, topK, accuracy/performance | `references/configure/search-and-retrieval.md` |
| LLM/embedding/ranking model changes, vector DB, Milvus/Elasticsearch auth, service keys, model profiles, ports/GPU | `references/configure/models-and-infrastructure.md` |
| Reasoning, thinking mode, `reasoning_content`, self-reflection, prompts, generation params (tokens, temperature, citations), per-request LLM params | `references/configure/reasoning-and-generation.md` |
| Summarization | `references/configure/summarization.md` |
| Observability (tracing, Zipkin, Grafana, Prometheus) | `references/configure/observability.md` |
| Multimodal query (image + text) | `references/configure/multimodal-query.md` |
| Data catalog (collection/document metadata) | `references/configure/data-catalog.md` |
| User interface (UI settings, reasoning panel, metadata filters) | `references/configure/user-interface.md` |
| API reference (endpoints, schemas) | `references/configure/api-reference.md` |
| Evaluation (RAGAS metrics) | `references/configure/evaluation.md` (and skill `rag-eval`) |
| MCP server & client, agent toolkit | `references/configure/mcp.md` |
| Migration (version upgrades) | `references/configure/migration.md` |
| Notebooks (setup and catalog) | `references/configure/notebooks.md` |

### Configure Flow

1. Match the user's request to a reference file from the table above.

2. Detect what's running:
   ```bash
   echo "=== NIM ===" && docker ps --format '{{.Names}}' 2>/dev/null | grep -iE '(nim-llm|nemotron-(vlm-)?embedding|nemotron-ranking|nemotron-vlm|nemotron-3-nano-omni|page-elements|graphic-elements|table-structure|nemotron-ocr)' || echo "NO_LOCAL_NIMS"; echo "=== RAG ===" && docker ps --format '{{.Names}}' 2>/dev/null | grep -iE '(rag-server|ingestor-server|elasticsearch|milvus|seaweedfs|lancedb)' || echo "NO_DOCKER_RAG"; echo "=== K8S ===" && kubectl get pods -n rag 2>/dev/null | head -5 || echo "NO_K8S"; echo "=== LIBRARY ===" && ps aux 2>/dev/null | grep -E '(nvidia_rag|uvicorn.*rag)' | grep -v grep || echo "NO_LIBRARY"
   ```

3. Use this table to determine platform, deployment type, and where config lives:

   | Local NIMs running? | RAG services running? | Deployment Type | Config Location |
   |---------------------|-----------------------|-----------------|-----------------|
   | Yes (Docker) | Any | Self-hosted | `deploy/compose/.env` |
   | No | Yes (Docker) | NVIDIA-hosted | `deploy/compose/nvdev.env` |
   | Yes (K8s pods) | Any | Self-hosted | `values.yaml` (NIM sections) |
   | No | Yes (K8s pods) | NVIDIA-hosted | `values.yaml` (envVars) |
   | — | Library processes | Library mode | `notebooks/config.yaml` |
   | No | No | Not running | Deploy first via `references/deploy.md` |

   Tell the user what you detected and ask to confirm. Example: "I see local NIM containers running (nim-llm-ms, nemotron-vlm-embedding-ms) — this is a self-hosted deployment. Config file is `deploy/compose/.env`. Correct?"

4. Check current feature state before changing anything — read the config location from step 3, then cross-check the live service:
   - Docker: `docker exec rag-server env 2>/dev/null | grep -E "<VAR_NAME>"`
   - Helm: `kubectl get pod -n rag -l app=rag-server -o jsonpath='{.items[0].spec.containers[0].env}' 2>/dev/null`

   If the config file and live service disagree, tell the user the service has stale config and will need a restart.

5. If the feature needs extra GPUs, check availability against hardware restrictions (see below):
   ```bash
   nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv,noheader 2>/dev/null || echo "NO_GPU"
   ```

6. Read the reference file and apply changes:
   - Docker: edit the env file (uncomment to enable, re-comment to disable — the env file is the source of truth). Then restart the affected service:
     ```
     source <env-file> && docker compose -f deploy/compose/<compose-file> up -d
     ```
     | Service | Compose File |
     |---------|-------------|
     | rag-server | `docker-compose-rag-server.yaml` |
     | ingestor-server | `docker-compose-ingestor-server.yaml` |
     | Elasticsearch, Milvus, etcd, SeaweedFS | `vectordb.yaml` |
     | NIM containers (LLM, embedding, ranking, VLM, OCR, parse, audio, extraction) | `nims.yaml` |
     | guardrails | `docker-compose-nemo-guardrails.yaml` |
     | observability (Grafana, Prometheus, Zipkin) | `observability.yaml` |
   - Helm: edit `values.yaml`, then upgrade: `helm upgrade rag <chart> -n rag -f values.yaml`
   - Library: edit `notebooks/config.yaml`, then restart the Python process

7. Verify:
   - Docker: `docker ps --format "table {{.Names}}\t{{.Status}}" | head -20; curl -s http://localhost:8081/v1/health?check_dependencies=true 2>/dev/null | head -1`
   - Helm: `kubectl get pods -n rag; kubectl rollout status deployment/rag-server -n rag --timeout=120s`
   - Library: `curl -s http://localhost:8081/v1/health 2>/dev/null | head -1`

8. If restart fails, read `references/troubleshoot.md`. If multiple features requested, repeat from step 1 for each.

## Examples

- "Deploy RAG" -> route to `references/deploy.md`.
- "Enable VLM" -> route to `references/configure/vlm.md`.
- "RAG is unhealthy" -> route to `references/troubleshoot.md`.
- "Stop RAG" -> route to `references/shutdown.md`.

## Limitations

- Operational guidance only applies to this RAG Blueprint repository.
- Live deployment changes require a running Docker, Helm, or library target.
- Secrets such as `NGC_API_KEY` must be supplied by the user environment.

## Troubleshooting

| Error / signal | What to do |
|----------------|------------|
| Services are not running | Follow `references/deploy.md` before configuring features. |
| Restart or health check fails | Follow `references/troubleshoot.md`. |
| User requests teardown | Follow `references/shutdown.md` and confirm destructive cleanup. |

### When User Says "Configure" Without Specifics

Run steps 2–3 above, then read the identified config file to list what's currently enabled:
```bash
grep -E "^(export )?(ENABLE_|APP_)" <config-file> 2>/dev/null | sort
```
Summarize what's running and enabled, then ask which feature to change.

---

## Hardware Restrictions

Read `docs/support-matrix.md` for current GPU requirements per deployment mode.
Read `docs/service-port-gpu-reference.md` for port mappings and GPU assignments.

| GPU | Feature Restrictions |
|-----|---------------------|
| B200 | No VLM, No Guardrails, No Nemotron Parse. May need multi-GPU LLM (`LLM_MS_GPU_ID`). |
| RTX PRO 6000 | No Nemotron Parse. No Audio on Helm. |
