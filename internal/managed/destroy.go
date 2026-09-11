// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"errors"
	"strings"

	"github.com/moby/moby/client"
)

// ObserveRemoval can confirm the loss of a process whose persistent storage
// remains. Ordinary refresh still forbids recreating a missing bound container.
func (d *Docker) ObserveRemoval(ctx context.Context, s Spec, id string) (*Observation, error) {
	if id == "" {
		return nil, errors.New("runtime deletion requires an established identity")
	}
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil || info.Info.ID == "" || !strings.HasPrefix(id, info.Info.ID+"/") {
		return nil, errors.New("runtime deletion engine identity changed or is unavailable")
	}
	o, err := d.Observe(ctx, s, "")
	if errors.Is(err, ErrPartial) {
		return nil, nil
	}
	if err != nil || o == nil {
		return nil, err
	}
	if o.ID != id {
		return nil, errors.New("runtime deletion identity changed")
	}
	return o, nil
}

func (d *Docker) RemoveContainer(ctx context.Context, s Spec, id string) error {
	o, err := d.ObserveRemoval(ctx, s, id)
	if err != nil || o == nil {
		return err
	}
	if err = d.ReplaceContainer(ctx, s, id); err != nil {
		return err
	}
	o, err = d.ObserveRemoval(ctx, s, id)
	if err != nil {
		return err
	}
	if o != nil {
		return errors.New("runtime deletion was not confirmed; retain state and rerun destroy")
	}
	return nil
}
