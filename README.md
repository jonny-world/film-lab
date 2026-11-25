# film-lab

Film-look grading for iPhone video, running entirely in Safari: no app, no upload, no server.

**Open:** https://jonny-world.github.io/film-lab/ (on iPhone: Share → Add to Home Screen)

## What it does
- Pick a clip from Photos → live WebGL2 preview with the look applied
- Controls: Look strength, Exposure, Halation, Bloom, Grain, Grain size, Softness, Vignette, Film border on/off
- Tap the picture for a 100% view; hold **original** to compare
- Export: frame-exact decode (WebCodecs `VideoDecoder`) → WebGL2 → `VideoEncoder` (H.264, HEVC fallback) → MP4 at the source resolution and frame timing. The original AAC audio is copied byte-for-byte (no re-encode), and the clip's date/location/camera metadata is carried over.
- Save via the share sheet ("Save Video")

## The look
Fitted to a Dehancer render of an iPhone 14 SDR (Rec.709) clip:
- `assets/film-lab.cube`: 33-point 3D LUT (colour and tone only), fitted on 30 aligned frame pairs. Held-out error is 2.2/255 RMSE; the full app export vs Dehancer gives ΔE76 median 1.4.
- Vignette 1 − 0.164·r^1.87 (linear light); halation: red/orange spread of highlights above 0.2 linear, ~10 px at 4K; softness: Gaussian σ 1.2 px at 4K
- Grain: two-octave, ~70% channel-correlated, amplitude ∝ (4L(1−L))^0.3, calibrated after H.264 encoding
- `assets/border.png`: rounded film gate (#0D0F13, the LUT's black), 9-sliced to any aspect ratio

`tools/` holds the Python reference used for fitting and for checking the shaders (lutlib = LUT fit/apply, film_ref = pipeline reference, make_border = gate PNG).

## Requirements
iOS 17+ Safari (WebGL2 + WebCodecs). Built and tested for iOS 26.
