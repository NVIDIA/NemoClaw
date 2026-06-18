# Cloud Assets

## Triggers

Use this skill for requests mentioning S3 assets, MinIO, cloud assets, buckets,
remote USD files, `ovstorage`, asset caches, object storage, asset catalogs,
thumbnail grids, or S3 browsing.

ovrtx requires local filesystem paths. Cloud stages must be synced to a local cache that preserves relative directory structure for textures, materials, sublayers, and referenced USD files.

## Architecture

```text
Browser -> ov_web_viewer_server
  -> StorageManager
  -> ovstorage S3 client
  -> S3/MinIO bucket samples_data/
  -> local cache /tmp/ov-stage-cache/samples_data/
  -> renderer.open_usd(local_path) or open_usd_from_string(inline root)
```

The manager connects to S3, syncs the full tree on first load, validates cache by size on later loads, and resolves requested filenames to local cached paths.

## MinIO Setup

```bash
curl -sSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /tmp/minio && chmod +x /tmp/minio
curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /tmp/mc && chmod +x /tmp/mc
mkdir -p /tmp/minio-data
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin /tmp/minio server /tmp/minio-data --address :9000 --console-address :9001 &
/tmp/mc alias set local http://localhost:9000 minioadmin minioadmin
/tmp/mc mb local/ov-viewer-samples
/tmp/mc cp --recursive samples/samples_data/ local/ov-viewer-samples/samples_data/
```

## Dependencies

```bash
pip install ovstorage
pip install "boto3>=1.34"  # optional for generated direct-S3 helpers
```

Use `ovstorage` for the primary authenticated object-storage path. Generate the
viewer-local `StorageManager` wrapper in the app server.

## Config

```python
@dataclass(frozen=True)
class StorageConfig:
    enabled: bool = False
    bucket_url: str = "s3://ov-viewer-samples"
    endpoint_url: str = "http://localhost:9000"
    region: str = "us-east-1"
    addressing_style: str = "path"  # MinIO uses path; AWS often uses virtual
    cache_dir: str = "/tmp/ov-stage-cache"
    prefix: str = "samples_data"

    @classmethod
    def from_env(cls):
        return cls(
            enabled=os.environ.get("OVSTORAGE_ENABLED", "0") == "1",
            bucket_url=os.environ.get("OVSTORAGE_BUCKET_URL", "s3://ov-viewer-samples"),
            endpoint_url=os.environ.get("OVSTORAGE_ENDPOINT_URL", "http://localhost:9000"),
            region=os.environ.get("OVSTORAGE_REGION", "us-east-1"),
            addressing_style=os.environ.get("OVSTORAGE_ADDRESSING", "path"),
            cache_dir=os.environ.get("OVSTORAGE_CACHE_DIR", "/tmp/ov-stage-cache"),
            prefix=os.environ.get("OVSTORAGE_PREFIX", "samples_data"),
        )
```

## Manager Behaviors

```python
class StorageManager:
    def __init__(self, config):
        self.config = config
        self.enabled = config.enabled
        if self.enabled:
            import ovstorage
            self._client = ovstorage.open(config.bucket_url, config=ovstorage.Config(
                s3_endpoint_url=config.endpoint_url,
                s3_region=config.region,
                s3_addressing_style=config.addressing_style,
            ))

    def sync_all(self) -> bool:
        entries = self._client.walk(f"{self.config.prefix}/", max_depth=10)
        files = [e for e in entries if e.kind.value == "file"]
        for entry in files:
            data = self._client.read(entry.relative_path)
            dest = Path(self.config.cache_dir) / entry.relative_path
            if dest.exists() and dest.stat().st_size == len(data):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        return True

    def resolve_or_passthrough(self, path: str) -> str:
        if not self.enabled:
            return path
        self.sync_all()
        return self.resolve_stage(os.path.basename(path))
```

## Server Integration

- Add sibling imports for `storage_config` and `storage_manager`.
- If using dynamic `_import_sibling`, register `sys.modules[name] = mod` before `exec_module`; Python dataclasses need `__module__` resolvable.
- Initialize `StorageManager(StorageConfig.from_env())` in the server.
- In `_load_stage()`, first line should resolve: `url = self._storage.resolve_or_passthrough(url)`.
- Add `--storage` CLI flag and set `OVSTORAGE_ENABLED=1` when present.

## Environment

| Variable | Default |
|---|---|
| `OVSTORAGE_ENABLED` | `0` |
| `OVSTORAGE_BUCKET_URL` | `s3://ov-viewer-samples` |
| `OVSTORAGE_ENDPOINT_URL` | `http://localhost:9000` |
| `OVSTORAGE_REGION` | `us-east-1` |
| `OVSTORAGE_ADDRESSING` | `path` |
| `OVSTORAGE_CACHE_DIR` | `/tmp/ov-stage-cache` |
| `OVSTORAGE_PREFIX` | `samples_data` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | credentials |

Run:

```bash
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin python3 server/ov_web_viewer_server.py --storage --port 49100
```

