#!/usr/bin/env bash
# Regenerate the FKS Terminal PWA raster icons from the master SVGs.
#
# Master art lives beside this script (icon.svg = purpose:any,
# icon-maskable.svg = purpose:maskable). Outputs land in ../../static/ at the
# ROOT (SvelteKit serves static/ at /), matching the manifest + app.html paths
# and the adapter's pre-login static allowlist (PUBLIC_STATIC_EXACT).
#
# No npm dependency: uses inkscape (crisp SVG raster) + ImageMagick (alpha flatten
# for the opaque apple-touch-icon). Re-run after editing a master to rebrand.
#
#   ./scripts/icons/generate.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
static="$(cd "$here/../../static" && pwd)"
bg="#07070d"

render() {  # <svg> <size> <out>
  inkscape "$1" --export-type=png --export-width="$2" --export-height="$2" \
    --export-filename="$3" >/dev/null 2>&1
}

# purpose: any
render "$here/icon.svg" 192 "$static/icon-192.png"
render "$here/icon.svg" 512 "$static/icon-512.png"

# purpose: maskable (glyph inside the 80% safe zone)
render "$here/icon-maskable.svg" 192 "$static/icon-maskable-192.png"
render "$here/icon-maskable.svg" 512 "$static/icon-maskable-512.png"

# iOS apple-touch-icon: 180x180, opaque (iOS composites black behind alpha and
# rounds corners itself). The master is already full-bleed opaque, but flatten
# defensively so the PNG carries no alpha channel.
render "$here/icon.svg" 180 "$static/apple-touch-icon.png"
magick "$static/apple-touch-icon.png" -background "$bg" -alpha remove -alpha off \
  "$static/apple-touch-icon.png"

echo "Icons written to $static:"
cd "$static" && ls -1 icon-*.png apple-touch-icon.png
