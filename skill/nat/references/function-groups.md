# Function Groups in NAT

Function groups package multiple related functions together so they share configuration, context, and resources.

## When to Use

Use function groups when you have:
- Multiple functions needing the same DB connection, API client, or cache
- Related operations sharing config (credentials, endpoints, timeouts)
- A family of functions that benefit from namespacing (CRUD, math)
- Functions that need to share state or context

Use individual functions when each is independent with no shared resources.

## Writing a Function Group

### 1. Define Config

```python
from nemo_agent_toolkit.functions import FunctionGroupBaseConfig
from pydantic import Field

class ObjectStoreConfig(FunctionGroupBaseConfig, name="object_store"):
    endpoint: str = Field(description="S3 endpoint URL")
    access_key: str = Field(description="S3 access key")
    secret_key: str = Field(description="S3 secret key")
    bucket: str = Field(description="S3 bucket name")
```

### 2. Implement Builder

```python
from nemo_agent_toolkit.functions import register_function_group
from nemo_agent_toolkit.data_models.function import FunctionGroup

@register_function_group(config_type=ObjectStoreConfig)
async def build_object_store(config: ObjectStoreConfig, builder: Builder):
    s3_client = boto3.client('s3',
        endpoint_url=config.endpoint,
        aws_access_key_id=config.access_key,
        aws_secret_access_key=config.secret_key
    )

    group = FunctionGroup(config=config, instance_name="storage")

    async def save_fn(filename: str, content: bytes) -> str:
        s3_client.put_object(Bucket=config.bucket, Key=filename, Body=content)
        return f"Saved {filename}"

    async def load_fn(filename: str) -> bytes:
        response = s3_client.get_object(Bucket=config.bucket, Key=filename)
        return response['Body'].read()

    group.add_function(name="save", fn=save_fn, description="Save file to storage")
    group.add_function(name="load", fn=load_fn, description="Load file from storage")

    yield group
```

## YAML Configuration

```yaml
function_groups:
  storage:
    _type: object_store
    endpoint: "https://s3.amazonaws.com"
    access_key: "${S3_ACCESS_KEY}"
    secret_key: "${S3_SECRET_KEY}"
    bucket: "my-bucket"

workflow:
  _type: react_agent
  tool_names: [storage]  # All functions in group
  llm_name: my_llm
```

## Namespacing

Functions are auto-namespaced: `instance_name__function_name`

Example: group `storage` with functions `save`, `load` produces `storage__save`, `storage__load`.

## include / exclude (Mutually Exclusive)

```yaml
# Only expose specific functions
function_groups:
  math:
    _type: math_group
    include: [add, multiply]

# Hide specific functions from agents
function_groups:
  math:
    _type: math_group
    exclude: [divide]
```

### Access Levels

| Configuration | Programmatic | Global Registry | Agent Tools |
|---|---|---|---|
| No include/exclude | All | No | All |
| `include: [add]` | All | Only `add` | Only `add` |
| `exclude: [divide]` | All | No | All except `divide` |

## Programmatic Access

```python
storage_group = await builder.get_function_group("storage")
all_fns = await storage_group.get_all_functions()
save_fn = await storage_group.get_function("save")
result = await save_fn.ainvoke("test.txt", b"content")
```
