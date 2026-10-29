package main

// Frame analysis: a line-for-line port of src/analysis/frameExtractor.ts so the
// companion measures audio exactly like the browser does. A parity test
// (parity_test.go) compares both implementations on the same WAV file.

import (
	"math"
	"math/cmplx"
)

const (
	FrameSize     = 2048
	HopSize       = 512
	SpectrumBands = 48
)

type Measurement struct {
	RMS      float64 `json:"rms"`
	Peak     float64 `json:"peak"`
	Low      float64 `json:"low"`
	Mid      float64 `json:"mid"`
	High     float64 `json:"high"`
	Centroid float64 `json:"centroid"`
	Flatness float64 `json:"flatness"`
	Flux     float64 `json:"flux"`
	LowFlux  float64 `json:"lowFlux"`
	HighFlux float64 `json:"highFlux"`
	FluxAbs  float64 `json:"fluxAbs"`
}

type Extractor struct {
	sampleRate              float64
	win                     []float64
	buf                     []complex128
	mag                     []float64
	prevLog, prevMag        []float64
	binHz                   float64
	lowA, lowB, midB, highB int
	first                   bool
	edges                   []float64
}

func NewExtractor(sampleRate float64) *Extractor {
	n := FrameSize
	e := &Extractor{
		sampleRate: sampleRate,
		win:        make([]float64, n),
		buf:        make([]complex128, n),
		mag:        make([]float64, n/2+1),
		prevLog:    make([]float64, n/2+1),
		prevMag:    make([]float64, n/2+1),
		binHz:      sampleRate / float64(n),
		first:      true,
	}
	for i := 0; i < n; i++ {
		e.win[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n))
	}
	bin := func(hz float64) int {
		b := int(math.Round(hz / e.binHz))
		if b < 1 {
			b = 1
		}
		if b > n/2 {
			b = n / 2
		}
		return b
	}
	e.lowA, e.lowB, e.midB = bin(20), bin(150), bin(2000)
	e.highB = bin(math.Min(16000, sampleRate/2-1))
	for i := 0; i <= SpectrumBands; i++ {
		e.edges = append(e.edges, 30*math.Pow(16000.0/30.0, float64(i)/SpectrumBands))
	}
	return e
}

// fft is an iterative radix-2 Cooley-Tukey transform, in place.
func fft(a []complex128) {
	n := len(a)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			a[i], a[j] = a[j], a[i]
		}
	}
	for l := 2; l <= n; l <<= 1 {
		ang := -2 * math.Pi / float64(l)
		wl := complex(math.Cos(ang), math.Sin(ang))
		for i := 0; i < n; i += l {
			w := complex(1, 0)
			for k := 0; k < l/2; k++ {
				u := a[i+k]
				v := a[i+k+l/2] * w
				a[i+k] = u + v
				a[i+k+l/2] = u - v
				w *= wl
			}
		}
	}
}

// Process measures one frame of FrameSize samples (oldest first).
func (e *Extractor) Process(frame []float32, hopForPeak int) Measurement {
	n := FrameSize
	var sq, pk float64
	for i := 0; i < n; i++ {
		s := float64(frame[i])
		sq += s * s
		e.buf[i] = complex(s*e.win[i], 0)
		if i >= n-hopForPeak {
			if a := math.Abs(s); a > pk {
				pk = a
			}
		}
	}
	fft(e.buf)
	for k := 0; k <= n/2; k++ {
		e.mag[k] = cmplx.Abs(e.buf[k])
	}
	var lo, mi, hi, wsum, msum, logSum, fl, lfl, hfl float64
	for k := 1; k <= e.highB; k++ {
		m := e.mag[k]
		p := m * m
		switch {
		case k >= e.lowA && k < e.lowB:
			lo += p
		case k >= e.lowB && k < e.midB:
			mi += p
		case k >= e.midB:
			hi += p
		}
		wsum += float64(k) * e.binHz * m
		msum += m
		logSum += math.Log(m + 1e-10)
		lg := math.Log1p(1000 * m)
		d := lg - e.prevLog[k]
		e.prevLog[k] = lg
		if d > 0 {
			fl += d
			if k >= e.midB {
				hfl += d
			}
		}
		if k < e.lowB {
			if dl := m - e.prevMag[k]; dl > 0 {
				lfl += dl
			}
		}
		e.prevMag[k] = m
	}
	out := Measurement{RMS: math.Sqrt(sq / float64(n)), Peak: pk, Low: lo, Mid: mi, High: hi}
	if msum > 1e-9 {
		out.Centroid = wsum / msum
		out.Flatness = math.Exp(logSum/float64(e.highB)) / (msum / float64(e.highB))
	}
	if e.first {
		e.first = false
	} else {
		out.Flux, out.LowFlux, out.HighFlux = fl, lfl, hfl
		out.FluxAbs = fl / float64(e.highB)
	}
	return out
}

// Bands returns max magnitude per log-spaced display band (call after Process).
func (e *Extractor) Bands() []float64 {
	out := make([]float64, SpectrumBands)
	for b := 0; b < SpectrumBands; b++ {
		k0 := int(math.Max(1, math.Floor(e.edges[b]/e.binHz)))
		k1 := int(math.Max(float64(k0+1), math.Ceil(e.edges[b+1]/e.binHz)))
		var s float64
		for k := k0; k < k1 && k < len(e.mag); k++ {
			if e.mag[k] > s {
				s = e.mag[k]
			}
		}
		out[b] = s
	}
	return out
}
