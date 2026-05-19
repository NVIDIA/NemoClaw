# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
NemoClaw plugin for Hermes Agent.

Provides sandbox status tools, skill hot-reload, managed-tool broker patches,
and quiet runtime grounding when Hermes runs inside an OpenShell sandbox
managed by NemoClaw.

Skill hot-reload: Hermes caches its skill slash-command registry in a
module-global dict on first scan. New skills dropped on disk are invisible
until the cache is cleared. This plugin provides a nemoclaw_reload_skills
tool that clears the cache and re-scans, letting the agent pick up new
skills without a gateway restart. The on_session_start hook also refreshes
skills automatically at session boundaries.

Runtime grounding: earlier versions injected a visible startup banner, but
Hermes TUI renders plugin-injected messages through the interrupt queue. This
plugin now uses Hermes' pre_llm_call context hook so the model sees the
NemoClaw sandbox/tool-execution topology without leaking visual noise into the
chat transcript.
"""

import atexit
import ipaddress
import json
import os
import subprocess
import sys
from dataclasses import replace as dataclass_replace
from types import SimpleNamespace
from urllib.parse import urlparse, urlunparse

import yaml

_BROKER_PATCH_ATTR = "_nemoclaw_tool_gateway_broker_patch_installed"
_AUDIO_GATEWAY_PREFERENCE_PATCH_ATTR = "_nemoclaw_audio_gateway_preference_patch_installed"
_TRANSCRIPTION_GATEWAY_PATCH_ATTR = "_nemoclaw_transcription_gateway_patch_installed"
_FAL_QUEUE_HANDLE_PATCH_ATTR = "_nemoclaw_fal_queue_handle_patch_installed"
_FIRECRAWL_PATH_PATCH_ATTR = "_nemoclaw_firecrawl_path_patch_installed"
_URL_SAFETY_PATCH_ATTR = "_nemoclaw_broker_url_safety_patch_installed"
_BROWSER_CDP_TUNNEL_PATCH_ATTR = "_nemoclaw_browser_use_cdp_tunnel_patch_installed"
_BROWSER_SESSION_STATE_PATCH_ATTR = "_nemoclaw_browser_use_session_state_patch_installed"
_BROWSER_USE_CDP_TUNNELS = {}

_TOOL_GATEWAY_URL_ENV = {
    "firecrawl": "FIRECRAWL_GATEWAY_URL",
    "fal-queue": "FAL_QUEUE_GATEWAY_URL",
    "openai-audio": "OPENAI_AUDIO_GATEWAY_URL",
    "browser-use": "BROWSER_USE_GATEWAY_URL",
    "modal": "MODAL_GATEWAY_URL",
}

_NEMOCLAW_CONTEXT_KEYWORDS = (
    "browser",
    "config",
    "discord",
    "environment",
    "gateway",
    "hermes",
    "host",
    "logs",
    "modal",
    "nemoclaw",
    "openshell",
    "sandbox",
    "skill",
    "slack",
    "status",
    "telegram",
    "tool",
    "where am i",
    "whoami",
)

_BROKER_ALWAYS_BLOCKED_HOSTNAMES = {
    "localhost",
    "metadata.google.internal",
    "metadata.goog",
}
_BROKER_ALWAYS_BLOCKED_SUFFIXES = (
    ".internal",
    ".lan",
    ".local",
    ".localhost",
)
_BROKER_ALWAYS_BLOCKED_IPS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("169.254.170.2"),
    ipaddress.ip_address("169.254.169.253"),
    ipaddress.ip_address("fd00:ec2::254"),
    ipaddress.ip_address("100.100.100.200"),
}
_BROKER_CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def _get_env_value(key, default=None):
    """Read env from os.environ, then Hermes' dotenv-aware config loader."""
    value = os.getenv(key)
    if value is not None:
        return value

    try:
        from hermes_cli.config import get_env_value

        value = get_env_value(key)
        if value is not None:
            return value
    except Exception:
        # Hermes may load this plugin before hermes_cli.config is importable.
        pass

    env_paths = []
    hermes_home = os.getenv("HERMES_HOME")
    if hermes_home:
        env_paths.append(os.path.join(hermes_home, ".env"))
    env_paths.extend(
        [
            "/sandbox/.hermes-data/.env",
            "/sandbox/.hermes/.env",
            os.path.expanduser("~/.hermes/.env"),
        ],
    )

    for env_path in env_paths:
        if not env_path or not os.path.exists(env_path):
            continue
        try:
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    stripped = line.strip()
                    if not stripped or stripped.startswith("#") or "=" not in stripped:
                        continue
                    name, raw = stripped.split("=", 1)
                    if name == key:
                        return raw.strip().strip('"').strip("'")
        except Exception:
            continue

    return default


def _load_hermes_dotenv():
    """Populate os.environ from Hermes .env when this plugin is loaded cold."""
    try:
        from hermes_cli.env_loader import load_hermes_dotenv

        hermes_home = os.getenv("HERMES_HOME")
        if not hermes_home and os.path.isdir("/sandbox/.hermes-data"):
            hermes_home = "/sandbox/.hermes-data"
        load_hermes_dotenv(hermes_home=hermes_home)
    except Exception:
        # Runtime env still works when Hermes' optional dotenv loader is absent.
        pass


