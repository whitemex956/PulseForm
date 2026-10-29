//go:build !windows

package main

import "errors"

func newLoopbackSource() (Source, error) {
	return nil, errors.New("system audio loopback is only available on Windows; use --test-wav to test")
}

func listDevices() ([]string, error) {
	return nil, errors.New("device listing is only available on Windows")
}
