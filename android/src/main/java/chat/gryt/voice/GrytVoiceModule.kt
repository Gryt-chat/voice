package chat.gryt.voice

import android.content.Context
import android.media.AudioManager
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The native voice engine (`native/core`) on Android, with the same JS API as ios/GrytVoiceModule.swift. */
class GrytVoiceModule : Module() {
  @Volatile private var voice = 0L

  private val audio: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("GrytVoice")

    AsyncFunction("start") { addrs: List<String>, session: Double, key: String, effects: Map<String, Double> ->
      stopVoice()
      val keyBytes = runCatching { Base64.decode(key, Base64.DEFAULT) }.getOrNull()
      if (keyBytes == null || keyBytes.size != 32 || addrs.isEmpty()) return@AsyncFunction false
      // The platform's echo canceller only runs in communication mode.
      audio?.mode = AudioManager.MODE_IN_COMMUNICATION
      // 192 frames is 4 ms; AAudio rounds it to its burst.
      voice = Native.start(addrs.toTypedArray(), session.toLong().toInt(), keyBytes, settings(effects), 192)
      if (voice == 0L) audio?.mode = AudioManager.MODE_NORMAL
      voice != 0L
    }

    Function("stop") { stopVoice() }

    Function("setSending") { on: Boolean -> voice.takeIf { it != 0L }?.let { Native.setSending(it, on) } }

    Function("setOutputGain") { gain: Double -> voice.takeIf { it != 0L }?.let { Native.setOutputGain(it, gain.toFloat()) } }

    Function("setEffects") { effects: Map<String, Double> ->
      voice.takeIf { it != 0L }?.let { Native.setEffects(it, settings(effects)) }
    }

    Function("setBitrate") { bitrate: Int -> voice.takeIf { it != 0L }?.let { Native.setBitrate(it, bitrate) } }

    Function("setGains") { ids: List<Double>, gains: List<Double> ->
      val v = voice.takeIf { it != 0L } ?: return@Function
      val n = minOf(ids.size, gains.size)
      Native.setGains(v, IntArray(n) { ids[it].toLong().toInt() }, FloatArray(n) { gains[it].toFloat() })
    }

    Function("route") { voice.takeIf { it != 0L }?.let { Native.route(it) } ?: -1 }

    Function("speaking") {
      val v = voice.takeIf { it != 0L } ?: return@Function emptyList<Long>()
      val ids = IntArray(16)
      val n = Native.speaking(v, ids)
      ids.take(n).map { it.toUInt().toLong() }
    }

    Function("levels") {
      val v = voice.takeIf { it != 0L }
        ?: return@Function mapOf("ids" to emptyList<Long>(), "db" to emptyList<Double>(), "mic" to -120.0, "micSpeaking" to false)
      val ids = IntArray(16)
      val db = FloatArray(16)
      val mic = FloatArray(2)
      val n = Native.levels(v, ids, db, mic)
      val floor = { x: Float -> if (x.isFinite()) x.toDouble() else -120.0 }
      mapOf(
        "ids" to ids.take(n).map { it.toUInt().toLong() },
        "db" to db.take(n).map(floor),
        "mic" to floor(mic[0]),
        "micSpeaking" to (mic[1] != 0f),
      )
    }

    Function("latency") {
      val v = voice
      val ids = IntArray(16)
      val ms = FloatArray(16)
      val n = if (v != 0L) Native.buffered(v, ids, ms) else 0
      val rttIds = IntArray(16)
      val rttMs = FloatArray(16)
      val nr = if (v != 0L) Native.rtt(v, rttIds, rttMs) else 0
      val rtt = (0 until nr).associate { rttIds[it] to rttMs[it] }
      val cIds = IntArray(16)
      val frames = IntArray(16)
      val nc = if (v != 0L) Native.concealed(v, cIds, frames) else 0
      val concealed = (0 until nc).associate { cIds[it] to frames[it] }
      val rate = audio?.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toDoubleOrNull() ?: 48000.0
      val burst = audio?.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toDoubleOrNull() ?: 0.0
      mapOf(
        "ids" to ids.take(n).map { it.toUInt().toLong() },
        "bufferedMs" to ms.take(n).map { it.toDouble() },
        "rttMs" to ids.take(n).map { (rtt[it] ?: -1f).toDouble() },
        "concealed" to ids.take(n).map { concealed[it] ?: 0 },
        // Android doesn't say its input and output delays; the burst is the part it does say.
        "inputMs" to 0.0,
        "outputMs" to 0.0,
        "ioBufferMs" to burst / rate * 1000,
        "sampleRate" to rate,
      )
    }

    OnDestroy { stopVoice() }
  }

  @Synchronized private fun stopVoice() {
    val v = voice
    voice = 0L
    if (v != 0L) {
      Native.stop(v)
      audio?.mode = AudioManager.MODE_NORMAL
    }
  }

  private fun settings(e: Map<String, Double>) = doubleArrayOf(
    e["volume"] ?: 100.0, e["gateThreshold"] ?: 0.0, e["gateReleaseMs"] ?: 200.0, e["gateSmoothing"] ?: 0.8,
    e["autoGain"] ?: 0.0, e["autoGainTargetDb"] ?: -20.0, e["compressor"] ?: 0.0, e["compressorAmount"] ?: 50.0,
    e["limiter"] ?: 0.0,
  )

  private object Native {
    init { System.loadLibrary("gryt_voice") }
    @JvmStatic external fun start(addrs: Array<String>, session: Int, key: ByteArray, effects: DoubleArray, period: Int): Long
    @JvmStatic external fun stop(h: Long)
    @JvmStatic external fun setSending(h: Long, on: Boolean)
    @JvmStatic external fun setOutputGain(h: Long, gain: Float)
    @JvmStatic external fun setEffects(h: Long, effects: DoubleArray)
    @JvmStatic external fun setBitrate(h: Long, bitrate: Int)
    @JvmStatic external fun setGains(h: Long, ids: IntArray, gains: FloatArray)
    @JvmStatic external fun route(h: Long): Int
    @JvmStatic external fun speaking(h: Long, ids: IntArray): Int
    @JvmStatic external fun levels(h: Long, ids: IntArray, db: FloatArray, mic: FloatArray): Int
    @JvmStatic external fun buffered(h: Long, ids: IntArray, ms: FloatArray): Int
    @JvmStatic external fun rtt(h: Long, ids: IntArray, ms: FloatArray): Int
    @JvmStatic external fun concealed(h: Long, ids: IntArray, frames: IntArray): Int
  }
}
