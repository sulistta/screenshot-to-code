from llm import Llm

# Default primary-model preference order when every provider key is
# available. Refreshed 2026-07-27 from judged evals on the jun-21 set
# (see the "Jul 24 session" matrix): sol max is the quality anchor
# (8.2/10 avg), opus 5 medium the best non-anchor (7.8), 3.1 pro the
# third take (7.2), and 3-flash high the fast slot (zero failures).
ALL_KEYS_MODELS_DEFAULT = (
    Llm.CLAUDE_OPUS_5_MEDIUM,
    Llm.GEMINI_3_FLASH_PREVIEW_HIGH,
    Llm.GEMINI_3_1_PRO_PREVIEW_HIGH,
    Llm.GPT_5_6_SOL_MAX,
)
