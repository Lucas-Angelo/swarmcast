// Command gen draws the tray icons (a filled, anti-aliased circle per state) and writes
// them next to it as PNG (macOS, Linux) and ICO (Windows) files.
//
// Run it with `go generate` from apps/tray; the generated files are committed.
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

type palette struct {
	name string
	fill color.NRGBA
	ring color.NRGBA
}

var states = []palette{
	{"off", color.NRGBA{0x9A, 0x9A, 0xA0, 0xFF}, color.NRGBA{0x5E, 0x5E, 0x64, 0xFF}},
	{"waiting", color.NRGBA{0xFF, 0xC4, 0x00, 0xFF}, color.NRGBA{0xA8, 0x7C, 0x00, 0xFF}},
	{"live", color.NRGBA{0x30, 0xC8, 0x56, 0xFF}, color.NRGBA{0x1A, 0x80, 0x34, 0xFF}},
}

// pngSize is drawn at 2x the 16pt macOS menu bar slot, so it stays sharp on Retina screens.
const pngSize = 32

// icoSizes are the frames stored in each ICO; Windows picks the best one for the DPI.
var icoSizes = []int{16, 20, 24, 32, 40, 48, 64}

func main() {
	out := "icons"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		log.Fatal(err)
	}
	for _, p := range states {
		var buf bytes.Buffer
		if err := png.Encode(&buf, circle(pngSize, p)); err != nil {
			log.Fatal(err)
		}
		write(filepath.Join(out, p.name+".png"), buf.Bytes())

		frames := make([]*image.NRGBA, 0, len(icoSizes))
		for _, s := range icoSizes {
			frames = append(frames, circle(s, p))
		}
		write(filepath.Join(out, p.name+".ico"), encodeICO(frames))
	}
}

func write(path string, data []byte) {
	if err := os.WriteFile(path, data, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s (%d bytes)", path, len(data))
}

// circle draws a filled circle with a thin darker ring (so it reads on light and dark
// menu bars), anti-aliased with 8x8 supersampling, on a transparent background.
func circle(size int, p palette) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	c := float64(size) / 2
	outer := float64(size) * 0.40
	ringWidth := math.Max(1, float64(size)/16)
	inner := outer - ringWidth
	const ss = 8
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var nFill, nRing int
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					dx := float64(x) + (float64(sx)+0.5)/ss - c
					dy := float64(y) + (float64(sy)+0.5)/ss - c
					d := math.Hypot(dx, dy)
					switch {
					case d <= inner:
						nFill++
					case d <= outer:
						nRing++
					}
				}
			}
			total := nFill + nRing
			if total == 0 {
				continue
			}
			mix := func(a, b uint8) uint8 {
				return uint8((int(a)*nFill + int(b)*nRing) / total)
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: mix(p.fill.R, p.ring.R),
				G: mix(p.fill.G, p.ring.G),
				B: mix(p.fill.B, p.ring.B),
				A: uint8(total * 255 / (ss * ss)),
			})
		}
	}
	return img
}

// encodeICO writes a classic ICO file with 32-bit BGRA DIB frames (plus the 1-bit AND
// mask), which every Windows version's LoadImage understands.
func encodeICO(frames []*image.NRGBA) []byte {
	var dir, data bytes.Buffer
	le := binary.LittleEndian
	_ = binary.Write(&dir, le, [3]uint16{0, 1, uint16(len(frames))})
	offset := 6 + 16*len(frames)
	for _, img := range frames {
		w, h := img.Bounds().Dx(), img.Bounds().Dy()
		var frame bytes.Buffer
		// BITMAPINFOHEADER; the height counts the XOR and AND bitmaps together.
		_ = binary.Write(&frame, le, struct {
			Size                        uint32
			Width, Height               int32
			Planes, BitCount            uint16
			Compression, ImageSize      uint32
			XPPM, YPPM, ClrUsed, ClrImp int32
		}{40, int32(w), int32(h * 2), 1, 32, 0, 0, 0, 0, 0, 0})
		for y := h - 1; y >= 0; y-- { // bottom-up rows
			for x := 0; x < w; x++ {
				c := img.NRGBAAt(x, y)
				frame.Write([]byte{c.B, c.G, c.R, c.A})
			}
		}
		maskStride := ((w + 31) / 32) * 4
		for y := h - 1; y >= 0; y-- {
			row := make([]byte, maskStride)
			for x := 0; x < w; x++ {
				if img.NRGBAAt(x, y).A == 0 {
					row[x/8] |= 0x80 >> (x % 8)
				}
			}
			frame.Write(row)
		}
		dim := func(v int) uint8 {
			if v >= 256 {
				return 0
			}
			return uint8(v)
		}
		_ = binary.Write(&dir, le, struct {
			W, H, Colors, Reserved uint8
			Planes, BitCount       uint16
			Size, Offset           uint32
		}{dim(w), dim(h), 0, 0, 1, 32, uint32(frame.Len()), uint32(offset)})
		offset += frame.Len()
		data.Write(frame.Bytes())
	}
	return append(dir.Bytes(), data.Bytes()...)
}
