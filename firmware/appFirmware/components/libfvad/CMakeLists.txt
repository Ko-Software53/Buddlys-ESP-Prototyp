# libfvad — voice activity detector extracted from WebRTC (BSD, see LICENSE/PATENTS).
# Vendored as an ESP-IDF component so main/ can classify mic frames as speech vs.
# non-speech instead of relying on a raw RMS energy gate (see vad_capture_chunk).
idf_component_register(
    SRCS
        "src/fvad.c"
        "src/signal_processing/division_operations.c"
        "src/signal_processing/energy.c"
        "src/signal_processing/get_scaling_square.c"
        "src/signal_processing/resample_48khz.c"
        "src/signal_processing/resample_by_2_internal.c"
        "src/signal_processing/resample_fractional.c"
        "src/signal_processing/spl_inl.c"
        "src/vad/vad_core.c"
        "src/vad/vad_filterbank.c"
        "src/vad/vad_gmm.c"
        "src/vad/vad_sp.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src" "src/vad" "src/signal_processing"
)
