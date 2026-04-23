# Creating Custom Tools in NAT

## Generate Template

```bash
nat workflow create --workflow-dir examples my_custom_tool
```

This creates:

```
my_custom_tool/
├── src/my_custom_tool/
│   ├── __init__.py
│   ├── register.py              # Component registration
│   └── my_custom_tool_function.py  # Implementation
├── configs/config.yml           # Workflow configuration
└── pyproject.toml               # Dependencies
```

## Function Characteristics

- **Type Safety**: Python type annotations for input/output validation
- **Dual Output**: `ainvoke()` for single output, `astream()` for streaming
- **Schemas**: Input/output schemas via Pydantic BaseModel
- **Asynchronous**: All operations are async
- **Composability**: Functions can be used as tools for other functions/agents

## Basic Function Structure

```python
from nemo_agent_toolkit.functions import FunctionBaseConfig
from nemo_agent_toolkit.components import EmbedderRef
from nemo_agent_toolkit.functions import register_function
from nemo_agent_toolkit.utils import LLMFrameworkEnum

class MyCustomToolConfig(FunctionBaseConfig, name="my_custom_tool"):
    param1: str
    param2: int = 10
    embedder_name: EmbedderRef = "nvidia/nv-embedqa-e5-v5"

@register_function(config_type=MyCustomToolConfig)
async def my_custom_tool_function(config: MyCustomToolConfig, builder: Builder):
    # Access other components via builder:
    # embeddings = await builder.get_embedder(config.embedder_name)
    # llm = await builder.get_llm(config.llm_name)

    async def _inner(input_param: str) -> str:
        return f"Processed: {input_param}"

    yield FunctionInfo.from_fn(_inner, description="Description of what your tool does")
```

## Install and Use

```bash
uv pip install -e examples/my_custom_tool
nat run --config_file examples/my_custom_tool/configs/config.yml --input "test"
```

## Adding Tools to Existing Workflows

### Quick override (no YAML edit)

```bash
nat run --config_file workflow.yml --input "query" \
  --override functions.webpage_query.webpage_url https://example.com/docs
```

### Permanent change

1. Add the tool in the `functions` section of workflow YAML
2. Add the tool name to `workflow.tool_names`
3. Run with updated config

### Example: Adding webpage queries

```yaml
functions:
  docs_query:
    _type: webpage_query
    webpage_url: https://docs.example.com
    description: "Search documentation"
    embedder_name: nv-embedqa-e5-v5
    chunk_size: 512
  current_datetime:
    _type: current_datetime

workflow:
  _type: react_agent
  tool_names: [docs_query, current_datetime]
  llm_name: nim_llm
  verbose: true
```