def _broker_mode_enabled():
    return _get_env_value("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER") == "1"


def _broker_gateway_url(vendor):
    """Resolve a managed tool gateway URL without requiring sandbox OAuth."""
    vendor = str(vendor or "").strip()
    env_key = _TOOL_GATEWAY_URL_ENV.get(vendor, f"{vendor.upper().replace('-', '_')}_GATEWAY_URL")
    explicit = (_get_env_value(env_key, "") or "").strip().rstrip("/")
    if explicit:
        return explicit

    scheme = (_get_env_value("TOOL_GATEWAY_SCHEME", "https") or "https").strip().lower()
    if scheme not in {"http", "https"}:
        scheme = "https"
    domain = (_get_env_value("TOOL_GATEWAY_DOMAIN", "") or "").strip().strip("/")
    if domain:
        return f"{scheme}://{vendor}-gateway.{domain}"
    return f"{scheme}://{vendor}-gateway.nousresearch.com"


def _broker_user_token():
    token = _get_env_value("TOOL_GATEWAY_USER_TOKEN", "")
    return token.strip() if isinstance(token, str) and token.strip() else None


def _broker_resolve_managed_tool_gateway(vendor, gateway_builder=None, token_reader=None):
    if not _broker_mode_enabled():
        return None
    resolved_gateway_builder = gateway_builder or _broker_gateway_url
    resolved_token_reader = token_reader or _broker_user_token
    gateway_origin = str(resolved_gateway_builder(vendor) or "").strip().rstrip("/")
    nous_user_token = str(resolved_token_reader() or "").strip()
    if not gateway_origin or not nous_user_token:
        return None
    return SimpleNamespace(
        vendor=vendor,
        gateway_origin=gateway_origin,
        nous_user_token=nous_user_token,
        managed_mode=True,
    )


def _config_prefers_gateway(section_name):
    try:
        from hermes_cli.config import load_config

        section = (load_config() or {}).get(section_name)
        return isinstance(section, dict) and bool(section.get("use_gateway"))
    except Exception:
        return False


def _broker_safe_url(url):
    """DNS-independent URL preflight for managed gateway mode.

    Hermes' normal SSRF guard performs sandbox-local DNS resolution and fails
    closed on DNS errors. In NemoClaw broker mode the sandbox never connects to
    the target URL directly; it sends the URL to a host broker and the Nous
    managed gateway enforces upstream egress. This guard keeps cheap local
    protection for obvious metadata/private literal targets while allowing
    normal DNS hostnames through even when sandbox DNS is unavailable.
    """
    try:
        parsed = urlparse(str(url or ""))
        scheme = (parsed.scheme or "").lower()
        hostname = (parsed.hostname or "").strip().lower().rstrip(".")
        if scheme not in {"http", "https"} or not hostname:
            return False
        if hostname in _BROKER_ALWAYS_BLOCKED_HOSTNAMES or hostname.endswith(
            _BROKER_ALWAYS_BLOCKED_SUFFIXES,
        ):
            return False
        try:
            ip = ipaddress.ip_address(hostname)
        except ValueError:
            labels = hostname.split(".")
            if len(labels) < 2:
                return False
            if all(label.isdigit() for label in labels):
                return False
            return True
        if ip in _BROKER_ALWAYS_BLOCKED_IPS:
            return False
        if ip.version == 4 and ip in _BROKER_CGNAT_NETWORK:
            return False
        return not (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        )
    except Exception:
        return False


def _install_broker_url_safety_patch():
    """Avoid sandbox-DNS SSRF false negatives for brokered web/browser tools."""
    if not _broker_mode_enabled():
        return False

    patched = False
    try:
        module = __import__("tools.url_safety", fromlist=["is_safe_url"])
        if not getattr(module, _URL_SAFETY_PATCH_ATTR, False):
            module.is_safe_url = _broker_safe_url
            setattr(module, _URL_SAFETY_PATCH_ATTR, True)
            patched = True
    except Exception:
        # Some Hermes builds do not ship web URL-safety helpers.
        pass

    web_tools = sys.modules.get("tools.web_tools")
    if web_tools is not None and hasattr(web_tools, "is_safe_url"):
        setattr(web_tools, "is_safe_url", _broker_safe_url)
        patched = True

    browser_tool = sys.modules.get("tools.browser_tool")
    if browser_tool is not None and hasattr(browser_tool, "_is_safe_url"):
        setattr(browser_tool, "_is_safe_url", _broker_safe_url)
        if hasattr(browser_tool, "_allow_private_urls_resolved"):
            setattr(browser_tool, "_allow_private_urls_resolved", False)
        patched = True

    return patched


def _patch_loaded_tool_module(module_name, managed_gateway_module=None):
    module = sys.modules.get(module_name)
    if module is None:
        return False

    def _enabled():
        return True

    patched = False
    if hasattr(module, "managed_nous_tools_enabled"):
        setattr(module, "managed_nous_tools_enabled", _enabled)
        patched = True
    if hasattr(module, "build_vendor_gateway_url"):
        setattr(module, "build_vendor_gateway_url", _broker_gateway_url)
        patched = True
    if hasattr(module, "_read_nous_access_token"):
        setattr(module, "_read_nous_access_token", _broker_user_token)
        patched = True
    if hasattr(module, "resolve_managed_tool_gateway"):
        setattr(module, "resolve_managed_tool_gateway", _broker_resolve_managed_tool_gateway)
        patched = True
    return patched


