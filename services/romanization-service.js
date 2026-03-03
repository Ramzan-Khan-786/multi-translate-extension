(function (global) {
  const ALLOWED_TARGET_LANGS = new Set(["ur", "fa", "hi", "ar"]);

  function normalizeLang(value) {
    return (value || "").toLowerCase().trim();
  }

  function extractSourceLang(data) {
    return typeof data?.[2] === "string" ? data[2].toLowerCase() : "";
  }

  function parseTranslationResponse(translateResponse, targetLang) {
    if (!translateResponse?.ok || !Array.isArray(translateResponse.data)) {
      return { translatedText: "", romanized: "" };
    }

    const data = translateResponse.data;
    const chunks = Array.isArray(data[0]) ? data[0] : [];
    const translatedText = typeof chunks?.[0]?.[0] === "string" ? chunks[0][0] : "";

    const sourceLang = extractSourceLang(data);
    const sourceIsEnglish = sourceLang.startsWith("en");
    const normalizedTarget = normalizeLang(targetLang);
    const allowRomanization = sourceIsEnglish && ALLOWED_TARGET_LANGS.has(normalizedTarget);

    if (!allowRomanization) {
      return { translatedText, romanized: "" };
    }

    // Primary extraction path requested: data[0][last][3]
    let romanized = chunks.length > 0 ? chunks[chunks.length - 1]?.[3] || "" : "";

    // Fallback: only romanization tied to the translated chunk.
    if (!romanized && translatedText) {
      const mappedChunk = chunks.find(
        (chunk) =>
          Array.isArray(chunk) &&
          typeof chunk[0] === "string" &&
          chunk[0].trim().toLowerCase() === translatedText.trim().toLowerCase() &&
          typeof chunk[3] === "string" &&
          chunk[3].trim(),
      );
      romanized = mappedChunk?.[3] || "";
    }

    // Last fallback: first non-empty chunk romanization field (target side only).
    if (!romanized) {
      const candidate = chunks.find(
        (chunk) => Array.isArray(chunk) && typeof chunk[3] === "string" && chunk[3].trim(),
      );
      romanized = candidate?.[3] || "";
    }

    return {
      translatedText,
      romanized: romanized || "",
    };
  }

  global.RomanizationService = {
    parseTranslationResponse,
  };
})(self);