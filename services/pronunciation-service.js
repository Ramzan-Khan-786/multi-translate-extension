(function (global) {
  const AUDIO_TIMEOUT_MS = 8000;

  function normalizeLang(value) {
    return (value || "").toLowerCase().trim();
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, dataUrl: "" };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!looksLikeAudioContentType(contentType)) {
        return { ok: false, dataUrl: "" };
      }
      const buffer = await response.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        return { ok: false, dataUrl: "" };
      }

      return {
        ok: true,
        dataUrl: arrayBufferToDataUrl(buffer, contentType || "audio/mpeg"),
      };
    } catch (_) {
      return { ok: false, dataUrl: "" };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function buildCandidateUrls(text, langCode) {
    const lang = normalizeLang(langCode);
    const urls = [];

    // For Farsi, try two sources aggressively.
    if (lang === "fa") {
      urls.push(buildGoogleGtxUrl(text, "fa"));
      urls.push(buildGoogleTwObUrl(text, "fa"));
      return urls;
    }

    urls.push(buildGoogleTwObUrl(text, lang));
    urls.push(buildGoogleGtxUrl(text, lang));
    return urls;
  }

  async function resolvePronunciation(text, langCode) {
    const cleanText = (text || "").trim();
    const lang = normalizeLang(langCode);
    if (!cleanText || !lang) {
      return { ok: false, spoken: false, dataUrl: "", source: "none" };
    }

    const urls = buildCandidateUrls(cleanText, lang);
    for (const url of urls) {
      const result = await fetchAudioDataUrl(url);
      if (result.ok && result.dataUrl) {
        return {
          ok: true,
          spoken: false,
          dataUrl: result.dataUrl,
          source: "remote_tts",
        };
      }
    }

    return { ok: false, spoken: false, dataUrl: "", source: "none" };
  }

  global.PronunciationService = {
    resolvePronunciation,
  };
})(self);