def _install_audio_gateway_preference_patch():
    """Make OpenAI-audio helper imports prefer the broker in audio gateway mode.

    Hermes transcription currently checks direct OpenAI env keys before trying
    the managed OpenAI-audio gateway. NemoClaw may also need an OPENAI_API_KEY
    placeholder for a separate inference path, so the audio tools must not
    treat that placeholder as direct voice/STT auth when `stt.use_gateway` or
    `tts.use_gateway` is configured.
    """
    if not _broker_mode_enabled():
        return False

    try:
        module = __import__("tools.tool_backend_helpers", fromlist=["resolve_openai_audio_api_key"])
    except Exception:
        return False

    if not hasattr(module, "resolve_openai_audio_api_key") or getattr(
        module,
        _AUDIO_GATEWAY_PREFERENCE_PATCH_ATTR,
        False,
    ):
        return False

    original = module.resolve_openai_audio_api_key

    def resolve_openai_audio_api_key():
        if _broker_mode_enabled() and (
            _config_prefers_gateway("stt") or _config_prefers_gateway("tts")
        ):
            return ""
        return original()

    module.resolve_openai_audio_api_key = resolve_openai_audio_api_key
    setattr(module, _AUDIO_GATEWAY_PREFERENCE_PATCH_ATTR, True)
    return True


def _managed_openai_audio_client_config(resolve_managed_tool_gateway):
    managed_gateway = _broker_resolve_managed_tool_gateway("openai-audio")
    if managed_gateway is None and callable(resolve_managed_tool_gateway):
        managed_gateway = resolve_managed_tool_gateway("openai-audio")
    if managed_gateway is None:
        return None
    return (
        managed_gateway.nous_user_token,
        f"{managed_gateway.gateway_origin.rstrip('/')}/v1",
    )


def _install_transcription_gateway_patch():
    """Prefer NemoClaw's OpenAI-audio broker for Hermes transcription tools."""
    if not _broker_mode_enabled():
        return False

    try:
        module = __import__("tools.transcription_tools", fromlist=["_resolve_openai_audio_client_config"])
    except Exception:
        return False

    if not hasattr(module, "_resolve_openai_audio_client_config") or getattr(
        module,
        _TRANSCRIPTION_GATEWAY_PATCH_ATTR,
        False,
    ):
        return False

    original = module._resolve_openai_audio_client_config

    def _resolve_openai_audio_client_config():
        if _config_prefers_gateway("stt"):
            try:
                managed_config = _managed_openai_audio_client_config(
                    module.resolve_managed_tool_gateway,
                )
                if managed_config is not None:
                    return managed_config
            except Exception:
                # Fall back to Hermes' native audio config when broker config is incomplete.
                pass
        return original()

    def _has_openai_audio_backend():
        try:
            _resolve_openai_audio_client_config()
            return True
        except ValueError:
            return False

    module._resolve_openai_audio_client_config = _resolve_openai_audio_client_config
    if hasattr(module, "_has_openai_audio_backend"):
        module._has_openai_audio_backend = _has_openai_audio_backend
    setattr(module, _TRANSCRIPTION_GATEWAY_PATCH_ATTR, True)
    return True


def _rewrite_fal_queue_url(url, broker_base):
    parsed = urlparse(str(url or ""))
    broker = urlparse(str(broker_base or "").rstrip("/"))
    if not parsed.scheme or not parsed.netloc or not broker.scheme or not broker.netloc:
        return url
    if parsed.netloc == broker.netloc:
        return url
    if parsed.hostname != "fal-queue-gateway.nousresearch.com":
        return url

    broker_prefix = broker.path.rstrip("/")
    path = parsed.path or "/"
    if broker_prefix and not path.startswith(f"{broker_prefix}/"):
        path = f"{broker_prefix}{path}"
    return urlunparse((broker.scheme, broker.netloc, path, "", parsed.query, parsed.fragment))


def _replace_fal_handle_urls(handle, urls):
    try:
        return dataclass_replace(handle, **urls)
    except Exception:
        # Some handle types are not dataclasses; try constructor replacement next.
        pass

    try:
        return handle.__class__(
            request_id=handle.request_id,
            response_url=urls["response_url"],
            status_url=urls["status_url"],
            cancel_url=urls["cancel_url"],
            client=handle.client,
        )
    except Exception:
        # Fall back to in-place attribute replacement for mutable handle objects.
        pass

    for name, value in urls.items():
        try:
            object.__setattr__(handle, name, value)
        except Exception:
            return handle
    return handle


