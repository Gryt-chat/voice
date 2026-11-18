/* A share's sound through Windows process loopback: one process tree, or everything but one. */
#ifndef GRYT_VOICE_SHARE_CAPTURE_H
#define GRYT_VOICE_SHARE_CAPTURE_H

/* 48 kHz interleaved stereo, frames at a time, on the capture thread. */
typedef void (*gv_share_fn)(void *user, const float *stereo, int frames);
typedef struct gv_share gv_share;

/* include 1 takes pid's tree, 0 everything else. NULL when Windows refuses, or off Windows. */
gv_share *gv_share_start(unsigned long pid, int include, int frames, gv_share_fn fn, void *user);
void gv_share_stop(gv_share *s);

#endif
