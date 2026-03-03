(function (global) {
  const DEFAULT_TIMEOUT_MS = 5000;

  function buildTranslateUrl(text, targetLang) {
    const q = encodeURIComponent(text);
    return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&dt=rm&q=${q}`;
  }

  function buildDictionaryUrl(text) {
    return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.toLowerCase())}`;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, status: response.status, data: null };
      }
      const data = await response.json();
      return { ok: true, status: response.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timeoutId);
    }
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

  async function fetchTranslationResponse(text, targetLang, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return fetchJsonWithTimeout(buildTranslateUrl(text, targetLang), timeoutMs);
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