def _install_fal_queue_handle_patch():
    """Keep FAL queue polling/result URLs on NemoClaw's broker route.

    Hermes submits managed FAL jobs through the configured queue origin, but
    the gateway response can contain absolute status/result URLs for the
    upstream ``fal-queue-gateway.nousresearch.com`` host. The sandbox policy
    intentionally blocks that direct host, so rewrite returned handle URLs back
    to ``http://host.openshell.internal:11436/fal-queue/...`` before
    ``handler.get()`` starts polling.
    """
    if not _broker_mode_enabled():
        return False

    try:
        module = __import__("tools.image_generation_tool", fromlist=["_ManagedFalSyncClient"])
    except Exception:
        return False

    client_cls = getattr(module, "_ManagedFalSyncClient", None)
    if client_cls is None or getattr(client_cls, _FAL_QUEUE_HANDLE_PATCH_ATTR, False):
        return False

    original = client_cls.submit

    def submit(self, *args, **kwargs):
        handle = original(self, *args, **kwargs)
        broker_base = getattr(self, "_queue_url_format", "") or _broker_gateway_url("fal-queue")
        urls = {
            "response_url": _rewrite_fal_queue_url(
                getattr(handle, "response_url", ""),
                broker_base,
            ),
            "status_url": _rewrite_fal_queue_url(getattr(handle, "status_url", ""), broker_base),
            "cancel_url": _rewrite_fal_queue_url(getattr(handle, "cancel_url", ""), broker_base),
        }
        if (
            urls["response_url"] == getattr(handle, "response_url", None)
            and urls["status_url"] == getattr(handle, "status_url", None)
            and urls["cancel_url"] == getattr(handle, "cancel_url", None)
        ):
            return handle
        return _replace_fal_handle_urls(handle, urls)

    client_cls.submit = submit
    setattr(client_cls, _FAL_QUEUE_HANDLE_PATCH_ATTR, True)
    return True


_BROWSER_USE_CDP_TUNNEL_SCRIPT = r"""
import base64
import os
import select
import socket
import ssl
import sys
import threading
import time
from urllib.parse import urlparse

remote_url = sys.argv[1]
remote = urlparse(remote_url)
proxy = urlparse(os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "")
if remote.scheme != "wss" or not remote.hostname or not proxy.hostname:
    raise SystemExit(2)

target_host = remote.hostname
target_port = remote.port or 443
target_path = remote.path or "/"
if remote.query:
    target_path += "?" + remote.query
proxy_port = proxy.port or 8080
idle_timeout = int(os.environ.get("NEMOCLAW_CDP_TUNNEL_IDLE_SECONDS", "600"))
last_activity = time.monotonic()


def _read_headers(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            break
        data += chunk
        if len(data) > 262144:
            raise OSError("header too large")
    return data


def _connect_remote():
    raw = socket.create_connection((proxy.hostname, proxy_port), timeout=15)
    host_header = f"{target_host}:{target_port}"
    lines = [
        f"CONNECT {host_header} HTTP/1.1",
        f"Host: {host_header}",
    ]
    if proxy.username:
        user = proxy.username or ""
        password = proxy.password or ""
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        lines.append(f"Proxy-Authorization: Basic {token}")
    raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    response = _read_headers(raw)
    first = response.split(b"\r\n", 1)[0]
    if b" 200 " not in first:
        raise OSError("proxy CONNECT failed")
    context = ssl.create_default_context()
    return context.wrap_socket(raw, server_hostname=target_host)


def _rewrite_request(data):
    header, sep, rest = data.partition(b"\r\n\r\n")
    text = header.decode("iso-8859-1")
    lines = text.split("\r\n")
    if not lines:
        raise OSError("empty request")
    first = lines[0].split(" ")
    method = first[0] if first else "GET"
    rewritten = [f"{method} {target_path} HTTP/1.1", f"Host: {target_host}"]
    for line in lines[1:]:
        lower = line.lower()
        if lower.startswith("host:"):
            continue
        rewritten.append(line)
    return ("\r\n".join(rewritten) + "\r\n\r\n").encode("iso-8859-1") + rest


def _pipe(left, right):
    sockets = [left, right]
    while True:
        readable, _, _ = select.select(sockets, [], [], 120)
        if not readable:
            return
        for sock in readable:
            data = sock.recv(65536)
            if not data:
                return
            (right if sock is left else left).sendall(data)


def _handle(client):
    global last_activity
    upstream = None
    try:
        first_request = _read_headers(client)
        if not first_request:
            return
        upstream = _connect_remote()
        upstream.sendall(_rewrite_request(first_request))
        last_activity = time.monotonic()
        _pipe(client, upstream)
    finally:
        last_activity = time.monotonic()
        try:
            client.close()
        except Exception:
            # Tunnel teardown is best-effort after the client disconnects.
            pass
        try:
            if upstream is not None:
                upstream.close()
        except Exception:
            # Tunnel teardown is best-effort after the upstream disconnects.
            pass


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 0))
listener.listen(16)
listener.settimeout(1.0)
print(listener.getsockname()[1], flush=True)

while True:
    if time.monotonic() - last_activity > idle_timeout:
        break
    try:
        client, _addr = listener.accept()
    except socket.timeout:
        continue
    thread = threading.Thread(target=_handle, args=(client,), daemon=True)
    thread.start()
"""


def _reap_browser_use_cdp_tunnel(proc):
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=1)
    except Exception:
        try:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=1)
        except Exception:
            # Tunnel cleanup must not fail plugin shutdown.
            pass


def _cleanup_browser_use_cdp_tunnels():
    for remote_url, (proc, _url) in list(_BROWSER_USE_CDP_TUNNELS.items()):
        _reap_browser_use_cdp_tunnel(proc)
        _BROWSER_USE_CDP_TUNNELS.pop(remote_url, None)


