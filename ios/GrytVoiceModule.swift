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

    /// Which offered address answered, or -1 while none has.
    Function("route") { () -> Int in
      guard let voice = self.voice else { return -1 }
      return Int(gv_voice_route(voice))
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