Expected logs include enabled bucket, sync start, sync counts, and loading from `/tmp/ov-stage-cache/...`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError: ovstorage` | install `ovstorage` in the server environment |
| dataclass `NoneType.__dict__` | register dynamic import in `sys.modules` |
| `0 synced, 0 cached` | check bucket and prefix with `mc ls` |
| missing textures | verify full tree under `$OVSTORAGE_CACHE_DIR/$OVSTORAGE_PREFIX` |
| port conflict 49100 | stop old viewer or use another port |

## Public S3 Asset Browsing

For browsing NVIDIA content buckets that need no credentials, use direct HTTPS
listing:

### Bucket Discovery

List objects under a prefix using the S3 REST XML API:

```python
import xml.etree.ElementTree as ET
import urllib.request
import urllib.parse

S3_BUCKET = "omniverse-content-production"
S3_BASE_URL = f"https://{S3_BUCKET}.s3.us-west-2.amazonaws.com"

def list_objects(prefix: str, delimiter: str = "/", max_keys: int = 1000) -> tuple[list[str], list[str]]:
    """List object keys and common prefixes (subdirectories) under a prefix."""
    params = urllib.parse.urlencode({
        "list-type": "2",
        "prefix": prefix,
        "delimiter": delimiter,
        "max-keys": str(max_keys),
    })
    url = f"{S3_BASE_URL}?{params}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        tree = ET.fromstring(resp.read())
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    keys = [c.text for c in tree.findall(".//s3:Key", ns) if c.text]
    prefixes = [c.text for c in tree.findall(".//s3:CommonPrefixes/s3:Prefix", ns) if c.text]
    return keys, prefixes
```

### Asset Catalog & Manifest

Many NVIDIA content buckets include manifest files (`manifest.json`, `index.json`, `catalog.json`) at category roots. Check for these first — they list assets with metadata (name, path, tags, description) without needing full prefix enumeration:

```python
MANIFEST_NAMES = ["manifest.json", "index.json", "catalog.json", "assets.json"]

def try_load_manifest(prefix: str) -> Optional[list[dict]]:
    for name in MANIFEST_NAMES:
        url = f"{S3_BASE_URL}/{urllib.parse.quote(prefix + name, safe='/')}"
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                return json.loads(resp.read())
        except Exception:
            continue
    return None
```

Fall back to prefix listing when no manifest exists.

### Thumbnail Loading

Thumbnails live alongside USD files (commonly `.png` or `.jpg` with matching stem, or in a `thumbnails/` subdirectory). Load them lazily in background threads and cache locally:

```python
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

THUMBNAIL_EXTS = [".png", ".jpg", ".jpeg", ".webp"]

def find_thumbnail_key(usd_key: str, available_keys: list[str]) -> Optional[str]:
    stem = PurePosixPath(usd_key).stem
    parent = str(PurePosixPath(usd_key).parent)
    candidates = [
        f"{parent}/{stem}{ext}" for ext in THUMBNAIL_EXTS
    ] + [
        f"{parent}/thumbnails/{stem}{ext}" for ext in THUMBNAIL_EXTS
    ]
    for c in candidates:
        if c in available_keys:
            return c
    return None

def download_thumbnail(url: str, cache_path: Path, timeout: float = 10.0) -> Optional[Path]:
    if cache_path.exists():
        return cache_path
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(url, str(cache_path))
        return cache_path
    except Exception:
        return None
```

Use a thread pool (4-8 workers) for concurrent thumbnail downloads. Decode and scale images off the UI thread.

### Category Structure

Organize assets by S3 prefix hierarchy. Common prefix = category name:

```python
from pathlib import PurePosixPath

def categorize_assets(keys: list[str], base_prefix: str) -> dict[str, list[str]]:
    categories: dict[str, list[str]] = {}
    for key in keys:
        if not any(key.endswith(ext) for ext in [".usd", ".usda", ".usdc"]):
            continue
        rel = PurePosixPath(key).relative_to(PurePosixPath(base_prefix))
        cat = str(rel.parent) if rel.parent != PurePosixPath(".") else "General"
        categories.setdefault(cat, []).append(key)
    return categories
```

### Local Cache Strategy

Cache downloaded assets preserving the S3 key structure so relative USD references (textures, sublayers) resolve correctly:

```python
def cache_path_for_key(key: str, cache_root: Path) -> Path:
    return cache_root / key

def download_asset_tree(usd_key: str, cache_root: Path) -> Path:
    """Download the USD file and its directory siblings (textures, materials)."""
    parent_prefix = str(PurePosixPath(usd_key).parent) + "/"
    sibling_keys, _ = list_objects(parent_prefix, delimiter="")
    for k in sibling_keys:
        dest = cache_path_for_key(k, cache_root)
        if not dest.exists():
            url = f"{S3_BASE_URL}/{urllib.parse.quote(k, safe='/')}"
            download_thumbnail(url, dest)  # reuse download helper
    return cache_path_for_key(usd_key, cache_root)
```

ovrtx file loads require a local filesystem path, so always resolve through the cache before calling `renderer.open_usd()` or composing an inline root with `open_usd_from_string()`.

## When To Use Direct HTTPS vs S3 API

| Scenario | Approach |
|---|---|
| Public bucket, no credentials, browsing UI | Direct HTTPS (urllib/requests) |
| Private bucket with IAM/credentials | `ovstorage` |
| USD asset resolver behavior | Generate a local resolver/cache wrapper around `ovstorage` |
| Simple file download and cache | Direct HTTPS |
| Full tree sync with change detection | `ovstorage.walk()` + size-based cache validation |

See also: `stage-management`, `stage-loading`, `cloud-deployment`.