atexit.register(_cleanup_browser_use_cdp_tunnels)


def _start_browser_use_cdp_tunnel(cdp_url):
    for remote_url, (proc, _url) in list(_BROWSER_USE_CDP_TUNNELS.items()):
        if proc.poll() is not None:
            _reap_browser_use_cdp_tunnel(proc)
            _BROWSER_USE_CDP_TUNNELS.pop(remote_url, None)

    parsed = urlparse(str(cdp_url or ""))
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "wss" or not host.endswith(".browser-use.com"):
        return cdp_url

    existing = _BROWSER_USE_CDP_TUNNELS.get(cdp_url)
    if existing is not None:
        proc, local_url = existing
        if proc.poll() is None:
            return local_url

    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", _BROWSER_USE_CDP_TUNNEL_SCRIPT, cdp_url],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=os.environ.copy(),
        )
        port = proc.stdout.readline().strip() if proc.stdout else ""
        if not port.isdigit():
            _reap_browser_use_cdp_tunnel(proc)
            return cdp_url
    except Exception:
        return cdp_url

    local_url = urlunparse(("ws", f"127.0.0.1:{port}", parsed.path or "/", "", parsed.query, ""))
    _BROWSER_USE_CDP_TUNNELS[cdp_url] = (proc, local_url)
    return local_url


def _install_browser_cdp_tunnel_patch():
    """Route Browser Use CDP sockets through OpenShell's HTTP proxy.

    ``agent-browser`` can use the OpenShell proxy for ordinary HTTP requests,
    but its native CDP websocket connector currently dials WSS endpoints
    directly. Direct egress is blocked in the sandbox. Browser Use session
    creation still goes through the Nous gateway; this tunnel only bridges the
    returned short-lived CDP capability URL through the already-enforced proxy.
    """
    if not _broker_mode_enabled():
        return False

    try:
        module = __import__("tools.browser_tool", fromlist=["_resolve_cdp_override"])
    except Exception:
        return False

    if not hasattr(module, "_resolve_cdp_override") or getattr(
        module,
        _BROWSER_CDP_TUNNEL_PATCH_ATTR,
        False,
    ):
        return False

    original = module._resolve_cdp_override

    def _resolve_cdp_override(cdp_url):
        resolved = original(cdp_url)
        return _start_browser_use_cdp_tunnel(resolved)

    module._resolve_cdp_override = _resolve_cdp_override
    setattr(module, _BROWSER_CDP_TUNNEL_PATCH_ATTR, True)
    return True


def _reset_browser_tool_provider_cache():
    """Let Hermes re-read Browser Use broker config after cold imports.

    ``tools.browser_tool`` caches the cloud-provider decision for the process
    lifetime. Hermes may import it before this plugin has hydrated broker env
    from ``.env``, which leaves browser tools stuck in local-CDP mode even
    though NemoClaw configured ``browser.cloud_provider=browser-use``.
    """
    try:
        module = __import__("tools.browser_tool", fromlist=["_get_cloud_provider"])
    except Exception:
        return False

    changed = False
    for name, value in [
        ("_cached_cloud_provider", None),
        ("_cloud_provider_resolved", False),
    ]:
        if hasattr(module, name):
            setattr(module, name, value)
            changed = True
    changed = _evict_local_browser_tool_sessions(module) or changed
    return changed


def _is_local_browser_tool_session(session):
    if not isinstance(session, dict):
        return False
    features = session.get("features")
    if isinstance(features, dict) and features.get("local"):
        return True
    return bool(session.get("fallback_from_cloud"))


def _evict_local_browser_tool_sessions(module, task_id=None):
    active_sessions = getattr(module, "_active_sessions", None)
    if not isinstance(active_sessions, dict):
        return False

    if task_id is None:
        candidate_ids = list(active_sessions.keys())
    else:
        candidate_ids = [task_id] if task_id in active_sessions else []
    stale_ids = [
        candidate_id
        for candidate_id in candidate_ids
        if _is_local_browser_tool_session(active_sessions.get(candidate_id))
    ]
    if not stale_ids:
        return False

    def _remove():
        for stale_id in stale_ids:
            active_sessions.pop(stale_id, None)
        last_activity = getattr(module, "_session_last_activity", None)
        if isinstance(last_activity, dict):
            for stale_id in stale_ids:
                last_activity.pop(stale_id, None)
        recording_sessions = getattr(module, "_recording_sessions", None)
        if hasattr(recording_sessions, "discard"):
            for stale_id in stale_ids:
                recording_sessions.discard(stale_id)

    lock = getattr(module, "_cleanup_lock", None)
    if hasattr(lock, "__enter__") and hasattr(lock, "__exit__"):
        with lock:
            _remove()
    else:
        _remove()
    return True


