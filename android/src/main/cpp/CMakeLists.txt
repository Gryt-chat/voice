# native/core, libopus and the JNI bridge as one library, the Android side of GrytVoice.podspec.
cmake_minimum_required(VERSION 3.22)
project(gryt_voice C)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../..)
set(OPUS ${ROOT}/native/build/opus-src)
# A test build can swap the device for a stand-in, as build-helper.mjs's GV_DEVICE does.
set(GV_DEVICE ${ROOT}/native/core/device.c CACHE FILEPATH "The device layer")

file(GLOB OPUS_SOURCES ${OPUS}/celt/*.c ${OPUS}/silk/*.c ${OPUS}/silk/float/*.c ${OPUS}/src/*.c)
list(FILTER OPUS_SOURCES EXCLUDE REGEX "/(opus_demo|opus_compare|repacketizer_demo|opus_custom_demo)\\.c$")

add_library(gryt_voice SHARED
  gryt_voice_jni.c
  ${GV_DEVICE}
  ${ROOT}/native/core/voice.c ${ROOT}/native/core/net.c ${ROOT}/native/core/ws.c ${ROOT}/native/core/seal.c ${ROOT}/native/core/engine.c
  ${ROOT}/native/core/effects.c ${ROOT}/native/core/jitter.c ${ROOT}/native/core/packet.c
  ${ROOT}/codec/opus/shim.c ${ROOT}/native/vendor/monocypher/monocypher.c
  ${OPUS_SOURCES})
set_property(TARGET gryt_voice PROPERTY C_STANDARD 11)
target_compile_definitions(gryt_voice PRIVATE OPUS_BUILD=1 USE_ALLOCA=1 HAVE_LRINTF=1 HAVE_LRINT=1 _DEFAULT_SOURCE)
target_compile_options(gryt_voice PRIVATE -O2)
target_include_directories(gryt_voice PRIVATE ${ROOT}/native/core ${OPUS}/include ${OPUS}/celt ${OPUS}/silk ${OPUS}/silk/float ${OPUS})
target_link_libraries(gryt_voice log dl m)
