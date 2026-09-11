// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/ollama"
	"github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

type Docker struct {
	API *client.Client
	// Tests inject a capacity boundary; production always observes this host.
	CheckStart func(context.Context, Spec, *Observation) error
}

func New(engine string) (*Docker, error) {
	d, err := ollama.NewDocker(engine)
	if err != nil {
		return nil, err
	}
	return &Docker{API: d.API}, nil
}
func (d *Docker) Close() error { return d.API.Close() }

type Observation struct {
	Spec                      Spec
	ID, ContainerID, DataPath string
	Running, Initialized      bool
	StartedAt                 time.Time
}

var ErrPartial = errors.New("managed container is absent but owned persistent resources remain")

func verifyLabels(want, got map[string]string) error {
	for k, v := range want {
		if v == "" || got[k] != v {
			return errors.New("managed ownership, generation, or configuration conflicts")
		}
	}
	return nil
}

func (d *Docker) Observe(ctx context.Context, want Spec, id string) (*Observation, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := want.Validate(); err != nil {
		return nil, err
	}
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil || info.Info.ID == "" {
		return nil, errors.New("Docker identity observation failed")
	}
	c, ce := d.API.ContainerInspect(ctx, want.Name, client.ContainerInspectOptions{})
	v, ve := d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
	n, ne := d.API.NetworkInspect(ctx, want.Network(), client.NetworkInspectOptions{})
	if ne != nil && !errdefs.IsNotFound(ne) {
		return nil, errors.New("managed network observation failed; runtime absence unconfirmed")
	}
	if errdefs.IsNotFound(ce) && errdefs.IsNotFound(ve) && (want.Kind == ServiceKind || errdefs.IsNotFound(ne)) {
		if id != "" {
			return nil, errors.New("bound managed runtime disappeared; automatic replacement forbidden")
		}
		return nil, nil
	}
	if errdefs.IsNotFound(ce) && (ve == nil || ne == nil) {
		if ve != nil && !errdefs.IsNotFound(ve) || ne != nil && !errdefs.IsNotFound(ne) {
			return nil, errors.New("partial runtime observation failed")
		}
		if ve == nil {
			if err = verifyVolume(want, v.Volume); err != nil {
				return nil, err
			}
		}
		if ne == nil {
			if err = verifyNetwork(want, n.Network); err != nil {
				return nil, err
			}
		}
		if id != "" {
			return nil, errors.New("bound container missing; persistent data retained and recreation forbidden")
		}
		return nil, ErrPartial
	}
	if ce != nil || ve != nil || ne != nil {
		return nil, errors.New("managed container, storage, or network observation failed; absence unconfirmed")
	}
	if err = verifyVolume(want, v.Volume); err != nil {
		return nil, err
	}
	if err = verifyNetwork(want, n.Network); err != nil {
		return nil, err
	}
	// Existing containers retain their immutable image ID even when loading a
	// newer local build removes the old repository alias from the image store.
	// The container's original pinned Config.Image is checked below as well.
	image, err := d.API.ImageInspect(ctx, c.Container.Image)
	if err != nil || image.Config == nil || image.ID == "" {
		return nil, errors.New("pinned runtime image observation failed")
	}
	if err = verifyContainer(want, c.Container, v.Volume.Mountpoint, image.Config.Env, image.ID); err != nil {
		return nil, err
	}
	o := &Observation{Spec: want, ContainerID: c.Container.ID, DataPath: v.Volume.Mountpoint, Running: c.Container.State.Running, Initialized: true}
	o.StartedAt, _ = time.Parse(time.RFC3339Nano, c.Container.State.StartedAt)
	o.ID = info.Info.ID + "/" + o.ContainerID + "/" + v.Volume.CreatedAt + "/" + n.Network.ID
	if want.Kind == GatewayKind {
		b, e := d.ReadFile(ctx, o.ContainerID, o.DataPath+"/gateway.toml", 128<<10)
		if errdefs.IsNotFound(e) && id == "" && !o.Running {
			o.Initialized = false
			return o, nil
		}
		if e != nil || !bytes.Equal(b, want.GatewayConfig(o.DataPath)) {
			return nil, errors.New("managed gateway configuration changed or is unobservable")
		}
		pub, e := d.ReadFile(ctx, o.ContainerID, o.DataPath+"/tls/jwt/public.pem", 128<<10)
		if e != nil || len(pub) == 0 {
			return nil, errors.New("gateway durable credential identity is unobservable")
		}
		h := sha256.Sum256(pub)
		o.ID += "/" + hex.EncodeToString(h[:])
		binary, e := d.ReadFile(ctx, o.ContainerID, o.DataPath+"/openshell-sandbox", 128<<20)
		if e != nil {
			return nil, errors.New("gateway supervisor artifact observation failed")
		}
		h = sha256.Sum256(binary)
		if hex.EncodeToString(h[:]) != SupervisorSHA256 {
			return nil, errors.New("gateway supervisor artifact changed")
		}
	}
	if id != "" && o.ID != id {
		return nil, errors.New("managed durable identity changed; automatic replacement forbidden")
	}
	return o, nil
}

