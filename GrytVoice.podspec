require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The native voice engine for React Native on iOS (GRYT-1822): native/core in C, libopus compiled from the
# pinned source native/opus/source.sh unpacks, and a small Expo module over it. At the package root so it can see native/.
Pod::Spec.new do |s|
  s.name           = 'GrytVoice'
  s.version        = package['version']
  s.summary        = 'Gryt voice: low-latency voice over encrypted UDP.'
  s.description    = 'The native voice engine: capture, effects, Opus, jitter buffer and playback, sending to a Gryt SFU over encrypted UDP.'
  s.author         = 'Gryt'
  s.homepage       = 'https://gryt.chat'
  s.license        = { :type => package['license'] }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Gryt-chat/voice.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  opus = 'native/build/opus-src'
  s.source_files = [
    'ios/*.{swift,m}',
    'native/core/{voice,net,seal,engine,effects,jitter,packet}.{c,h}',
    'native/core/{device,codec}.h',
    'codec/opus/shim.c',
    'native/vendor/monocypher/monocypher.{c,h}',
    "#{opus}/{celt,silk,silk/float,src}/*.{c,h}",
    "#{opus}/include/*.h",
  ]
  s.exclude_files = [
    "#{opus}/src/{opus_demo,opus_compare,repacketizer_demo}.c",
    "#{opus}/celt/opus_custom_demo.c",
  ]
  s.public_header_files = 'native/core/{voice,effects}.h'
  s.preserve_paths = ['native/vendor/miniaudio/*', 'native/core/device.c']
  s.frameworks = 'AVFoundation', 'CoreAudio', 'AudioToolbox'
  s.pod_target_xcconfig = {
    'GCC_C_LANGUAGE_STANDARD' => 'c11',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) OPUS_BUILD=1 USE_ALLOCA=1 HAVE_LRINTF=1 HAVE_LRINT=1',
    'HEADER_SEARCH_PATHS' => %w[include celt silk silk/float .].map { |d| "\"${PODS_TARGET_SRCROOT}/#{opus}/#{d}\"" }.join(' '),
  }
end