def _install_browser_session_state_patch():
    """Prevent stale local-CDP fallback sessions from poisoning Browser Use.

    Hermes caches browser sessions by task ID. If it imports or runs browser
    tools before NemoClaw's broker config is hydrated, the first browser call
    may fall back to local Chromium and cache that local session. Subsequent
    calls then reuse local CDP without re-checking Browser Use. In broker mode
    local browser egress is not the intended path, so evict only local/fallback
    sessions and let Hermes create a fresh Browser Use cloud session.
    """
    if not _broker_mode_enabled():
        return False

    try:
        module = __import__("tools.browser_tool", fromlist=["_get_session_info"])
    except Exception:
        return False

    changed = _evict_local_browser_tool_sessions(module)
    if not hasattr(module, "_get_session_info") or getattr(
        module,
        _BROWSER_SESSION_STATE_PATCH_ATTR,
        False,
    ):
        return changed

    original = module._get_session_info

    def _get_session_info(task_id=None):
        _evict_local_browser_tool_sessions(module, task_id or "default")
        return original(task_id)

    module._get_session_info = _get_session_info
    setattr(module, _BROWSER_SESSION_STATE_PATCH_ATTR, True)
    return True


def _install_firecrawl_path_patch():
    """Preserve broker path prefixes with firecrawl-py's absolute v2 paths.

    firecrawl-py sends endpoints like ``/v2/search``. Its URL builder uses
    urljoin, so an ``api_url`` of ``http://host:11436/firecrawl`` becomes
    ``http://host:11436/v2/search`` and bypasses NemoClaw's broker route
    prefix. In broker mode, preserve the configured base path while leaving
    normal Firecrawl URLs untouched.
    """
    if not _broker_mode_enabled():
        return False

    try:
        from firecrawl.v2.utils import http_client
    except Exception:
        return False

    client_cls = getattr(http_client, "HttpClient", None)
    if client_cls is None or getattr(client_cls, _FIRECRAWL_PATH_PATCH_ATTR, False):
        return False

    original = client_cls._build_url

    def _build_url(self, endpoint):
        api_url = getattr(self, "api_url", "")
        parsed_base = urlparse(api_url)
        parsed_endpoint = urlparse(str(endpoint or ""))
        if (
            _broker_mode_enabled()
            and parsed_base.scheme
            and parsed_base.netloc
            and parsed_base.path
            and str(endpoint or "").startswith("/")
            and not parsed_endpoint.netloc
        ):
            path = parsed_base.path.rstrip("/") + (parsed_endpoint.path or "/")
            return urlunparse(
                (
                    parsed_base.scheme,
                    parsed_base.netloc,
                    path,
                    "",
                    parsed_endpoint.query,
                    "",
                ),
            )
        return original(self, endpoint)

    client_cls._build_url = _build_url
    setattr(client_cls, _FIRECRAWL_PATH_PATCH_ATTR, True)
    return True


def _install_nous_tool_broker_patch():
    """Patch Hermes managed-tool availability for NemoClaw broker mode.

    Hermes currently gates managed Nous tools on in-sandbox Nous auth state.
    NemoClaw deliberately does not write Nous OAuth access or refresh tokens
    into the sandbox. OAuth refresh, agent-key minting, and vendor gateway
    auth happen on the host instead:

      sandbox tool call -> host.openshell.internal:11436/<service>
      broker token placeholder -> host broker -> Nous access token upstream

    This shim only tells Hermes that externally managed gateway auth is
    available when NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1. It does not mint,
    refresh, or expose OAuth tokens in the sandbox. Long term, this should be
    replaced by an upstream Hermes setting for externally managed Nous Tool
    Gateway auth.
    """
    _load_hermes_dotenv()
    if not _broker_mode_enabled():
        return False

    patched = False

    def _enabled():
        return True

    for module_name in [
        "tools.tool_backend_helpers",
        "tools.managed_tool_gateway",
        "hermes_cli.nous_subscription",
    ]:
        try:
            module = __import__(module_name, fromlist=["managed_nous_tools_enabled"])
        except Exception:
            continue
        if getattr(module, _BROKER_PATCH_ATTR, False):
            patched = True
            continue
        if hasattr(module, "managed_nous_tools_enabled"):
            setattr(module, "managed_nous_tools_enabled", _enabled)
            setattr(module, _BROKER_PATCH_ATTR, True)
            patched = True
        if module_name == "tools.managed_tool_gateway":
            setattr(module, "build_vendor_gateway_url", _broker_gateway_url)
            setattr(module, "read_nous_access_token", _broker_user_token)
            setattr(module, "resolve_managed_tool_gateway", _broker_resolve_managed_tool_gateway)

    patched = _install_audio_gateway_preference_patch() or patched
    patched = _install_transcription_gateway_patch() or patched
    patched = _install_fal_queue_handle_patch() or patched
    patched = _install_broker_url_safety_patch() or patched

    managed_gateway = sys.modules.get("tools.managed_tool_gateway")
    for module_name in [
        "tools.web_tools",
        "tools.tts_tool",
        "tools.transcription_tools",
        "tools.image_generation_tool",
        "tools.browser_providers.browser_use",
        "tools.environments.managed_modal",
        "tools.terminal_tool",
    ]:
        patched = _patch_loaded_tool_module(module_name, managed_gateway) or patched

    patched = _install_firecrawl_path_patch() or patched
    patched = _install_browser_cdp_tunnel_patch() or patched
    patched = _install_browser_session_state_patch() or patched
    patched = _reset_browser_tool_provider_cache() or patched

    return patched