func verifyVolume(want Spec, v volume.Volume) error {
	labels := want.labels()
	if want.Kind == ServiceKind {
		labels = map[string]string{OwnerLabel: want.Owner, GenerationLabel: want.Generation}
	}
	if err := verifyLabels(labels, v.Labels); err != nil {
		return err
	}
	if v.Name != want.Volume() || v.CreatedAt == "" || v.Driver != "local" || len(v.Options) != 0 || !strings.HasPrefix(v.Mountpoint, "/var/lib/docker/volumes/") || !strings.HasSuffix(v.Mountpoint, "/_data") {
		return errors.New("managed persistent volume identity or configuration drifted")
	}
	return nil
}

func verifyNetwork(want Spec, n network.Inspect) error {
	// Gateway owns the shared bridge; service uses that same deployment bridge.
	if n.Labels[OwnerLabel] != want.Owner || n.ID == "" || n.Name != want.Network() || n.Driver != "bridge" || n.Internal || n.EnableIPv6 || n.IPAM.Driver != "default" || len(n.IPAM.Config) != 1 || n.IPAM.Config[0].Subnet.String() != want.Gateway.NetworkCIDR || n.IPAM.Config[0].Gateway.String() != want.Gateway.Bridge() {
		return errors.New("managed bridge identity, ownership, or configuration drifted")
	}
	if want.Kind == GatewayKind {
		return verifyLabels(want.labels(), n.Labels)
	}
	return nil
}

func verifyContainer(want Spec, c container.InspectResponse, dataPath string, imageEnv []string, imageID string) error {
	if c.ID == "" || c.Config == nil || c.HostConfig == nil || c.State == nil {
		return errors.New("partial container inspection")
	}
	if err := verifyLabels(want.labels(), c.Config.Labels); err != nil {
		return err
	}
	ec, eh := want.Container(dataPath)
	h := c.HostConfig
	if strings.TrimPrefix(c.Name, "/") != want.Name || c.Image != imageID || c.Config.Image != ec.Image || c.Config.User != ec.User || !slices.Equal(c.Config.Entrypoint, ec.Entrypoint) || !slices.Equal(c.Config.Cmd, ec.Cmd) || h.NetworkMode != eh.NetworkMode || h.Privileged || !slices.Equal(h.CapDrop, eh.CapDrop) || len(h.CapAdd) != 0 || !slices.Equal(h.SecurityOpt, eh.SecurityOpt) || h.RestartPolicy.Name != eh.RestartPolicy.Name || h.RestartPolicy.MaximumRetryCount != 0 || h.AutoRemove || h.PidMode != "" || (h.IpcMode != "" && h.IpcMode != "private") || len(h.Devices) != 0 || h.Memory != eh.Memory || h.MemorySwap != eh.MemorySwap || !sameDevices(h.DeviceRequests, eh.DeviceRequests) || !maps.EqualFunc(h.PortBindings, eh.PortBindings, func(a, b []network.PortBinding) bool { return slices.Equal(a, b) }) {
		return errors.New("managed container configuration or memory protection drifted")
	}
	if want.Kind == ServiceKind && h.ShmSize != eh.ShmSize {
		return errors.New("inference shared memory policy drifted")
	}
	if !slices.EqualFunc(h.Ulimits, eh.Ulimits, func(a, b *container.Ulimit) bool { return a != nil && b != nil && *a == *b }) {
		return errors.New("managed resource limits drifted")
	}
	env := func(values []string) map[string]string {
		m := map[string]string{}
		for _, v := range values {
			k, s, _ := strings.Cut(v, "=")
			m[k] = s
		}
		return m
	}
	expected := env(imageEnv)
	maps.Copy(expected, env(ec.Env))
	if !maps.Equal(expected, env(c.Config.Env)) {
		return errors.New("managed runtime environment drifted")
	}
	if len(c.Mounts) != len(eh.Mounts) {
		return errors.New("managed runtime mounts drifted")
	}
	for _, m := range eh.Mounts {
		found := false
		for _, actual := range c.Mounts {
			if actual.Type == m.Type && actual.Destination == m.Target && actual.RW == !m.ReadOnly && ((m.Type == mount.TypeVolume && actual.Name == m.Source) || (m.Type == mount.TypeBind && actual.Source == m.Source)) {
				found = true
			}
		}
		if !found {
			return errors.New("managed persistent storage binding drifted")
		}
	}
	return nil
}

