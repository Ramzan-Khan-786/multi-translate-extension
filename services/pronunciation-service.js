(function (global) {
  const AUDIO_TIMEOUT_MS = 8000;
  const AUDIO_CACHE_LIMIT = 20;
  const AUDIO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_AUDIO_RETRIES = 1;
  const AUDIO_RETRY_BASE_DELAY_MS = 160;
  const AUDIO_RETRY_JITTER_MS = 220;
  const audioCache = new Map();
  const CHROME_TTS_RATE = 0.95;
  const CHROME_TTS_PITCH = 1;
  const CHROME_TTS_VOLUME = 1;
  const CHROME_TTS_START_TIMEOUT_MS = 2200;

  const VOICE_HINTS = {
    ur: ["urdu", "اردو", "pak", "asad"],
    hi: ["hindi", "हिन्द", "india"],
    en: ["english", "google"],
  };

  function normalizeLang(value) {
    return (value || "").toLowerCase().trim();
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function hasChromeTts() {
    const c = global.chrome;
    return !!(c && c.tts && typeof c.tts.speak === "function");
  }

  function getVoiceHints(lang) {
    return VOICE_HINTS[lang] || [];
  }

  function getVoices() {
    return new Promise((resolve) => {
      if (!hasChromeTts()) {
        resolve([]);
        return;
      }

      try {
        global.chrome.tts.getVoices((voices) => {
          resolve(Array.isArray(voices) ? voices : []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  function scoreVoice(voice, lang) {
    if (!voice) {
      return -1;
    }

    const name = normalizeText(voice.voiceName || "").toLowerCase();
    const voiceLang = normalizeLang(voice.lang || "");
    const hints = getVoiceHints(lang);
    let score = 0;

    if (voiceLang === lang) {
      score += 100;
    } else if (voiceLang.startsWith(`${lang}-`)) {
      score += 90;
    }

    if (voice.remote === true) {
      score += 8;
    }

    if (voice.eventTypes && voice.eventTypes.includes("start")) {
      score += 3;
    }

    for (const hint of hints) {
      if (name.includes(hint)) {
        score += 22;
      }
    }

    if (name.includes("natural") || name.includes("neural") || name.includes("wavenet")) {
      score += 10;
    }

    return score;
  }

  function voiceMatchesLang(voice, lang) {
    const voiceLang = normalizeLang((voice && voice.lang) || "");
    return voiceLang === lang || voiceLang.startsWith(`${lang}-`);
  }

  function pickBestVoice(voices, lang) {
    const normalizedLang = normalizeLang(lang);
    const scored = (voices || [])
      .map((voice) => ({ voice, score: scoreVoice(voice, normalizedLang) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    return best ? best.voice : null;
  }

  async function speakWithChromeTts(text, langCode) {
    const cleanText = normalizeText(text);
    const lang = normalizeLang(langCode);
    if (!cleanText || !lang || !hasChromeTts()) {
      return { ok: false, spoken: false, voiceName: "" };
    }

    const voices = await getVoices();
    const bestVoice = pickBestVoice(voices, lang);

    // For Urdu/Hindi, don't force a mismatched voice; fallback to remote TTS instead.
    if ((lang === "ur" || lang === "hi") && (!bestVoice || !voiceMatchesLang(bestVoice, lang))) {
      return { ok: false, spoken: false, voiceName: "" };
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startTimeoutId);
        resolve(payload);
      };

      const startTimeoutId = setTimeout(() => {
        done({ ok: false, spoken: false, voiceName: "" });
      }, CHROME_TTS_START_TIMEOUT_MS);

      try {
        global.chrome.tts.stop();
      } catch (_) {
        // no-op
      }

      try {
        global.chrome.tts.speak(cleanText, {
          lang,
          voiceName: bestVoice ? bestVoice.voiceName : undefined,
          rate: CHROME_TTS_RATE,
          pitch: CHROME_TTS_PITCH,
          volume: CHROME_TTS_VOLUME,
          enqueue: false,
          requiredEventTypes: ["start", "error"],
          onEvent: (event) => {
            if (!event || !event.type) {
              return;
            }
            if (event.type === "start") {
              done({
                ok: true,
                spoken: true,
                voiceName: bestVoice ? bestVoice.voiceName || "" : "",
              });
            } else if (event.type === "error") {
              done({ ok: false, spoken: false, voiceName: "" });
            }
          },
        }, () => {
          const runtime = global.chrome && global.chrome.runtime ? global.chrome.runtime : null;
          if (runtime && runtime.lastError) {
            done({ ok: false, spoken: false, voiceName: "" });
          }
        });
      } catch (_) {
        done({ ok: false, spoken: false, voiceName: "" });
      }
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRetryDelayMs() {
    return AUDIO_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * AUDIO_RETRY_JITTER_MS);
  }

  function isRetriableStatus(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function getAudioCacheKey(text, langCode) {
    return `${normalizeLang(langCode)}::${normalizeText(text).toLowerCase()}`;
  }

  function getCachedPronunciation(cacheKey) {
    const hit = audioCache.get(cacheKey);
    if (!hit) {
      return null;
    }
    if (Date.now() - hit.ts > AUDIO_CACHE_TTL_MS) {
      audioCache.delete(cacheKey);
      return null;
    }

    // Refresh LRU position.
    audioCache.delete(cacheKey);
    audioCache.set(cacheKey, hit);
    // Never reuse "spoken-only" payloads; they don't contain replayable audio bytes.
    if (hit.value && hit.value.spoken === true && !hit.value.dataUrl) {
      return null;
    }
    return hit.value;
  }

  function cachePronunciation(cacheKey, value) {
    audioCache.set(cacheKey, { ts: Date.now(), value });
    while (audioCache.size > AUDIO_CACHE_LIMIT) {
      const oldestKey = audioCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      audioCache.delete(oldestKey);
    }
  }

  function buildGoogleTwObUrl(text, langCode) {
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(
      langCode,
    )}&client=tw-ob&ttsspeed=1`;
  }

  function buildGoogleGtxUrl(text, langCode) {
    return `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(
      langCode,
    )}&client=gtx`;
  }

  function getPreferredRemoteLangCodes(langCode) {
    const lang = normalizeLang(langCode);
    if (lang === "ur") {
      // Prefer Pakistan locale voice first, fallback to generic Urdu.
      return ["ur-PK", "ur"];
    }
    if (lang === "hi") {
      return ["hi-IN", "hi"];
    }
    if (lang === "en") {
      return ["en-US", "en"];
    }
    return [langCode];
  }

  function looksLikeAudioContentType(contentType) {
    if (!contentType) {
      return false;
    }
    const normalized = contentType.toLowerCase();
    return normalized.includes("audio/") || normalized.includes("application/octet-stream");
  }

  function arrayBufferToDataUrl(arrayBuffer, mimeType = "audio/mpeg") {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  async function fetchAudioDataUrl(url) {
    for (let attempt = 0; attempt <= MAX_AUDIO_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (attempt < MAX_AUDIO_RETRIES && isRetriableStatus(response.status)) {
            await sleep(getRetryDelayMs());
            continue;
          }
          return { ok: false, dataUrl: "" };
        }

        const buffer = await response.arrayBuffer();
        if (!buffer || buffer.byteLength === 0) {
          if (attempt < MAX_AUDIO_RETRIES) {
            await sleep(getRetryDelayMs());
            continue;
          }
          return { ok: false, dataUrl: "" };
        }

        // Reject obvious HTML/error payloads from blocked endpoints.
        try {
          const preview = new TextDecoder().decode(buffer.slice(0, 96)).toLowerCase();
          if (preview.includes("<html") || preview.includes("<!doctype")) {
            if (attempt < MAX_AUDIO_RETRIES) {
              await sleep(getRetryDelayMs());
              continue;
            }
            return { ok: false, dataUrl: "" };
          }
        } catch (_) {
          // ignore preview parsing errors
        }

        const contentType = response.headers.get("content-type") || "";
        const mimeType = looksLikeAudioContentType(contentType) ? contentType : "audio/mpeg";

        return {
          ok: true,
          dataUrl: arrayBufferToDataUrl(buffer, mimeType),
        };
      } catch (_) {
        if (attempt < MAX_AUDIO_RETRIES) {
          await sleep(getRetryDelayMs());
          continue;
        }
        return { ok: false, dataUrl: "" };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, dataUrl: "" };
  }

  function buildCandidateUrls(text, langCode) {
    const preferredCodes = getPreferredRemoteLangCodes(langCode);
    const urls = [];
    preferredCodes.forEach((code) => {
      urls.push(buildGoogleTwObUrl(text, code));
      urls.push(buildGoogleGtxUrl(text, code));
    });
    return urls;
  }

  async function resolvePronunciation(text, langCode) {
    const cleanText = normalizeText(text);
    const lang = normalizeLang(langCode);
    if (!cleanText || !lang) {
      return { ok: false, spoken: false, dataUrl: "", source: "none" };
    }

    const cacheKey = getAudioCacheKey(cleanText, lang);
    const cached = getCachedPronunciation(cacheKey);
    if (cached) {
      return cached;
    }

    // Prefer platform/system TTS voices first. This enables better Urdu voice quality
    // when available on the user's device/browser.
    const chromeTtsResult = await speakWithChromeTts(cleanText, lang);
    if (chromeTtsResult.ok && chromeTtsResult.spoken) {
      return {
        ok: true,
        spoken: true,
        dataUrl: "",
        source: "chrome_tts",
        voiceName: chromeTtsResult.voiceName || "",
      };
    }

    const urls = buildCandidateUrls(cleanText, lang);
    for (const url of urls) {
      const result = await fetchAudioDataUrl(url);
      if (result.ok && result.dataUrl) {
        const payload = {
          ok: true,
          spoken: false,
          dataUrl: result.dataUrl,
          source: "remote_tts",
        };
        cachePronunciation(cacheKey, payload);
        return payload;
      }
    }

    return { ok: false, spoken: false, dataUrl: "", source: "none" };
  }

  global.PronunciationService = {
    resolvePronunciation,
  };
})(self);
