#!/bin/sh
# Builds libopus for this machine from the same pinned tarball as the WASM build (codec/opus/build.sh), into native/build/opus.
# Run from the repo root: sh native/opus/build.sh
set -eu
OPUS=1.5.2
SHA=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
out="$(pwd)/native/build/opus"
[ -f "$out/lib/libopus.a" ] && exit 0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/opus.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS.tar.gz"
echo "$SHA  $work/opus.tar.gz" | shasum -a 256 -c - > /dev/null
cd "$work" && tar xzf opus.tar.gz && cd "opus-$OPUS"
./configure --prefix="$out" --disable-shared --enable-static --disable-extra-programs --disable-doc --with-pic > /dev/null
make -j4 > /dev/null
make install > /dev/null
ls -l "$out/lib/libopus.a"