func sameDevices(a, b []container.DeviceRequest) bool {
	return slices.EqualFunc(a, b, func(a, b container.DeviceRequest) bool {
		return a.Driver == b.Driver && a.Count == b.Count && slices.Equal(a.DeviceIDs, b.DeviceIDs) && maps.Equal(a.Options, b.Options) && slices.EqualFunc(a.Capabilities, b.Capabilities, func(a, b []string) bool { return slices.Equal(a, b) })
	})
}

// ReadFile is an offline Docker archive read, including stopped containers. A
// transport/authentication error must never become a missing file or resource.
func (d *Docker) ReadFile(ctx context.Context, id, path string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r, err := d.API.CopyFromContainer(ctx, id, client.CopyFromContainerOptions{SourcePath: path})
	if err != nil {
		return nil, err
	}
	defer r.Content.Close()
	t := tar.NewReader(io.LimitReader(r.Content, limit+4096))
	h, err := t.Next()
	if err != nil || h.Typeflag != tar.TypeReg || h.Size < 1 || h.Size > limit {
		return nil, errors.New("runtime file observation is partial or invalid")
	}
	b, err := io.ReadAll(t)
	if err != nil || int64(len(b)) != h.Size {
		return nil, errors.New("runtime file stream incomplete")
	}
	if _, err = t.Next(); !errors.Is(err, io.EOF) {
		return nil, errors.New("runtime file observation has unexpected members")
	}
	return b, nil
}

func (d *Docker) Ensure(ctx context.Context, want Spec, id string) (*Observation, error) {
	o, err := d.Observe(ctx, want, id)
	if err != nil && !errors.Is(err, ErrPartial) {
		return nil, err
	}
	if o != nil && o.Running {
		return o, nil
	}
	if want.Kind == ServiceKind {
		check := d.CheckStart
		if check == nil {
			check = d.Capacity
		}
		if err = check(ctx, want, o); err != nil {
			return nil, err
		}
	}
	if o == nil {
		if id != "" {
			return nil, errors.New("bound runtime missing; resources retained")
		}
		if err = d.ensureImage(ctx, want); err != nil {
			return nil, err
		}
		if err = d.ensureNetwork(ctx, want); err != nil {
			return nil, err
		}
		v, err := d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
		if errdefs.IsNotFound(err) {
			if _, err = d.API.VolumeCreate(ctx, client.VolumeCreateOptions{Name: want.Volume(), Driver: "local", Labels: want.labels()}); err != nil {
				return nil, errors.New("volume create outcome unknown; retain intent and reapply")
			}
			v, err = d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
		}
		if err != nil {
			return nil, errors.New("persistent volume observation failed")
		}
		if err = verifyVolume(want, v.Volume); err != nil {
			return nil, err
		}
		c, h := want.Container(v.Volume.Mountpoint)
		created, err := d.API.ContainerCreate(ctx, client.ContainerCreateOptions{Name: want.Name, Config: c, HostConfig: h})
		if err != nil || created.ID == "" {
			return nil, errors.New("container create outcome unknown; retain intent and reapply")
		}
		o = &Observation{Spec: want, ContainerID: created.ID, DataPath: v.Volume.Mountpoint, Initialized: want.Kind == ServiceKind}
	}
	if want.Kind == GatewayKind && !o.Initialized {
		if err = d.initializeGateway(ctx, want, o); err != nil {
			return nil, err
		}
	}
	// Reconcile by immutable identity before starting, never by process name.
	o, err = d.Observe(ctx, want, id)
	if err != nil || o == nil {
		return nil, errors.New("runtime changed before start; retained for inspection")
	}
	if _, err = d.API.ContainerStart(ctx, o.ContainerID, client.ContainerStartOptions{}); err != nil {
		return nil, errors.New("runtime start outcome unknown; retain intent and reapply")
	}
	return d.Observe(ctx, want, id)
}

