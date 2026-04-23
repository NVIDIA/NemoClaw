# NAT Examples Catalog

All examples live in the `examples/` directory of the NeMo Agent Toolkit repo.

## Running Any Example

```bash
# Install from source first (see install-from-source.md)
uv pip install -e examples/<example_directory>
nat run --config_file examples/<example_directory>/configs/config.yml --input "test"
```

## Example Structure

```
example_name/
├── src/<package_name>/
│   ├── __init__.py
│   ├── register.py          # Component registration
│   └── <component_name>.py  # Implementation
├── configs/config.yml       # Workflow configuration
├── data/                    # Example data (if needed)
└── pyproject.toml
```

## Categories

### Getting Started
- **simple_web_query** — Basic LangSmith documentation agent with internet search
- **simple_calculator** — Mathematical agent with arithmetic and time tools

### Agents
- **react** — ReAct (Reasoning and Acting) agent
- **rewoo** — ReWOO (Reasoning WithOut Observation) pattern
- **tool_calling** — Direct function invocation agent
- **auto_memory_wrapper** — Automatic memory capture agent

### Advanced Agents
- **alert_triage_agent** — Production-ready alert triage with LangGraph
- **mixture_of_agents** — Multi-agent with ReAct coordinating specialized tools

### Control Flow
- **router_agent** — Routes requests to appropriate branches
- **sequential_executor** — Linear tool execution pipeline
- **parallel_executor** — Concurrent fan-out/fan-in stages

### Frameworks
- **langchain_deep_research** — LangGraph agents with NAT
- **multi_frameworks** — Supervisor coordinating LangChain, LlamaIndex, Haystack
- **semantic_kernel_demo** — Travel planning with Microsoft Semantic Kernel

### MCP / A2A
- **simple_calculator_mcp** — End-to-end MCP workflow (client + server)
- **simple_calculator_mcp_protected** — OAuth2-protected MCP workflow
- **currency_agent_a2a** — A2A client connecting to third-party services
- **math_assistant_a2a** — End-to-end A2A workflow

### Evaluation / Profiling / Finetuning
- **email_phishing_analyzer** — Evaluation and profiling configs
- **dpo_tic_tac_toe** — DPO training using Test-Time Compute
- **rl_with_openpipe_art** — Reinforcement learning with OpenPipe ART

### Other Categories
- Components, Custom Functions, Front Ends, Memory, Object Store, Human-in-the-Loop, UI

## Using Examples as Starting Points

1. Copy the example directory
2. Update `pyproject.toml` with your package name
3. Modify `configs/config.yml` for your tools, LLMs, parameters
4. Update source in `src/` as needed
5. Install with `uv pip install -e .` and run with `nat run`
