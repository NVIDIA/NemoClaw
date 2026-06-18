# References

Reference files for the `vss-deploy-video-embedding` skill (VSS 3.2 GA Video Embedding microservice, legacy name RT-Embed).

| File | Description | When to read |
|---|---|---|
| [deploy-vss-deploy-video-embedding.md](deploy-vss-deploy-video-embedding.md) | Build Vision Agent deployment reference: container image, GPU/CPU/memory, storage, startup behavior, known deployment issues, prerequisites, verify/teardown commands. | When deploying, sizing, upgrading, or tearing down the service. |
| [integrate-vss-deploy-video-embedding.md](integrate-vss-deploy-video-embedding.md) | Build Vision Agent integration reference: peer services, inputs/outputs, environment variables, network requirements, integration constraints, example Compose snippet. | When wiring the service into a VSS deployment or another microservice's workflow. |
| [rest-api.md](rest-api.md) | Full REST endpoint catalog grouped by tag, with worked `curl` examples for uploads, text/video embeddings, live RTSP streams, health, and metrics. | When calling the API or building a client. |
| [environment.md](environment.md) | Complete environment-variable matrix, host-to-container rewrites, volume override variables, and the list of secret-sensitive variables. | When wiring `.env` files, configuring orchestrators, or tuning the runtime. |
| [troubleshooting.md](troubleshooting.md) | Operational diagnostics tables for startup, model/cache, runtime, and observability problems. | When `/v1/ready` is stuck, embeddings fail, or caches misbehave. |
