#!/bin/sh
# Unpacks libopus's C source from the same pinned tarball as codec/opus/build.sh into native/build/opus-src,
# for builds that compile it themselves: the iOS pod and the Android CMake. Run from the repo root.
set -eu
OPUS=1.5.2
SHA=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
out="$(pwd)/native/build/opus-src"
[ -f "$out/include/opus.h" ] && exit 0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/opus.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS.tar.gz"
echo "$SHA  $work/opus.tar.gz" | shasum -a 256 -c - > /dev/null
tar xzf "$work/opus.tar.gz" -C "$work"
mkdir -p "$out"
for d in celt silk src include COPYING; do cp -R "$work/opus-$OPUS/$d" "$out/"; done