def _load_nemoclaw_config():
    """Load NemoClaw onboard config from ~/.nemoclaw/config.json."""
    config_path = os.path.expanduser("~/.nemoclaw/config.json")
    if not os.path.exists(config_path):
        return None
    try:
        with open(config_path) as f:
            return json.load(f)
    except Exception:
        return None


def _load_hermes_config():
    """Load Hermes config.yaml from the sandbox."""
    for path in [
        os.path.expanduser("~/.hermes/config.yaml"),
        "/sandbox/.hermes/config.yaml",
    ]:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    return yaml.safe_load(f)
            except Exception:
                continue
    return None


def _get_sandbox_info():
    """Gather sandbox status information."""
    hermes_cfg = _load_hermes_config()
    nemoclaw_cfg = _load_nemoclaw_config()

    model = "unknown"
    provider = "custom"
    base_url = "unknown"

    if hermes_cfg:
        model_cfg = hermes_cfg.get("model", {})
        model = model_cfg.get("default", "unknown")
        provider = model_cfg.get("provider", "custom")
        base_url = model_cfg.get("base_url", "unknown")

    if nemoclaw_cfg:
        model = nemoclaw_cfg.get("model", model)
        provider = nemoclaw_cfg.get("provider", provider)

    # Check gateway health
    gateway_ok = False
    try:
        result = subprocess.run(
            ["curl", "-sf", "http://localhost:8642/health"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            gateway_ok = True
    except Exception:
        # Status output should still render if the local health probe fails.
        pass

    return {
        "agent": "hermes",
        "model": model,
        "provider": provider,
        "base_url": base_url,
        "gateway": "running" if gateway_ok else "stopped",
        "port": 8642,
    }


def _active_managed_gateway_services():
    """List managed Nous services that have broker URLs configured."""
    services = []
    for service, env_key in _TOOL_GATEWAY_URL_ENV.items():
        if _get_env_value(env_key, ""):
            services.append(service)
    return services


def _should_inject_nemoclaw_context(user_message=None, is_first_turn=False):
    """Return whether this turn needs NemoClaw runtime grounding."""
    if is_first_turn:
        return True
    text = str(user_message or "").lower()
    return any(keyword in text for keyword in _NEMOCLAW_CONTEXT_KEYWORDS)


def _build_nemoclaw_agent_context(platform=None):
    """Build quiet, ephemeral context for Hermes' pre_llm_call hook."""
    info = _get_sandbox_info()
    hermes_home = (
        os.getenv("HERMES_HOME")
        or _get_env_value("HERMES_HOME", "")
        or "/sandbox/.hermes-data"
    )
    services = _active_managed_gateway_services()
    service_text = ", ".join(services) if services else "none detected"
    broker_state = "enabled" if _broker_mode_enabled() else "not enabled"
    platform_text = str(platform or "").strip()
    platform_line = (
        f"- Current Hermes messaging platform: {platform_text}. Messaging adapters "
        + "run in the parent Hermes gateway sandbox; child tool-execution containers "
        + "will not show their host/gateway config."
        if platform_text
        else "- Messaging adapters run in the parent Hermes gateway sandbox; child "
        + "tool-execution containers will not show their host/gateway config."
    )
    agent_identity_line = (
        "- You are Hermes Agent running in a NemoClaw-managed OpenShell sandbox, "
        + "not a host-only assistant."
    )
    child_tool_line = (
        "- Some tools, especially managed code/terminal tools, execute in child "
        + "tool sandboxes such as Modal. Seeing /__modal, MODAL_SANDBOX_ID, a "
        + "missing hermes binary, or missing ~/.hermes-data inside a tool shell "
        + "means that shell is a child tool sandbox, not proof that Hermes is "
        + "running on the host."
    )
    config_line = (
        f"- Parent Hermes sandbox config lives under {hermes_home} and "
        + "/sandbox/.hermes when available. Use nemoclaw_status or "
        + "nemoclaw_info for NemoClaw environment questions."
    )
    tools_line = (
        "- NemoClaw tools available: nemoclaw_status, nemoclaw_info, "
        + "nemoclaw_reload_skills, transcribe_audio."
    )

    return "\n".join(
        [
            "NemoClaw runtime context:",
            agent_identity_line,
            child_tool_line,
            config_line,
            f"- NemoClaw provider state: model={info['model']}, "
            f"provider={info['provider']}, endpoint={info['base_url']}, "
            f"gateway={info['gateway']}.",
            tools_line,
            f"- Managed Nous tool broker: {broker_state}; configured services: "
            f"{service_text}. Raw Nous OAuth tokens are host-managed by NemoClaw "
            "and should not be expected inside the sandbox.",
            platform_line,
        ],
    )


def _pre_llm_call(**kwargs):
    """Inject non-visible NemoClaw runtime context into relevant Hermes turns."""
    if not _should_inject_nemoclaw_context(
        user_message=kwargs.get("user_message"),
        is_first_turn=bool(kwargs.get("is_first_turn")),
    ):
        return None
    _install_nous_tool_broker_patch()
    return {"context": _build_nemoclaw_agent_context(platform=kwargs.get("platform"))}


def _handle_status(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_status tool call."""
    info = _get_sandbox_info()
    lines = [
        "NemoClaw Sandbox Status (Hermes)",
        "\u2500" * 40,
        f"  Agent:    Hermes Agent",
        f"  Gateway:  {info['gateway']}",
        f"  Model:    {info['model']}",
        f"  Provider: {info['provider']}",
        f"  Endpoint: {info['base_url']}",
        f"  API:      http://localhost:{info['port']}/v1",
    ]
    return "\n".join(lines)


def _handle_info(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_info tool call — returns structured JSON."""
    return json.dumps(_get_sandbox_info(), indent=2)


def _handle_transcribe_audio(tool_input=None, context=None, **_kwargs):
    """Transcribe an audio file from the parent Hermes sandbox."""
    _install_nous_tool_broker_patch()
    args = tool_input if isinstance(tool_input, dict) else {}
    file_path = str(args.get("file_path") or "").strip()
    model = args.get("model")

    if not file_path:
        return json.dumps(
            {
                "success": False,
                "transcript": "",
                "error": "file_path is required",
            },
        )

    try:
        from tools.transcription_tools import transcribe_audio

        result = transcribe_audio(file_path, model=str(model).strip() if model else None)
    except Exception as exc:
        result = {
            "success": False,
            "transcript": "",
            "error": f"Transcription failed: {exc}",
        }

    return json.dumps(result, indent=2, ensure_ascii=False)


def _reload_skills():
    """Clear the Hermes skill slash-command cache and re-scan skill directories.

    Hermes's ``agent.skill_commands`` module caches discovered skills in a
    module-global dict (``_skill_commands``).  ``get_skill_commands()`` only
    scans on first call, so skills installed after gateway startup are
    invisible.  We clear the dict and call ``scan_skill_commands()`` to force
    a fresh scan.

    Returns the dict of discovered skills, or None on failure.
    """
    try:
        import agent.skill_commands as sc

        sc._skill_commands.clear()
        return sc.scan_skill_commands()
    except ImportError:
        return None
    except Exception:
        return None


def _handle_reload_skills(tool_input=None, context=None, **_kwargs):
    """Handle the nemoclaw_reload_skills tool call."""
    commands = _reload_skills()
    if commands is None:
        return (
            "Failed to reload skills. The agent.skill_commands module may "
            "not be available in this Hermes version."
        )

    if not commands:
        return "Skill reload complete. No skills found in skill directories."

    names = sorted(commands.keys())
    lines = [f"Skill reload complete. {len(names)} skill(s) discovered:", ""]
    for name in names:
        info = commands[name]
        desc = info.get("description", "no description")
        lines.append(f"  {name}: {desc}")
    return "\n".join(lines)


def register(ctx):
    """Register NemoClaw tools and hooks with Hermes."""
    _install_nous_tool_broker_patch()

    # Register status tool
    ctx.register_tool(
        name="nemoclaw_status",
        toolset="nemoclaw",
        schema={
            "type": "function",
            "function": {
                "name": "nemoclaw_status",
                "description": (
                    "Show NemoClaw sandbox status: agent type, gateway health, "
                    "model, provider, and inference endpoint."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        handler=_handle_status,
        description="NemoClaw sandbox status",
    )

    # Register info tool (structured JSON output)
    ctx.register_tool(
        name="nemoclaw_info",
        toolset="nemoclaw",
        schema={
            "type": "function",
            "function": {
                "name": "nemoclaw_info",
                "description": "Get NemoClaw sandbox info as structured JSON.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        handler=_handle_info,
        description="NemoClaw sandbox info (JSON)",
    )

    ctx.register_tool(
        name="transcribe_audio",
        toolset="audio",
        schema={
            "type": "function",
            "function": {
                "name": "transcribe_audio",
                "description": (
                    "Transcribe an audio file that already exists in the Hermes "
                    "sandbox. In NemoClaw broker mode this uses the managed "
                    "OpenAI-audio gateway instead of direct OpenAI credentials."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to an audio file inside the Hermes sandbox.",
                        },
                        "model": {
                            "type": "string",
                            "description": "Optional transcription model override.",
                        },
                    },
                    "required": ["file_path"],
                },
            },
        },
        handler=_handle_transcribe_audio,
        description="Transcribe audio through the configured Hermes STT backend",
    )

    # Register skill reload tool
    ctx.register_tool(
        name="nemoclaw_reload_skills",
        toolset="nemoclaw",
        schema={
            "type": "function",
            "function": {
                "name": "nemoclaw_reload_skills",
                "description": (
                    "Reload and re-discover skills from the skill directories. "
                    "Call this after new skills have been installed to make them "
                    "available as slash commands without restarting the gateway."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        handler=_handle_reload_skills,
        description="Reload skills from disk without gateway restart",
    )

    # Ground the model quietly through Hermes' context hook. This replaces the
    # old visible startup banner without reintroducing TUI interrupt noise.
    ctx.register_hook("pre_llm_call", _pre_llm_call)

    # Refresh skills silently on session start. Earlier versions injected a
    # system banner here, but that can interrupt the user's first prompt in the
    # Hermes TUI because plugin-injected messages travel through Hermes's
    # interrupt queue. Keep startup native and expose status through tools.
    def _on_session_start(**kwargs):
        _install_nous_tool_broker_patch()
        _reload_skills()

    ctx.register_hook("on_session_start", _on_session_start)
