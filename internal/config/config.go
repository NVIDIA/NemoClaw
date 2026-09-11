// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"regexp"
	"strings"

	"github.com/NVIDIA/NemoClaw/internal/spark"
	"go.yaml.in/yaml/v3"
)

const APIVersion = "nemoclaw.nvidia.com/v1alpha1"
const MaxDocumentBytes = 1 << 20

type Document struct {
	APIVersion string   `yaml:"apiVersion" json:"apiVersion"`
	Kind       string   `yaml:"kind" json:"kind"`
	Metadata   Metadata `yaml:"metadata" json:"metadata"`
	Spec       Spec     `yaml:"spec" json:"spec"`
}
type Metadata struct {
	Name string `yaml:"name" json:"name"`
	UID  string `yaml:"uid" json:"uid"`
}
type Spec struct {
	Gateway            Gateway             `yaml:"gateway" json:"gateway"`
	InferenceProviders []InferenceProvider `yaml:"inferenceProviders" json:"inferenceProviders"`
	Sandboxes          []Sandbox           `yaml:"sandboxes" json:"sandboxes"`
}
type Credential struct {
	Env string `yaml:"env" json:"env"`
}
type TLS struct {
	CA          Credential `yaml:"ca" json:"ca"`
	Certificate Credential `yaml:"certificate" json:"certificate"`
	Key         Credential `yaml:"key" json:"key"`
}
type Gateway struct {
	Management  string      `yaml:"management" json:"management"`
	Endpoint    string      `yaml:"endpoint" json:"endpoint"`
	Credential  *Credential `yaml:"credential,omitempty" json:"credential,omitempty"`
	TLS         *TLS        `yaml:"tls,omitempty" json:"tls,omitempty"`
	Engine      string      `yaml:"engine,omitempty" json:"engine,omitempty"`
	Image       string      `yaml:"image,omitempty" json:"image,omitempty"`
	NetworkCIDR string      `yaml:"networkCIDR,omitempty" json:"networkCIDR,omitempty"`
}
type InferenceProvider struct {
	Name       string         `yaml:"name" json:"name"`
	Provider   string         `yaml:"provider" json:"provider"`
	Endpoint   string         `yaml:"endpoint,omitempty" json:"endpoint,omitempty"`
	Credential *Credential    `yaml:"credential,omitempty" json:"credential,omitempty"`
	Ollama     *ManagedOllama `yaml:"ollama,omitempty" json:"ollama,omitempty"`
	Service    *spark.Service `yaml:"service,omitempty" json:"service,omitempty"`
}
type ManagedOllama struct {
	Engine  string `yaml:"engine" json:"engine"`
	Image   string `yaml:"image" json:"image"`
	Network string `yaml:"network" json:"network"`
}
type Sandbox struct {
	Name    string  `yaml:"name" json:"name"`
	Image   Image   `yaml:"image" json:"image"`
	Runtime Runtime `yaml:"runtime" json:"runtime"`
	Network Network `yaml:"network" json:"network"`
	Agents  []Agent `yaml:"agents" json:"agents"`
}
type Image struct {
	Ref string `yaml:"ref" json:"ref"`
}
type Runtime struct {
	Provider string `yaml:"provider" json:"provider"`
}
type Network struct {
	Tier string `yaml:"tier" json:"tier"`
}
type Agent struct {
	Name      string    `yaml:"name" json:"name"`
	Type      string    `yaml:"type" json:"type"`
	Inference Inference `yaml:"inference" json:"inference"`
}
type Inference struct {
	Routes []Route `yaml:"routes" json:"routes"`
}
type Route struct {
	Name        string    `yaml:"name" json:"name"`
	ProviderRef string    `yaml:"providerRef" json:"providerRef"`
	Overrides   Overrides `yaml:"overrides" json:"overrides"`
}
type Overrides struct {
	Model string `yaml:"model" json:"model"`
}

