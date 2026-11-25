# film-lab

Film-look grading for iPhone video, running entirely in Safari: no app, no upload, no server.

**Open:** https://jonny-world.github.io/film-lab/ (on iPhone: Share → Add to Home Screen)

## What it does
- Pick a clip from Photos → live WebGL2 preview; tap the picture for 100%, **Before / after** toggle
- **Film:** stock picker (fitted Dehancer stocks) + strength; import your own `.cube`
- **Adjust** (applied before the film stock): exposure, temperature, tint, contrast, highlights, shadows, blacks, saturation
- **Halation & bloom:** amount and size, computed from scene highlights through a multi-scale pyramid, before the film curve
- **Grain:** procedural dye clouds (soft, semi-transparent, varied in size) that develop with exposure like a negative, so grain is strongest in upper mids/highlights and rolls off near white; new grain every frame; 35mm / 2-perf / 16mm formats; amount, size, colour, tone balance
- **Lens & gate:** film softness (red layer softest, as in real colour negative), developer edge effect, vignette, rounded film border
- Export: frame-exact decode (WebCodecs) → WebGL2 → H.264 (HEVC fallback) MP4 at source resolution and timing; original AAC audio copied byte-for-byte; date/location/camera metadata kept. Save via the share sheet.
- About: version, update check, share the current LUT

## Adding Dehancer stocks
Render a clip through a Dehancer stock with grain, halation, bloom, vignette, border, breath and sharpening **off**, then:
`python3 tools/fit_stock.py ORIGINAL.mov RENDER.mov assets/luts/<id>.cube "<Stock name>"` and add it to `assets/luts/index.json`.
The render can be a trimmed section of the original; the tool finds where it starts.

## Privacy
Your video never leaves the phone. It is read, processed and encoded in the page, and the page's Content-Security-Policy blocks network requests to anywhere except this site's own files. There's no analytics, no third-party code and no server. Exports keep the original clip's metadata (date, location, camera), just as the original file does.

## The look
Fitted to a Dehancer render of an iPhone 14 SDR (Rec.709) clip:
- `assets/luts/yosemite.cube`: 33-point 3D LUT (colour and tone only), fitted on 30 aligned frame pairs. Held-out error is 2.2/255 RMSE; the full app export vs Dehancer gives ΔE76 median 1.4.
- Vignette 1 − 0.164·r^1.87 (linear light); halation: tight red fringe from highlights above 0.2 linear; softness: Gaussian σ 1.2 px at 4K
- Grain defaults calibrated against the render's grain: strength across tones, clump spectrum and colour correlation
- `assets/border.png`: rounded film gate (#0D0F13, the LUT's black), 9-sliced to any aspect ratio

`tools/`: lutlib (LUT fit/apply), fit_stock (stock fitting), make_border (gate PNG), film_ref (v1 reference).

## Requirements
iOS 17+ Safari (WebGL2 + WebCodecs). Built and tested for iOS 26.
