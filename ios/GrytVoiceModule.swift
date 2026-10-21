import AVFoundation
import ExpoModulesCore

/// The native voice engine (`native/core`, GRYT-1822) on the phone's own microphone and speaker,
/// talking to the SFU over encrypted UDP. One call at a time; JavaScript decides when.
public final class GrytVoiceModule: Module {
  private var voice: OpaquePointer?

  public func definition() -> ModuleDefinition {
    Name("GrytVoice")

    /// The room_joined offer's udp part, and the effects as `transportEffects` gives them. False if it didn't start.
    Function("start") { (addrs: [String], session: Double, key: String, effects: [String: Double]) -> Bool in
      self.stopVoice()
      Self.webRTCAudio(enabled: false)
      guard let keyData = Data(base64Encoded: key), keyData.count == 32, !addrs.isEmpty else { return false }
      var settings = Self.settings(effects)
      let cStrings = addrs.map { strdup($0) }
      defer { cStrings.forEach { free($0) } }
      let pointers: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer($0) }
      // 64 frames is 1.3 ms; iOS rounds it to what the hardware takes.
      self.voice = keyData.withUnsafeBytes { raw in
        pointers.withUnsafeBufferPointer { list in
          gv_voice_start(list.baseAddress, Int32(list.count), UInt32(session), raw.bindMemory(to: UInt8.self).baseAddress, &settings, 64)
        }
      }
      if self.voice == nil { Self.webRTCAudio(enabled: true) }
      return self.voice != nil
    }

    Function("stop") { self.stopVoice() }

    Function("setSending") { (on: Bool) in
      if let voice = self.voice { gv_voice_set_sending(voice, on ? 1 : 0) }
    }

    Function("setOutputGain") { (gain: Double) in
      if let voice = self.voice { gv_voice_set_output_gain(voice, Float(gain)) }
    }

    Function("setEffects") { (effects: [String: Double]) in
      guard let voice = self.voice else { return }
      var settings = Self.settings(effects)
      gv_voice_set_effects(voice, &settings)
    }

    /// Volume per sender id, 1 = as sent; anyone not listed plays at 1 (GRYT-1831).
    Function("setGains") { (ids: [Int], gains: [Double]) in
      guard let voice = self.voice else { return }
      let n = min(ids.count, gains.count)
      let senders = ids.prefix(n).map { UInt32(truncatingIfNeeded: $0) }
      let volumes = gains.prefix(n).map { Float($0) }
      gv_voice_set_gains(voice, senders, volumes, Int32(n))
    }

    /// Which offered address answered, or -1 while none has.
    Function("route") { () -> Int in
      guard let voice = self.voice else { return -1 }
      return Int(gv_voice_route(voice))
    }

    /// The sender ids heard speaking in the last 250 ms (GRYT-1830).
    Function("speaking") { () -> [Int] in
      guard let voice = self.voice else { return [] }
      var ids = [UInt32](repeating: 0, count: 16)
      let n = Int(gv_voice_speaking(voice, &ids, Int32(ids.count)))
      return ids.prefix(n).map { Int($0) }
    }

    /// How loud each sender and the mic are, in dBFS (-120 for silence), for the halo (GRYT-1830).
    Function("levels") { () -> [String: Any] in
      guard let voice = self.voice else { return ["ids": [Int](), "db": [Double](), "mic": -120.0, "micSpeaking": false] }
      var ids = [UInt32](repeating: 0, count: 16)
      var db = [Float](repeating: 0, count: 16)
      var mic: Float = 0
      var micSpeaking: Int32 = 0
      let n = Int(gv_voice_levels(voice, &ids, &db, Int32(ids.count), &mic, &micSpeaking))
      let floor = { (x: Float) in x.isFinite ? Double(x) : -120 }
      return ["ids": ids.prefix(n).map { Int($0) }, "db": db.prefix(n).map(floor), "mic": floor(mic), "micSpeaking": micSpeaking != 0]
    }

    /// For the latency estimate: each sender's buffered ms, and the audio session's own delays in ms.
    Function("latency") { () -> [String: Any] in
      var ids = [UInt32](repeating: 0, count: 16)
      var ms = [Float](repeating: 0, count: 16)
      let n = self.voice.map { Int(gv_voice_buffered($0, &ids, &ms, Int32(ids.count))) } ?? 0
      let session = AVAudioSession.sharedInstance()
      return [
        "ids": ids.prefix(n).map { Int($0) },
        "bufferedMs": ms.prefix(n).map { Double($0) },
        "inputMs": session.inputLatency * 1000,
        "outputMs": session.outputLatency * 1000,
        "ioBufferMs": session.ioBufferDuration * 1000,
        "sampleRate": session.sampleRate,
      ]
    }

    OnDestroy { self.stopVoice() }
  }

  private func stopVoice() {
    if let voice {
      gv_voice_stop(voice)
      Self.webRTCAudio(enabled: true)
    }
    voice = nil
  }

  /// WebRTC's own audio unit takes the shared audio session and our capture stops, so it stays off
  /// while the engine runs. By name, so this pod doesn't link WebRTC; without it there's nothing to do.
  private static func webRTCAudio(enabled: Bool) {
    guard let type = NSClassFromString("RTCAudioSession") as? NSObject.Type,
          let shared = type.perform(NSSelectorFromString("sharedInstance"))?.takeUnretainedValue() as? NSObject
    else { return }
    shared.setValue(!enabled, forKey: "useManualAudio")
    shared.setValue(enabled, forKey: "isAudioEnabled")
  }

  private static func settings(_ e: [String: Double]) -> gv_effect_settings {
    gv_effect_settings(
      volume: e["volume"] ?? 100,
      gate_threshold: e["gateThreshold"] ?? 0,
      gate_release_ms: e["gateReleaseMs"] ?? 200,
      gate_smoothing: e["gateSmoothing"] ?? 0.8,
      auto_gain: Int32(e["autoGain"] ?? 0),
      auto_gain_target_db: e["autoGainTargetDb"] ?? -20,
      compressor: Int32(e["compressor"] ?? 0),
      compressor_amount: e["compressorAmount"] ?? 50,
      limiter: Int32(e["limiter"] ?? 0)
    )
  }
}
