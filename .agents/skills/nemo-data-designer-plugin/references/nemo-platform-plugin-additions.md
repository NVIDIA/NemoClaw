# NeMo Plugin Additions

This skill ships in the NeMo Platform data-designer plugin. The CLI surface is `nemo data-designer …`. Most subcommands accept the same arguments as the upstream `data-designer` CLI; the differences are documented below.

## `validate`: local + remote contexts

Upstream `data-designer validate` runs a local-only engine compile check. The plugin's `validate` does that **and** verifies the config against NeMo Platform-specific constraints — Inference Gateway provider resolution, Files-service seed sources, Nemotron Personas filesets, the remote seed-type whitelist, etc.

By default it reports both contexts independently:

```bash
nemo data-designer validate <path>
```

```text
Local execution
  ✔ Configuration is valid

Remote execution
  ✘ Seed source 'df' is not supported on the NeMo Platform.
    Use a serializable seed source such as a HuggingFace dataset
    or the Files service.

Result: valid for local execution; invalid for remote execution
```

A single invocation surfaces **every** problem it can detect (it doesn't short-circuit on the first failure). Exit code is 0 only when every reported context validates cleanly.

Useful flags:

- `--execution-context {local,remote}` — limit the report to one context. Omit to validate both.
- `--workspace <name>` — workspace used to resolve Inference Gateway providers and Files-service seed sources for the remote pass. Defaults to the SDK's configured workspace.
- `--output {text,json}` — `json` emits a structured `ValidationReport` for CI / scripting use.

Treat a "valid for local; invalid for remote" mixed result as **safe to proceed with `preview run` / `create run`**. Only the remote pass needs to pass before the user runs `preview submit` / `create submit`. If the user is iterating locally and the remote diagnostic is a true blocker (e.g., they intend to submit later), report it but don't loop on re-validation until they ask to.

Configs that reference Inference Gateway providers exclusively (no locally-defined providers) are first-class — they validate cleanly under both contexts as long as the provider names resolve via `nemo inference providers list`.

## `preview` and `create`: local vs cluster

Upstream's `preview` and `create` are flat commands that take the config path positional directly. In the plugin, both are command groups with two execution modes:

- `nemo data-designer preview run <path> [flags]` — local in-process execution. Use this in the standard skill workflow.
- `nemo data-designer preview submit <path> [flags]` — submit to a NeMo Platform cluster over HTTP. Use only when the user explicitly asks for cluster execution.
- `nemo data-designer create run <path> [flags]` — local in-process generation.
- `nemo data-designer create submit <path> [flags]` — cluster submission (also supports `--profile <profile>`).

Default to `run` for the iterative preview-and-iterate workflow; reach for `submit` only when the user calls it out (e.g., "submit on the cluster", "run this on the platform"). The args after `run` / `submit` match upstream's `preview` / `create` args.

## Model configs

The upstream skill assumes model aliases come from a YAML registry under `~/.data-designer/`, populated via `nemo data-designer config models` / `nemo data-designer config providers`. In this plugin you have two additional sources, and either is a first-class option — `agent context` does **not** see them.

**Declare `ModelConfig`s programmatically in the script.** `DataDesignerConfigBuilder` accepts model configs directly, either via its constructor or `.add_model_config(...)`:

```python
import data_designer.config as dd

def load_config_builder() -> dd.DataDesignerConfigBuilder:
    config_builder = dd.DataDesignerConfigBuilder(
        model_configs=[
            dd.ModelConfig(
                alias="text",
                model="...",
                provider="default/nvidia-build",
                inference_parameters=dd.ChatCompletionInferenceParams(),
            ),
        ],
    )
    ...
```

Pick the right `inference_parameters` class for the generation type: `ChatCompletionInferenceParams`, `EmbeddingInferenceParams`, or `ImageInferenceParams`. The class determines the alias's `generation_type` and which column types can use it.

**Reference an Inference Gateway-managed model provider.** `ModelConfig.provider` may be a bare provider name (resolved in the active workspace) or `<workspace>/<provider>`. The plugin's request handler resolves local providers first, then falls back to looking up the name via the Inference Gateway, so the same `ModelConfig` works whether the user has local providers configured or not.

Discover available Inference Gateway providers with `nemo inference providers list`. A common default created during `nemo setup` is `default/nvidia-build`, but it's optional — confirm before relying on it. If the user mentions a provider by name (e.g., "use my-vllm"), trust the name and let the registry surface a clear error at preview time if it isn't reachable.

**Default to programmatic declaration with an Inference Gateway provider.** It's the portable path: declaring `model_configs` in the script works for both local `run` and cluster `submit`, whereas relying on the local YAML registry only works for `run`. Most plugin workflows iterate locally before submitting, so the portable path saves a rewrite later.

When using an Inference Gateway provider, the `model` field in the `dd.ModelConfig` should use the `served_model_name` as understood by Inference Gateway, not the `model_entity_id`.

If `agent context` shows no usable aliases, that is **not** a blocker — it only means the local YAML registry is unconfigured. Fall back to local YAML aliases only when the user has explicitly configured them and asks for that path.

## Personas

The plugin adds a `personas` command group on top of upstream Data Designer. Use it to install Nemotron Personas locales locally and to publish them as NeMo Platform filesets so cluster-side jobs can read them.

**Install one or more locales locally**:

```bash
# List available locales and their sizes
nemo data-designer personas download --list

# Interactive selection
nemo data-designer personas download

# Specific locales
nemo data-designer personas download --locale en_US --locale ja_JP

# All locales
nemo data-designer personas download --all
```

Locales download to `~/.data-designer/managed-assets/datasets/`, which is also the path the `"person"` sampler reads from. After installing, `references/person-sampling.md` covers the general column-usage flow without modification — the plugin doesn't change how persona columns work.

**Publish a locale as a NeMo Platform fileset** (so NeMo Platform-side jobs that need persona data can read it):

```bash
nemo data-designer personas make-fileset \
  --locale en_US \
  --api-key-secret <workspace>/<secret-name>
```

Requires an NGC API key secret already registered in NeMo Platform. To create the secret in the same call, add `--api-key-env-var <ENV_VAR>` and set that env var to the API key value before running.

## Related NeMo Platform commands

When the user already has NeMo Platform-side resources configured, prefer pointing them at those rather than the local Data Designer config:

- `nemo inference providers list` / `nemo models list` — NeMo Platform-side inference providers and models.
- `nemo secrets` — manage API keys used by `personas make-fileset` and other NeMo Platform-side flows.
- `nemo files` — manage filesets, including persona filesets created above.

These are alternatives to the local `~/.data-designer/` configuration the upstream skill assumes; both work, and which to use depends on whether the user is iterating locally or running on a cluster.