func (d *Docker) ensureImage(ctx context.Context, s Spec) error {
	i, err := d.API.ImageInspect(ctx, s.Image())
	if errdefs.IsNotFound(err) {
		// Model-specific artifacts are local experiment outputs. Do not silently
		// fetch an unqualified image from a similarly named registry repository.
		if s.Kind == ServiceKind {
			return errors.New("pinned Spark artifact is not loaded; build the reproducible runtime locally")
		}
		r, e := d.API.ImagePull(ctx, s.Image(), client.ImagePullOptions{})
		if e != nil {
			return errors.New("gateway image pull failed")
		}
		e = r.Wait(ctx)
		r.Close()
		if e != nil {
			return errors.New("gateway image pull incomplete")
		}
		i, err = d.API.ImageInspect(ctx, s.Image())
	}
	if err != nil || i.ID == "" || i.Architecture != "arm64" || i.Os != "linux" {
		return errors.New("runtime image is unavailable or incompatible with Spark")
	}
	if s.Kind == ServiceKind && (i.Config == nil || i.Config.Labels["org.nemoclaw.backend"] != s.Service.Backend || i.Config.Labels["org.nemoclaw.model"] != s.Service.Model.Revision) {
		return errors.New("image does not contain the pinned Spark backend")
	}
	return nil
}

func (d *Docker) ensureNetwork(ctx context.Context, s Spec) error {
	n, err := d.API.NetworkInspect(ctx, s.Network(), client.NetworkInspectOptions{})
	if err == nil {
		return verifyNetwork(s, n.Network)
	}
	if !errdefs.IsNotFound(err) {
		return errors.New("network observation failed")
	}
	if s.Kind != GatewayKind {
		return errors.New("managed gateway network is absent")
	}
	all, err := d.API.NetworkList(ctx, client.NetworkListOptions{})
	if err != nil {
		return errors.New("cannot observe network capacity")
	}
	want := netip.MustParsePrefix(s.Gateway.NetworkCIDR)
	for _, n := range all.Items {
		for _, ip := range n.IPAM.Config {
			if ip.Subnet.IsValid() && want.Overlaps(ip.Subnet) {
				return errors.New("managed gateway subnet overlaps an existing Docker network")
			}
		}
	}
	_, err = d.API.NetworkCreate(ctx, s.Network(), client.NetworkCreateOptions{Driver: "bridge", Labels: s.labels(), IPAM: &network.IPAM{Driver: "default", Config: []network.IPAMConfig{{Subnet: netip.MustParsePrefix(s.Gateway.NetworkCIDR), Gateway: netip.MustParseAddr(s.Gateway.Bridge())}}}})
	if err != nil {
		return errors.New("network create outcome unknown; retain intent and reapply")
	}
	n, err = d.API.NetworkInspect(ctx, s.Network(), client.NetworkInspectOptions{})
	if err != nil {
		return errors.New("created network observation failed")
	}
	return verifyNetwork(s, n.Network)
}

