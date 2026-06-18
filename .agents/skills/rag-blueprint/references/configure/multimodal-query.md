# Multimodal Query (Image + Text)

## When to Use
- User wants to query knowledge base with images and text together
- User asks about VLM (Vision Language Model) deployment for RAG
- User wants image-based document understanding or visual Q&A

## Restrictions
- Reranker must be disabled (`ENABLE_RERANKER=false`)
- On-prem: requires NVIDIA H100 or A100 SXM 80GB GPU
- Single-page retrieval only — image queries return content from one page per document

## Process
1. Detect the deployment mode (Docker / Helm / Library). Docker: edit the active env file. Helm: edit `values.yaml`. Library: edit `notebooks/config.yaml`
2. Read `docs/multimodal-query.md` for full env var configuration and commands
3. Choose variant: self-hosted (Docker), NVIDIA-hosted (cloud), or Helm
4. Deploy VLM + VLM Embedding NIMs per source doc instructions
5. Set VLM env vars in the active config and switch embedding model to VLM embedding
6. Restart ingestor + RAG server (Docker: add `--build` flag) and verify

## Agent-Specific Notes
- Must select a collection before querying — queries without collection return no results
- First VLM deployment: model downloads take 10–20 min (~10GB+)
- `VLM_MS_GPU_ID` — read `docs/service-port-gpu-reference.md` for the default GPU assignment and override if needed
- Cloud rate limits apply for ingestion of >10 files
- NVIDIA-hosted VLM endpoints should include the `/v1` suffix, e.g. `https://integrate.api.nvidia.com/v1`
- For Helm with MIG: ensure dedicated MIG slice is assigned to VLM
- Image extraction must be enabled: `APP_NVINGEST_EXTRACTIMAGES=True`, `APP_NVINGEST_IMAGE_ELEMENTS_MODALITY=image`
- Helm multimodal deployments that disable `nim-llm` must set summary env vars under `ingestor-server.envVars` when `generate_summary=true`

## Notebooks
- `notebooks/image_input.ipynb` — end-to-end multimodal query examples, image upload, VLM querying

## Source Documentation
- `docs/multimodal-query.md` — full Docker/cloud/Helm configuration, env vars, API usage, limitations
