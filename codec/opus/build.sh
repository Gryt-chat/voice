#!/bin/sh
# Rebuilds src/codec/opus.wasm from libopus's release tarball, in a pinned Emscripten image (GRYT-1818).
# Run from the repo root: sh codec/opus/build.sh
set -eu
OPUS=1.5.2
SHA=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
EMSDK=emscripten/emsdk:3.1.74
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/opus.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS.tar.gz"
echo "$SHA  $work/opus.tar.gz" | shasum -a 256 -c -
cp codec/opus/shim.c "$work/"
docker run --rm -v "$work":/work "$EMSDK" sh -euc "
  cd /work && tar xzf opus.tar.gz && cd opus-$OPUS
  emconfigure ./configure --disable-extra-programs --disable-doc --disable-intrinsics --disable-rtcd \
    --disable-hardening --disable-stack-protector --host=wasm32-unknown-emscripten > /dev/null
  emmake make -j4 > /dev/null
  emcc -O3 -flto -I include ../shim.c .libs/libopus.a -o ../opus.wasm \
    --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1MB -sSTACK_SIZE=64KB \
    -sEXPORTED_FUNCTIONS=_gryt_encoder_create,_gryt_encode,_gryt_encoder_destroy,_gryt_decoder_create,_gryt_decode,_gryt_decoder_destroy,_malloc,_free"
cp "$work/opus.wasm" src/codec/opus.wasm
ls -l src/codec/opus.wasm
