# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for SSRF validation in runner.py (PSIRT bug 6002763)."""

from __future__ import annotations

import socket
from typing import Any
from unittest.mock import patch

import pytest
from runner import is_private_ip, validate_endpoint_url

# Type alias for socket.getaddrinfo return value
_AddrInfo = list[tuple[socket.AddressFamily, socket.SocketKind, int, str, tuple[str, int]]]

# ── is_private_ip ───────────────────────────────────────────────


class TestIsPrivateIp:
    @pytest.mark.parametrize(
        "ip",
        [
            "127.0.0.1",
            "127.255.255.255",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
            "169.254.0.1",
            "169.254.255.255",
            "::1",
            "fd00::1",
            "fdff::1",
        ],
    )
    def test_private_ips_detected(self, ip: str) -> None:
        assert is_private_ip(ip) is True

    @pytest.mark.parametrize(
        "ip",
        [
            "8.8.8.8",
            "1.1.1.1",
            "203.0.113.1",
            "2607:f8b0:4004:800::200e",  # google.com IPv6
        ],
    )
    def test_public_ips_allowed(self, ip: str) -> None:
        assert is_private_ip(ip) is False

    def test_invalid_ip_returns_false(self) -> None:
        assert is_private_ip("not-an-ip") is False


# ── validate_endpoint_url ────────────────────────────────────────


def _mock_getaddrinfo_public(host: str | None, port: Any, **kwargs: Any) -> _AddrInfo:
    """Return a fake public IP for any hostname."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]


def _mock_getaddrinfo_private(host: str | None, port: Any, **kwargs: Any) -> _AddrInfo:
    """Return a private IP for any hostname."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 0))]


def _mock_getaddrinfo_localhost(host: str | None, port: Any, **kwargs: Any) -> _AddrInfo:
    """Return localhost for any hostname."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]


def _mock_getaddrinfo_link_local(host: str | None, port: Any, **kwargs: Any) -> _AddrInfo:
    """Return a link-local (cloud metadata) IP."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]


def _mock_getaddrinfo_fail(host: str | None, port: Any, **kwargs: Any) -> _AddrInfo:
    """Simulate DNS resolution failure."""
    raise socket.gaierror("Name or service not known")


class TestValidateEndpointUrl:
    """Test scheme, hostname, and IP validation."""

    # ── Scheme checks ────────────────────────────────────────────

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_public)
    def test_https_allowed(self) -> None:
        assert validate_endpoint_url("https://api.nvidia.com/v1") == "https://api.nvidia.com/v1"

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_public)
    def test_http_allowed(self) -> None:
        assert validate_endpoint_url("http://api.nvidia.com/v1") == "http://api.nvidia.com/v1"

    def test_file_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("file:///etc/passwd")

    def test_ftp_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("ftp://evil.com/data")

    def test_gopher_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("gopher://evil.com/")

    def test_javascript_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("javascript:alert(1)")

    def test_empty_scheme_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("://no-scheme.com")

    # ── Hostname checks ──────────────────────────────────────────

    def test_no_hostname_rejected(self) -> None:
        with pytest.raises(ValueError, match="No hostname"):
            validate_endpoint_url("http://")

    def test_empty_url_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            validate_endpoint_url("")

    # ── Private IP checks (via DNS resolution) ───────────────────

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_private)
    def test_private_10_network_rejected(self) -> None:
        with pytest.raises(ValueError, match="private/internal address"):
            validate_endpoint_url("https://attacker.com/ssrf")

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_localhost)
    def test_localhost_rejected(self) -> None:
        with pytest.raises(ValueError, match="private/internal address"):
            validate_endpoint_url("https://attacker.com/ssrf")

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_link_local)
    def test_cloud_metadata_rejected(self) -> None:
        """169.254.169.254 is the AWS/GCP/Azure metadata endpoint."""
        with pytest.raises(ValueError, match="private/internal address"):
            validate_endpoint_url("https://attacker.com/metadata")

    # ── DNS resolution failure ───────────────────────────────────

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_fail)
    def test_dns_failure_rejected(self) -> None:
        with pytest.raises(ValueError, match="Cannot resolve hostname"):
            validate_endpoint_url("https://nonexistent.invalid/v1")

    # ── Valid public endpoints ───────────────────────────────────

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_public)
    def test_nvidia_api_endpoint_allowed(self) -> None:
        url = "https://integrate.api.nvidia.com/v1"
        assert validate_endpoint_url(url) == url

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_public)
    def test_url_with_port_allowed(self) -> None:
        url = "https://api.example.com:8443/v1"
        assert validate_endpoint_url(url) == url

    @patch("runner.socket.getaddrinfo", _mock_getaddrinfo_public)
    def test_url_with_path_preserved(self) -> None:
        url = "https://api.example.com/v1/chat/completions"
        assert validate_endpoint_url(url) == url