var slug = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var envName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
var modelName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`)
var ollamaModelName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$`)
var imageRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`)

func Parse(r io.Reader) (Document, error) {
	var d Document
	b, err := io.ReadAll(io.LimitReader(r, MaxDocumentBytes+1))
	if err != nil {
		return d, err
	}
	if len(b) > MaxDocumentBytes {
		return d, errors.New("configuration exceeds 1 MiB")
	}
	var tree yaml.Node
	if err := yaml.Unmarshal(b, &tree); err != nil {
		return d, errors.New("invalid YAML document")
	}
	if err := checkTree(&tree); err != nil {
		return d, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&d); err != nil {
		return d, errors.New("configuration contains an unknown field or invalid field type")
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return d, errors.New("expected exactly one YAML document")
	}
	d.Defaults()
	return d, d.Validate()
}

func checkTree(n *yaml.Node) error {
	if n.Kind == yaml.AliasNode || n.Anchor != "" || n.Tag == "!!merge" {
		return errors.New("YAML anchors, aliases, and merges are unsupported")
	}
	if n.Tag == "!!null" {
		return errors.New("omit optional fields instead of using null")
	}
	for _, c := range n.Content {
		if err := checkTree(c); err != nil {
			return err
		}
	}
	return nil
}

func (d Document) Validate() error {
	if d.APIVersion != APIVersion || d.Kind != "NemoClawConfig" {
		return errors.New("expected nemoclaw.nvidia.com/v1alpha1 NemoClawConfig")
	}
	if !slug.MatchString(d.Metadata.Name) || !uuid.MatchString(d.Metadata.UID) {
		return errors.New("metadata requires a lowercase name and immutable UUID")
	}
	g := d.Spec.Gateway
	if g.Management != "external" && g.Management != "managed" {
		return errors.New("gateway management must be external or managed")
	}
	if g.Management == "managed" {
		if err := g.ValidateManaged(); err != nil {
			return err
		}
	} else if g.Engine != "" || g.Image != "" || g.NetworkCIDR != "" {
		return errors.New("external gateway cannot declare managed runtime settings")
	}
	if err := ValidateEndpoint(g.Endpoint, true); err != nil {
		return fmt.Errorf("gateway endpoint: %w", err)
	}
	if err := validateCredential(g.Credential); err != nil {
		return err
	}
	if g.TLS != nil {
		for _, c := range []*Credential{&g.TLS.CA, &g.TLS.Certificate, &g.TLS.Key} {
			if err := validateCredential(c); err != nil {
				return err
			}
		}
	}
	if strings.HasPrefix(g.Endpoint, "http:") && (g.Credential != nil || g.TLS != nil) {
		return errors.New("gateway credentials require HTTPS")
	}
	if len(d.Spec.InferenceProviders) != 1 || len(d.Spec.Sandboxes) != 1 {
		return errors.New("this slice requires exactly one inference provider and one sandbox")
	}
	p := d.Spec.InferenceProviders[0]
	if !slug.MatchString(p.Name) || p.Provider != "openai" {
		return errors.New("provider requires a lowercase name and openai implementation")
	}
	if p.Service != nil {
		if p.Endpoint != "" || p.Ollama != nil || p.Credential != nil {
			return errors.New("managed service is mutually exclusive with endpoint, Ollama, and external credentials")
		}
		if g.Management != "managed" {
			return errors.New("this Spark slice requires its managed Docker gateway")
		}
		if err := p.Service.Validate(); err != nil {
			return err
		}
	} else if err := ValidateEndpoint(p.Endpoint, false); err != nil {
		return fmt.Errorf("inference endpoint: %w", err)
	}
	if err := validateCredential(p.Credential); err != nil {
		return err
	}
	if p.Credential != nil && strings.HasPrefix(p.Endpoint, "http:") {
		return errors.New("inference credentials require HTTPS")
	}
	s := d.Spec.Sandboxes[0]
	if !slug.MatchString(s.Name) || !imageRef.MatchString(s.Image.Ref) {
		return errors.New("sandbox requires a lowercase name and image pinned by SHA-256 digest")
	}
	if s.Runtime.Provider != "docker" && s.Runtime.Provider != "podman" {
		return errors.New("sandbox runtime must be docker or podman")
	}
	if g.Management == "managed" && s.Runtime.Provider != "docker" {
		return errors.New("managed gateway requires the qualified Docker driver")
	}
	if s.Network.Tier != "isolated" {
		return errors.New("this slice supports only the isolated network tier")
	}
	if len(s.Agents) != 1 {
		return errors.New("this slice requires exactly one agent")
	}
	a := s.Agents[0]
	if !slug.MatchString(a.Name) || a.Type != "openclaw" {
		return errors.New("agent requires a lowercase name and openclaw type")
	}
	if len(a.Inference.Routes) != 1 {
		return errors.New("this slice requires exactly one primary inference route")
	}
	r := a.Inference.Routes[0]
	if r.Name != "primary" || r.ProviderRef != p.Name || !modelName.MatchString(r.Overrides.Model) {
		return errors.New("primary route must reference the declared provider and a valid model")
	}
	if p.Service != nil && (r.Overrides.Model != spark.ModelName || s.Runtime.Provider != "docker") {
		return errors.New("Spark service requires its pinned served model and Docker sandbox")
	}
	if p.Ollama != nil {
		o := p.Ollama
		u, _ := url.Parse(p.Endpoint)
		bind, err := netip.ParseAddrPort(u.Host)
		if p.Credential != nil || u.Scheme != "http" || u.Path != "/v1" || err != nil || bind.Port() == 0 || !(bind.Addr().IsLoopback() || bind.Addr().IsPrivate()) {
			return errors.New("managed Ollama requires an explicit private or loopback IP:port/v1 HTTP endpoint without credentials")
		}
		if !strings.HasPrefix(o.Engine, "unix:///") || strings.ContainsAny(o.Engine, "$%{}\r\n\x00") || !slug.MatchString(o.Network) || !imageRef.MatchString(o.Image) || !strings.HasPrefix(o.Image, "ollama/ollama@sha256:") {
			return errors.New("managed Ollama requires a local Unix engine socket, existing named network, and pinned ollama/ollama image")
		}
		if !ollamaModelName.MatchString(r.Overrides.Model) {
			return errors.New("managed Ollama requires an explicit registry-library model:tag")
		}
	}
	return nil
}

func ValidateEndpoint(raw string, gateway bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(raw, "\r\n\t$%{}\\") {
		return errors.New("expected an endpoint without credentials, query, fragment, or escapes")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return errors.New("expected HTTPS or local HTTP")
	}
	if gateway && u.Path != "" && u.Path != "/" {
		return errors.New("gateway endpoint must not include a path")
	}
	ip, ipErr := netip.ParseAddr(u.Hostname())
	if ipErr == nil && (ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast()) {
		return errors.New("unspecified, multicast, and link-local endpoints are forbidden")
	}
	if u.Scheme == "http" && !(ipErr == nil && (ip.IsLoopback() || (!gateway && ip.IsPrivate()))) {
		return errors.New("HTTP requires a literal loopback address, or a private inference address")
	}
	if strings.EqualFold(u.Hostname(), "metadata.google.internal") {
		return errors.New("metadata endpoints are forbidden")
	}
	return nil
}

func validateCredential(c *Credential) error {
	if c != nil && !envName.MatchString(c.Env) {
		return errors.New("credential references require an uppercase environment variable name")
	}
	return nil
}

func (d Document) CredentialNames() []string {
	var names []string
	add := func(c *Credential) {
		if c != nil {
			names = append(names, c.Env)
		}
	}
	add(d.Spec.Gateway.Credential)
	if t := d.Spec.Gateway.TLS; t != nil {
		add(&t.CA)
		add(&t.Certificate)
		add(&t.Key)
	}
	for _, p := range d.Spec.InferenceProviders {
		add(p.Credential)
	}
	return names
}

func (d Document) Digest() string {
	b, _ := json.Marshal(d)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (d Document) Workspace() string {
	h := sha256.Sum256([]byte(d.Metadata.UID))
	return "nc-" + hex.EncodeToString(h[:8])
}
func (d Document) YAML() ([]byte, error) { return yaml.Marshal(d) }
