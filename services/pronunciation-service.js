(function (global) {
  const AUDIO_TIMEOUT_MS = 8000;
  const AUDIO_CACHE_LIMIT = 20;
  const AUDIO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_AUDIO_RETRIES = 1;
  const AUDIO_RETRY_BASE_DELAY_MS = 160;
  const AUDIO_RETRY_JITTER_MS = 220;
  const audioCache = new Map();

  function normalizeLang(value) {
    return (value || "").toLowerCase().trim();
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
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
    const lang = normalizeLang(langCode);
    return [buildGoogleTwObUrl(text, lang), buildGoogleGtxUrl(text, lang)];
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
