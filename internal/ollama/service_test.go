// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package ollama

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"encoding/json/v2"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

func TestServiceRecoveryRetainsContainerAndStorageIdentity(t *testing.T) {
	want := ServiceSpec{Name: "owned", Owner: "deployment", Generation: "operation", Image: "ollama/ollama@sha256:" + strings.Repeat("a", 64), Network: "bridge", BindAddress: "127.0.0.1:11436"}
	var c *container.InspectResponse
	var v *volume.Volume
	creates, starts := 0, 0
	failCreate := true
	unavailable := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/v1.53")
		if unavailable {
			w.WriteHeader(503)
			return
		}
		switch {
		case p == "/info":
			fmt.Fprint(w, `{"ID":"engine"}`)
		case strings.HasPrefix(p, "/images/"):
			fmt.Fprint(w, `{"Id":"image-id"}`)
		case p == "/volumes/create":
			creates++
			v = &volume.Volume{Name: want.Volume(), CreatedAt: "created-once", Driver: "local", Labels: want.labels()}
			json.MarshalWrite(w, v)
		case strings.HasPrefix(p, "/volumes/"):
			if v == nil {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"message":"absent"}`)
			} else {
				json.MarshalWrite(w, v)
			}
		case p == "/containers/create":
			if failCreate {
				failCreate = false
				w.WriteHeader(503)
				return
			}
			creates++
			var request container.CreateRequest
			if err := json.UnmarshalRead(r.Body, &request); err != nil {
				t.Error(err)
			}
			c = &container.InspectResponse{ID: "container-id", Name: "/" + want.Name, Config: request.Config, HostConfig: request.HostConfig, State: &container.State{}, Mounts: []container.MountPoint{{Type: mount.TypeVolume, Name: want.Volume(), Destination: "/root/.ollama", RW: true}}}
			fmt.Fprint(w, `{"Id":"container-id"}`)
		case strings.HasSuffix(p, "/start"):
			starts++
			c.State.Running = true
			w.WriteHeader(204)
		case strings.HasPrefix(p, "/containers/"):
			if c == nil {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"message":"absent"}`)
			} else {
				json.MarshalWrite(w, c)
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, p)
			w.WriteHeader(500)
		}
	}))
	defer s.Close()
	api, err := client.New(client.WithHost(s.URL), client.WithAPIVersion("1.53"))
	if err != nil {
		t.Fatal(err)
	}
	d := Docker{API: api}
	defer d.Close()
	if _, err = d.Ensure(t.Context(), want, ""); err == nil || creates != 1 {
		t.Fatalf("expected retained volume after failed create: %v, %d", err, creates)
	}
	got, err := d.Ensure(t.Context(), want, "")
	if err != nil || got.ID != "engine/container-id/created-once" || !got.Running {
		t.Fatalf("recovery failed: %+v, %v", got, err)
	}
	if _, err = d.Ensure(t.Context(), want, got.ID); err != nil || creates != 2 || starts != 1 {
		t.Fatalf("no-op changed resources: %v, %d, %d", err, creates, starts)
	}
	c.State.Running = false
	stopped, err := d.Observe(t.Context(), want)
	if err != nil || stopped.Running || stopped.ID != got.ID {
		t.Fatalf("stopped service became absent: %+v, %v", stopped, err)
	}
	if _, err = d.Ensure(t.Context(), want, got.ID); err != nil || creates != 2 || starts != 2 {
		t.Fatalf("restart replaced data: %v", err)
	}
	for _, failure := range []string{"owner", "volume", "identity", "transport"} {
		t.Run(failure, func(t *testing.T) {
			oldC, oldV := c, v
			oldOwner := c.Config.Labels[ownerLabel]
			id := got.ID
			switch failure {
			case "owner":
				c.Config.Labels[ownerLabel] = "foreign"
			case "volume":
				v = nil
			case "identity":
				id = "different"
			case "transport":
				unavailable = true
			}
			if _, err = d.Ensure(t.Context(), want, id); err == nil {
				t.Fatal("unsafe service mutation permitted")
			}
			c, v = oldC, oldV
			c.Config.Labels[ownerLabel] = oldOwner
			unavailable = false
			if creates != 2 || starts != 2 {
				t.Fatal("observation conflict produced effects")
			}
		})
	}
}
