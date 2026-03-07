(function (global) {
  const DEFAULT_TIMEOUT_MS = 5000;
  const MAX_RETRIES = 1;
  const RETRY_BASE_DELAY_MS = 140;
  const RETRY_JITTER_MS = 200;

  function buildTranslateUrl(text, targetLang, sourceLang = "auto") {
    const q = encodeURIComponent(text);
    return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=rm&q=${q}`;
  }

  function buildDictionaryUrl(text) {
    return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.toLowerCase())}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRetryDelayMs() {
    return RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
  }

  function isRetriableStatus(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          const payload = { ok: false, status: response.status, data: null };
          if (attempt < MAX_RETRIES && isRetriableStatus(response.status)) {
            await sleep(getRetryDelayMs());
            continue;
          }
          return payload;
        }
        const data = await response.json();
        return { ok: true, status: response.status, data };
      } catch (_) {
        if (attempt < MAX_RETRIES) {
          await sleep(getRetryDelayMs());
          continue;
        }
        return { ok: false, status: 0, data: null };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, status: 0, data: null };
  }

  function parseDictionary(dictResponse) {
    if (!dictResponse?.ok) {
      return {
        definition: "Definition not found",
        phonetic: "",
      };
    }

    const entry = Array.isArray(dictResponse.data) ? dictResponse.data[0] : null;
    const meaning = entry?.meanings?.[0];

    return {
      definition: meaning?.definitions?.[0]?.definition || "Definition not found",
      phonetic: entry?.phonetic || entry?.phonetics?.find((p) => p?.text)?.text || "",
    };
  }

  async function fetchTranslationResponse(
    text,
    targetLang,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sourceLang = "auto",
  ) {
    return fetchJsonWithTimeout(buildTranslateUrl(text, targetLang, sourceLang), timeoutMs);
  }

  async function fetchDictionaryResponse(text, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return fetchJsonWithTimeout(buildDictionaryUrl(text), timeoutMs);
  }

  global.TranslationService = {
    fetchDictionaryResponse,
    fetchTranslationResponse,
    parseDictionary,
  };
})(self);
