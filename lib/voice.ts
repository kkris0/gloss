/**
 * Read aloud needs a hosted voice service, which this deployment does not use:
 * /api/speak answers "unsupported" and the player says so. The chunk size
 * stays, so the player's splitting is unchanged if a voice is added later.
 */

/** One request's worth of text. Paragraphs past this are split at sentence ends. */
export const TTS_MAX_CHARS = 1200;
