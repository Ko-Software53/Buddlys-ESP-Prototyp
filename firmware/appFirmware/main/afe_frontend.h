#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Audio Front-End (esp-sr AFE) wrapper for acoustic echo cancellation.
 *
 * The board's ES7210 ADC is read in 4-slot TDM (two mics + a hardware loopback of
 * the speaker output). This module feeds those 4 channels into esp-sr's AFE
 * (AFE_TYPE_VC) and hands back an echo-cancelled MONO stream. Because Buddly's own
 * voice is removed, a VAD run on this stream detects only the child — even while
 * the speaker is playing — which is what makes barge-in possible.
 *
 * Threading: afe_frontend_init() spawns an internal feed task that continuously
 * reads the codec and feeds the AFE. The caller pulls cleaned audio with
 * afe_frontend_read_frame(), which must be called regularly (it drains the AFE's
 * fetch queue). It blocks until the requested number of samples is available
 * (~realtime), so it paces a capture loop the same way a blocking codec read did.
 */

/** Initialise the AFE and start the feed task. Call once after the codec record
 *  handle has been opened as MIC_TDM_CHANNELS channels. Returns true on success. */
bool afe_frontend_init(void);

/** Block until `n_samples` of echo-cancelled 16 kHz mono audio are available and
 *  copy them into `out`. Returns true on success, false if the AFE isn't ready. */
bool afe_frontend_read_frame(int16_t *out, int n_samples);

#ifdef __cplusplus
}
#endif
