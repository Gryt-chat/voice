/* JNI for GrytVoiceModule.kt: native/core/voice.h, one handle as a jlong. */
#include <jni.h>
#include <stdlib.h>

#include "voice.h"

#define FN(name) Java_chat_gryt_voice_GrytVoiceModule_00024Native_##name
#define V ((gv_voice *)(intptr_t)h)

/* Order: volume, gateThreshold, gateReleaseMs, gateSmoothing, autoGain, autoGainTargetDb, compressor,
   compressorAmount, limiter, as GrytVoiceModule.kt packs them. */
static gv_effect_settings settings(JNIEnv *env, jdoubleArray a) {
  double e[9] = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
  if ((*env)->GetArrayLength(env, a) >= 9) (*env)->GetDoubleArrayRegion(env, a, 0, 9, e);
  return (gv_effect_settings){e[0], e[1], e[2], e[3], (int)e[4], e[5], (int)e[6], e[7], (int)e[8]};
}

JNIEXPORT jlong JNICALL FN(start)(JNIEnv *env, jclass cls, jobjectArray addrs, jint session, jbyteArray key,
                                  jdoubleArray effects, jint period) {
  (void)cls;
  int n = (*env)->GetArrayLength(env, addrs);
  if (n <= 0 || n > 16 || (*env)->GetArrayLength(env, key) != 32) return 0;
  const char *list[16];
  jstring strs[16];
  for (int i = 0; i < n; i++) {
    strs[i] = (*env)->GetObjectArrayElement(env, addrs, i);
    list[i] = (*env)->GetStringUTFChars(env, strs[i], NULL);
  }
  uint8_t k[32];
  (*env)->GetByteArrayRegion(env, key, 0, 32, (jbyte *)k);
  gv_effect_settings s = settings(env, effects);
  gv_voice *v = gv_voice_start(list, n, (uint32_t)session, k, &s, (unsigned)period, NULL);
  for (int i = 0; i < n; i++) (*env)->ReleaseStringUTFChars(env, strs[i], list[i]);
  return (jlong)(intptr_t)v;
}

JNIEXPORT void JNICALL FN(stop)(JNIEnv *env, jclass cls, jlong h) { (void)env, (void)cls, gv_voice_stop(V); }
JNIEXPORT void JNICALL FN(setSending)(JNIEnv *env, jclass cls, jlong h, jboolean on) { (void)env, (void)cls, gv_voice_set_sending(V, on); }
JNIEXPORT void JNICALL FN(setOutputGain)(JNIEnv *env, jclass cls, jlong h, jfloat g) { (void)env, (void)cls, gv_voice_set_output_gain(V, g); }
JNIEXPORT void JNICALL FN(setBitrate)(JNIEnv *env, jclass cls, jlong h, jint b) { (void)env, (void)cls, gv_voice_set_bitrate(V, b); }
JNIEXPORT jint JNICALL FN(route)(JNIEnv *env, jclass cls, jlong h) { (void)env, (void)cls; return gv_voice_route(V); }

JNIEXPORT void JNICALL FN(setEffects)(JNIEnv *env, jclass cls, jlong h, jdoubleArray effects) {
  (void)cls;
  gv_effect_settings s = settings(env, effects);
  gv_voice_set_effects(V, &s);
}

JNIEXPORT void JNICALL FN(setGains)(JNIEnv *env, jclass cls, jlong h, jintArray ids, jfloatArray gains) {
  (void)cls;
  int n = (*env)->GetArrayLength(env, ids);
  if ((*env)->GetArrayLength(env, gains) < n) n = (*env)->GetArrayLength(env, gains);
  if (n > 256) n = 256;
  uint32_t i[256];
  float g[256];
  (*env)->GetIntArrayRegion(env, ids, 0, n, (jint *)i);
  (*env)->GetFloatArrayRegion(env, gains, 0, n, g);
  gv_voice_set_gains(V, i, g, n);
}

/* The list readers fill arrays Kotlin allocates and return how many entries they wrote. */
JNIEXPORT jint JNICALL FN(speaking)(JNIEnv *env, jclass cls, jlong h, jintArray out) {
  (void)cls;
  uint32_t ids[16];
  int n = gv_voice_speaking(V, ids, 16);
  (*env)->SetIntArrayRegion(env, out, 0, n, (jint *)ids);
  return n;
}

/* mic[0] is the mic's dBFS, mic[1] 1 when it's speaking. */
JNIEXPORT jint JNICALL FN(levels)(JNIEnv *env, jclass cls, jlong h, jintArray out_ids, jfloatArray out_db, jfloatArray mic) {
  (void)cls;
  uint32_t ids[16];
  float db[16], m[2];
  int speaking = 0;
  int n = gv_voice_levels(V, ids, db, 16, &m[0], &speaking);
  m[1] = (float)speaking;
  (*env)->SetIntArrayRegion(env, out_ids, 0, n, (jint *)ids);
  (*env)->SetFloatArrayRegion(env, out_db, 0, n, db);
  (*env)->SetFloatArrayRegion(env, mic, 0, 2, m);
  return n;
}

JNIEXPORT jint JNICALL FN(buffered)(JNIEnv *env, jclass cls, jlong h, jintArray out_ids, jfloatArray out_ms) {
  (void)cls;
  uint32_t ids[16];
  float ms[16];
  int n = gv_voice_buffered(V, ids, ms, 16);
  (*env)->SetIntArrayRegion(env, out_ids, 0, n, (jint *)ids);
  (*env)->SetFloatArrayRegion(env, out_ms, 0, n, ms);
  return n;
}

JNIEXPORT jint JNICALL FN(rtt)(JNIEnv *env, jclass cls, jlong h, jintArray out_ids, jfloatArray out_ms) {
  (void)cls;
  uint32_t ids[16];
  float ms[16];
  int n = gv_voice_rtt(V, ids, ms, 16);
  (*env)->SetIntArrayRegion(env, out_ids, 0, n, (jint *)ids);
  (*env)->SetFloatArrayRegion(env, out_ms, 0, n, ms);
  return n;
}

JNIEXPORT jint JNICALL FN(concealed)(JNIEnv *env, jclass cls, jlong h, jintArray out_ids, jintArray out_frames) {
  (void)cls;
  uint32_t ids[16], frames[16];
  int n = gv_voice_concealed(V, ids, frames, 16);
  (*env)->SetIntArrayRegion(env, out_ids, 0, n, (jint *)ids);
  (*env)->SetIntArrayRegion(env, out_frames, 0, n, (jint *)frames);
  return n;
}
