(function (global) {
  const ALLOWED_TARGET_LANGS = new Set(["ur", "hi"]);

  function normalizeLang(value) {
    return (value || "").toLowerCase().trim();
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function hasLatin(value) {
    return /[A-Za-z]/.test(value || "");
  }

  function normalizeAscii(value) {
    return normalizeText(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "");
  }

  function looksLikeSourceEcho(candidate, sourceText) {
    const candidateAscii = normalizeAscii(candidate);
    const sourceAscii = normalizeAscii(sourceText);
    if (!candidateAscii || !sourceAscii) {
      return false;
    }
    if (candidateAscii === sourceAscii) {
      return true;
    }
    return sourceAscii.length >= 5 && candidateAscii.includes(sourceAscii);
  }

  function sanitizeRomanized(value) {
    return normalizeText(value || "").replace(/\s*\|\s*/g, " ");
  }

  function getChunks(data) {
    return Array.isArray(data?.[0]) ? data[0] : [];
  }

  function joinChunkText(chunks, index) {
    return normalizeText(
      chunks
        .map((chunk) =>
          Array.isArray(chunk) && typeof chunk[index] === "string" ? chunk[index] : "",
        )
        .filter(Boolean)
        .join(" "),
    );
  }

  function collectChunkRomanization(chunks, index, sourceText = "") {
    return chunks
      .map((chunk) =>
        Array.isArray(chunk) && typeof chunk[index] === "string"
          ? sanitizeRomanized(chunk[index])
          : "",
      )
      .filter(
        (value) => value && hasLatin(value) && !looksLikeSourceEcho(value, sourceText),
      );
  }

  function parseTranslationResponse(translateResponse, targetLang) {
    if (!translateResponse?.ok || !Array.isArray(translateResponse.data)) {
      return { translatedText: "", romanized: "" };
    }

    const normalizedTarget = normalizeLang(targetLang);
    const chunks = getChunks(translateResponse.data);
    const translatedText = joinChunkText(chunks, 0);
    const sourceText = joinChunkText(chunks, 1);

    if (!ALLOWED_TARGET_LANGS.has(normalizedTarget)) {
      return { translatedText, romanized: "" };
    }

    // Google dt=rm usually places target romanization in chunk[2].
    // chunk[3] is commonly source pronunciation (e.g. English IPA), so avoid it here.
    const candidates = collectChunkRomanization(chunks, 2, sourceText);
    let romanized = candidates.length > 0 ? candidates.join(" ") : "";

    return {
      translatedText,
      romanized: sanitizeRomanized(romanized).toLowerCase(),
    };
  }

  function parseRomanizationFromBackTranslationResponse(translateResponse) {
    if (!translateResponse?.ok || !Array.isArray(translateResponse.data)) {
      return "";
    }

    const chunks = getChunks(translateResponse.data);
    const sourceText = joinChunkText(chunks, 1);
    // Back-translation (ur/hi -> en) usually carries source romanization in chunk[3].
    const candidates = [
      ...collectChunkRomanization(chunks, 3, sourceText),
      ...collectChunkRomanization(chunks, 2, sourceText),
    ];
    if (candidates.length === 0) {
      return "";
    }

    return sanitizeRomanized(candidates[0]).toLowerCase();
  }

  function isRomanizationUsable(value) {
    const cleaned = sanitizeRomanized(value || "");
    return cleaned.length > 1 && hasLatin(cleaned);
  }

  global.RomanizationService = {
    parseTranslationResponse,
    parseRomanizationFromBackTranslationResponse,
    isRomanizationUsable,
  };
})(self);
