package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

// wavSource streams a PCM16 / float32 WAV in real time. Used for automated tests
// on machines without Windows loopback.
type wavSource struct {
	name string
	rate float64
	mono []float32
}

func readWav(path string) ([]float32, float64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	if len(b) < 44 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, 0, errors.New("not a WAV file")
	}
	var format, ch, bits uint16
	var rate uint32
	off := 12
	for off+8 <= len(b) {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4:]))
		body := off + 8
		if id == "fmt " {
			format = binary.LittleEndian.Uint16(b[body:])
			ch = binary.LittleEndian.Uint16(b[body+2:])
			rate = binary.LittleEndian.Uint32(b[body+4:])
			bits = binary.LittleEndian.Uint16(b[body+14:])
		} else if id == "data" {
			bps := int(bits / 8)
			frames := size / (bps * int(ch))
			out := make([]float32, frames)
			for i := 0; i < frames; i++ {
				var s float32
				for c := 0; c < int(ch); c++ {
					p := body + (i*int(ch)+c)*bps
					if format == 3 {
						s += math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
					} else {
						s += float32(int16(binary.LittleEndian.Uint16(b[p:]))) / 32768
					}
				}
				out[i] = s / float32(ch)
			}
			return out, float64(rate), nil
		}
		off = body + size + size&1
	}
	return nil, 0, errors.New("WAV has no data chunk")
}

func newWavSource(path string) (Source, error) {
	mono, rate, err := readWav(path)
	if err != nil {
		return nil, err
	}
	return &wavSource{name: fmt.Sprintf("Test file %s", filepath.Base(path)), rate: rate, mono: mono}, nil
}

func (w *wavSource) Name() string        { return w.name }
func (w *wavSource) SampleRate() float64 { return w.rate }

func (w *wavSource) Run(push func([]float32), stop <-chan struct{}) error {
	const chunk = 480 // 10 ms at 48 kHz
	start := time.Now()
	pos := 0
	t := time.NewTicker(5 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return nil
		case <-t.C:
			due := int(time.Since(start).Seconds() * w.rate)
			for pos < due {
				n := chunk
				buf := make([]float32, n)
				for i := 0; i < n; i++ {
					buf[i] = w.mono[(pos+i)%len(w.mono)]
				}
				push(buf)
				pos += n
			}
		}
	}
}
