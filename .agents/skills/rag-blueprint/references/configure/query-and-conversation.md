# Query Rewriting, Query Decomposition, and Multi-Turn

Use these features when the user wants follow-up questions, conversation-aware retrieval, query rewriting, or decomposition of complex questions. For LangGraph agent planning/execution, use `agentic-rag.md` instead.

## When to Use
- Enable multi-turn conversations or support follow-up questions.
- Improve retrieval with query rewriting.
- Break complex multi-hop questions into smaller retrieval subqueries.
- Configure or debug conversation history behavior.

## Restrictions
- Query rewriting and multi-turn both require `CONVERSATION_HISTORY > 0`; with `0`, query rewriting has no effect.
- Query decomposition works only when `use_knowledge_base=true` and with a single collection.
- Query decomposition is separate from Agentic RAG; do not enable both without reading `docs/agentic-rag.md` and `docs/query_decomposition.md` limitations.

## Dependencies

| Setting | Depends on | Side effect when changed |
|---------|------------|--------------------------|
| `ENABLE_QUERYREWRITER` | `CONVERSATION_HISTORY > 0` | Enabling requires conversation history; disabling has no side effects |
| `CONVERSATION_HISTORY` | — | Setting to `0` also effectively disables query rewriting |

## Process
1. Detect deployment mode. Docker: edit the active env file. Helm: edit `values.yaml`. Library: edit `notebooks/config.yaml`.
2. Read the source doc for the feature.
3. Apply config changes and restart the RAG server.
4. Verify with a follow-up or multi-hop query against a known collection.

### Query Rewriting
1. Read `docs/multiturn.md` for full configuration details.
2. To enable, set `ENABLE_QUERYREWRITER=True`. If `CONVERSATION_HISTORY=0`, set it to `5` or another positive value.
3. To disable, unset or comment out `ENABLE_QUERYREWRITER`.
4. Optional per request: set `enable_query_rewriting: true` in `POST /v1/generate`; `CONVERSATION_HISTORY` must still be positive.

### Multi-Turn
1. Read `docs/multiturn.md` for retrieval strategies and API usage.
2. To enable, set `CONVERSATION_HISTORY > 0` and choose the retrieval strategy.
3. To disable, set `CONVERSATION_HISTORY=0`.

### Query Decomposition
1. Read `docs/query_decomposition.md` for the algorithm, limitations, and examples.
2. Set `ENABLE_QUERY_DECOMPOSITION=true` and `MAX_RECURSION_DEPTH=3` or another depth that fits the use case.

## Decision Table

| Goal | Source Doc | Key Settings |
|------|------------|--------------|
| Multi-turn with best accuracy | `docs/multiturn.md` | `CONVERSATION_HISTORY=5`, `ENABLE_QUERYREWRITER=True` |
| Multi-turn with low latency | `docs/multiturn.md` | `CONVERSATION_HISTORY=5`, `MULTITURN_RETRIEVER_SIMPLE=True` |
| Complex multi-hop decomposition | `docs/query_decomposition.md` | `ENABLE_QUERY_DECOMPOSITION=true`, `MAX_RECURSION_DEPTH=3` |
| Agent planning/execution | `docs/agentic-rag.md` | Use `references/configure/agentic-rag.md` |
| Disable multi-turn | — | `CONVERSATION_HISTORY=0` |

## Agent-Specific Notes
- `MULTITURN_RETRIEVER_SIMPLE` only applies when query rewriting is disabled; query rewriting takes precedence if both are configured.
- Query decomposition adds latency and is most useful for multi-hop questions that involve multiple entities or steps.
- In library mode, configure these settings in `notebooks/config.yaml` instead of environment variables.

## Notebooks
- `notebooks/retriever_api_usage.ipynb` — RAG retriever API usage with search and end-to-end query examples.

## Source Documentation
- `docs/query_decomposition.md` — decomposition algorithm and recursion depth guidance
- `docs/multiturn.md` — conversation history behavior, retrieval strategies, API usage, Helm configuration
- `docs/agentic-rag.md` — separate LangGraph agentic pipeline