func (d *Docker) initializeGateway(ctx context.Context, s Spec, o *Observation) error {
	name := s.Name + "-initialize"
	i, err := d.API.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
	if errdefs.IsNotFound(err) {
		created, e := d.API.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: &container.Config{Image: s.Image(), User: "0:0", Labels: s.labels(), Entrypoint: []string{"/usr/local/bin/openshell-gateway"}, Cmd: []string{"generate-certs", "--output-dir", o.DataPath + "/tls", "--server-san", "127.0.0.1"}}, HostConfig: &container.HostConfig{NetworkMode: "none", CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges"}, Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: s.Volume(), Target: o.DataPath}}}})
		if e != nil {
			return errors.New("gateway credential initialization outcome unknown")
		}
		i, err = d.API.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	}
	if err != nil || i.Container.Config == nil || i.Container.State == nil {
		return errors.New("gateway initializer observation failed")
	}
	if err = verifyLabels(s.labels(), i.Container.Config.Labels); err != nil {
		return err
	}
	if i.Container.State.Status == container.StateCreated {
		if _, err = d.API.ContainerStart(ctx, i.Container.ID, client.ContainerStartOptions{}); err != nil {
			return errors.New("gateway initializer start outcome unknown")
		}
	}
	w := d.API.ContainerWait(ctx, i.Container.ID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-w.Error:
		return errors.New("gateway initializer wait failed")
	case result := <-w.Result:
		if result.StatusCode != 0 || result.Error != nil {
			return errors.New("gateway credential initialization failed; container retained")
		}
	}
	b := s.GatewayConfig(o.DataPath)
	if err = d.copySupervisor(ctx, s, o); err != nil {
		return err
	}
	var archive bytes.Buffer
	t := tar.NewWriter(&archive)
	if err = t.WriteHeader(&tar.Header{Name: "gateway.toml", Mode: 0600, Size: int64(len(b)), ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	if _, err = t.Write(b); err != nil {
		return err
	}
	if err = t.Close(); err != nil {
		return err
	}
	if _, err = d.API.CopyToContainer(ctx, o.ContainerID, client.CopyToContainerOptions{DestinationPath: o.DataPath, Content: &archive}); err != nil {
		return errors.New("gateway configuration write outcome unknown")
	}
	// Retain the completed initializer until the gateway state is established.
	// Its name and generation allow interrupted create to reconcile without rekeying.
	return nil
}

func (d *Docker) copySupervisor(ctx context.Context, s Spec, o *Observation) error {
	if _, err := d.API.ImageInspect(ctx, SupervisorImage); errdefs.IsNotFound(err) {
		r, e := d.API.ImagePull(ctx, SupervisorImage, client.ImagePullOptions{})
		if e != nil {
			return errors.New("pinned supervisor image pull failed")
		}
		e = r.Wait(ctx)
		r.Close()
		if e != nil {
			return errors.New("pinned supervisor image pull incomplete")
		}
	} else if err != nil {
		return errors.New("supervisor image observation failed")
	}
	name := s.Name + "-supervisor-source"
	c, err := d.API.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
	if errdefs.IsNotFound(err) {
		created, e := d.API.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: &container.Config{Image: SupervisorImage, Labels: s.labels()}, HostConfig: &container.HostConfig{NetworkMode: "none"}})
		if e != nil {
			return errors.New("supervisor extraction outcome unknown")
		}
		c, err = d.API.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	}
	if err != nil || c.Container.Config == nil || c.Container.Config.Image != SupervisorImage || c.Container.State == nil || c.Container.State.Running {
		return errors.New("supervisor extraction identity is unobservable")
	}
	if err = verifyLabels(s.labels(), c.Container.Config.Labels); err != nil {
		return err
	}
	b, err := d.ReadFile(ctx, c.Container.ID, "/openshell-sandbox", 128<<20)
	if err != nil {
		return errors.New("supervisor source extraction failed")
	}
	h := sha256.Sum256(b)
	if hex.EncodeToString(h[:]) != SupervisorSHA256 {
		return errors.New("supervisor source differs from pinned binary")
	}
	var archive bytes.Buffer
	t := tar.NewWriter(&archive)
	if err = t.WriteHeader(&tar.Header{Name: "openshell-sandbox", Mode: 0755, Size: int64(len(b)), ModTime: time.Unix(0, 0)}); err != nil {
		return err
	}
	if _, err = t.Write(b); err != nil {
		return err
	}
	if err = t.Close(); err != nil {
		return err
	}
	if _, err = d.API.CopyToContainer(ctx, o.ContainerID, client.CopyToContainerOptions{DestinationPath: o.DataPath, Content: &archive}); err != nil {
		return errors.New("supervisor artifact write outcome unknown")
	}
	if _, err = d.API.ContainerRemove(ctx, c.Container.ID, client.ContainerRemoveOptions{}); err != nil {
		return errors.New("completed supervisor extraction cleanup failed")
	}
	return nil
}

func (o Observation) String() string { return fmt.Sprintf("%s %s", o.Spec.Kind, o.Spec.Name) }
