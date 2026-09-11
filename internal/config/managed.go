// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
)

// These defaults are part of v1alpha1. New versions must not silently change
// the image or isolation policy of an existing document.
const DefaultAgentImage = "nc-prototype-openclaw@sha256:f73285851f5cc9d1862da7aaa603249f2c97fdf431bc4b03a5a435af897405f3"
const DefaultGatewayImage = "ghcr.io/nvidia/openshell/gateway@sha256:3d08ad1e7d839a2ffb9ac85a66102b96dd6bc042c3a6f1eaa31351998fd65792"

func (d *Document) Defaults() {
	g := &d.Spec.Gateway
	if g.Management == "managed" {
		if g.Endpoint == "" {
			g.Endpoint = "http://127.0.0.1:17681"
		}
		if g.Engine == "" {
			g.Engine = "unix:///var/run/docker.sock"
		}
		if g.Image == "" {
			g.Image = DefaultGatewayImage
		}
		if g.NetworkCIDR == "" {
			h := sha256.Sum256([]byte(d.Metadata.UID))
			g.NetworkCIDR = fmt.Sprintf("172.30.%d.0/24", h[0])
		}
	}
	for i := range d.Spec.InferenceProviders {
		if s := d.Spec.InferenceProviders[i].Service; s != nil {
			s.Defaults()
		}
	}
	for i := range d.Spec.Sandboxes {
		s := &d.Spec.Sandboxes[i]
		if s.Image.Ref == "" {
			s.Image.Ref = DefaultAgentImage
		}
		if s.Runtime.Provider == "" {
			s.Runtime.Provider = "docker"
		}
		if s.Network.Tier == "" {
			s.Network.Tier = "isolated"
		}
	}
}

func (g Gateway) ValidateManaged() error {
	u, err := url.Parse(g.Endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || g.Credential != nil || g.TLS != nil || g.Engine != "unix:///var/run/docker.sock" || g.Image != DefaultGatewayImage {
		return errors.New("managed gateway requires the pinned ARM64 image, local Docker socket, and explicit loopback HTTP port without external credentials")
	}
	bind, err := netip.ParseAddrPort(u.Host)
	if err != nil || bind.Port() < 1024 {
		return errors.New("managed gateway requires an unprivileged loopback port")
	}
	p, err := netip.ParsePrefix(g.NetworkCIDR)
	if err != nil || !p.Addr().Is4() || !p.Addr().IsPrivate() || p.Bits() != 24 || p != p.Masked() {
		return errors.New("managed gateway requires a private IPv4 /24 network")
	}
	return nil
}

func (g Gateway) Bridge() string {
	p, err := netip.ParsePrefix(g.NetworkCIDR)
	if err != nil {
		return ""
	}
	return p.Addr().Next().String()
}

func (d Document) InferenceEndpoint() string {
	p := d.Spec.InferenceProviders[0]
	if p.Service == nil {
		return p.Endpoint
	}
	return fmt.Sprintf("http://%s:%d/v1", d.Spec.Gateway.Bridge(), p.Service.Serving.Port)
}
