# Agentic RAG

## When to Use
- User wants the LangGraph agentic pipeline/agentic rag, planning/execution, multi-hop reasoning, ambiguity handling, or verification.
- User asks about `agentic`, `ENABLE_AGENTIC_RAG`, agentic streaming, stage events, or agentic reasoning traces.

## Restrictions
- Requires `use_knowledge_base=true`; otherwise the agentic path is not applied.
- Higher latency and more LLM calls than standard RAG. Prefer per-request enablement for latency-sensitive deployments.
- The agentic path does not use NeMo Guardrails, Self-Reflection, Query Decomposition, or VLM Inference.
- Verification is single-pass.

## Process
1. Detect deployment mode. Docker: edit the active env file. Helm: edit `values.yaml`. Library/API callers can set request fields directly.
2. Read `docs/agentic-rag.md` for the current architecture, env vars, and limitations.
3. Prefer per-request enablement:
   ```json
   {
     "messages": [{"role": "user", "content": "..."}],
     "use_knowledge_base": true,
     "collection_names": ["..."],
     "agentic": true
   }
   ```
4. For API/library clients that omit `agentic`, set `ENABLE_AGENTIC_RAG=true` and restart the RAG server. In the React UI, also select Pipeline → Agentic because the UI sends an explicit per-request value.
5. Optionally configure LLMs:
   - One deployment-wide LLM: set `APP_LLM_MODELNAME`, `APP_LLM_SERVERURL`, and `APP_LLM_APIKEY`; Docker Compose chains each agentic role to these defaults.
   - Role-specific LLMs: set `AGENTIC_PLANNER_LLM_*`, `AGENTIC_TASK_LLM_*`, `AGENTIC_SEED_GEN_LLM_*`, or `AGENTIC_SYNTHESIS_LLM_*`.
   - One request only: pass `model` and/or `llm_endpoint` in `/v1/generate`; the runtime override applies to all agentic roles for that request.
6. Verify with `/v1/generate`: streaming agentic chunks include `event_type`, `stage`, and supplementary `reasoning_content`; final answer text still streams through `content`.

## Decision Table

| Goal | Key Action |
|------|------------|
| Enable only for one query | Set request body `agentic: true` |
| Disable for one query when globally enabled | Set request body `agentic: false` |
| Change deployment default for API clients that omit `agentic` | Set `ENABLE_AGENTIC_RAG=true` or `false` |
| Enable from the RAG UI | Select Pipeline → Agentic; the Standard UI mode sends `agentic: false` |
| Add post-synthesis checking | Set `AGENTIC_VERIFICATION_ENABLED=true` |
| Use the same deployment LLM for every agentic role | Set `APP_LLM_MODELNAME`, `APP_LLM_SERVERURL`, and `APP_LLM_APIKEY` unless role-specific `AGENTIC_*_LLM_*` envs are set |
| Override every agentic role for one API call | Set request body `model` and/or `llm_endpoint` |
| Debug agent stages | Set `AGENTIC_LOG_LEVEL=DEBUG` and inspect streamed `event_type` / `stage` chunks |

## Agent-Specific Notes
- `enable_streaming=true` is the default. Agentic streaming emits stage events (`stage_start`, `stage_end`), intermediate reasoning/output, final answer chunks, agent events, and errors.
- `enable_streaming=false` makes the agent graph finish before returning a full answer chunk; standard RAG always streams.
- The React UI has only Standard and Agentic modes. Standard sends `agentic: false`, so `ENABLE_AGENTIC_RAG=true` alone does not override UI Standard mode.
- In the UI, agentic and standard reasoning traces render in the reasoning panel when the stream includes `reasoning_content`.
- Docker Compose chains `AGENTIC_*_LLM_MODEL`, `AGENTIC_*_LLM_SERVERURL`, and `AGENTIC_*_LLM_APIKEY` through `APP_LLM_MODELNAME`, `APP_LLM_SERVERURL`, and `APP_LLM_APIKEY`, so one standard LLM override propagates to all four agentic roles unless a role-specific value is set.
- Helm values list the role-specific envs explicitly. Keep them aligned with the main LLM values for one shared agentic model, or set per-role values when the planner, task, seed generation, or synthesis roles need different models.
- If a role model is empty in config, the builder falls back to the planner LLM, then the main RAG LLM. API keys fall back through the role config, main RAG LLM config, and the usual NVIDIA-hosted defaults.
- Per-request `/v1/generate` `model` and `llm_endpoint` values override every agentic role for that request; omit the fields to use deployment or role-specific configuration.
- If the result is slow or expensive, use per-request `agentic` instead of a global default, lower `AGENTIC_CONTEXT_MAX_TOKENS`, or leave verification disabled.

## Source Documentation
- `docs/agentic-rag.md` — architecture, API usage, env vars, limitations
- `docs/api-rag.md` — `/v1/generate` request and streaming behavior
- `deploy/compose/docker-compose-rag-server.yaml` — Docker `APP_LLM_*` and `AGENTIC_*_LLM_*` fallback chain
- `src/nvidia_rag/rag_server/agentic_rag/builder.py` — role LLM fallback order and runtime override model
- `frontend/src/hooks/useMessageSubmit.ts` — UI request field behavior for `agentic`
- `frontend/src/hooks/useChatStream.ts` and `frontend/src/components/chat/ReasoningPanel.tsx` — reasoning trace rendering
