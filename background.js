/**
 * Lexicon Pro Background Orchestrator (MV3 Service Worker)
 *
 * Architecture:
 * - TranslationService: API fetch + dictionary parse
 * - RomanizationService: target-language transliteration parsing
 * - PronunciationService: native TTS + remote TTS fallback
 * - Background orchestrator: caching, history, PDF redirects, DNR header rules
 */

importScripts(
  "services/translation-service.js",
  "services/romanization-service.js",
  "services/pronunciation-service.js",
);

const DEFAULTS = {
  lang1: "ur",
  lang2: "fa",
};

const VIEWER_PAGE = "viewer.html";
const PDF_HEAD_TIMEOUT_MS = 2500;

const PDF_HEADER_RULE_ID = 1001;
const TTS_HEADER_RULE_ID = 1002;
const TTS_API_HEADER_RULE_ID = 1003;

const TRANSLATION_CACHE_KEY = "translationCache";
const TRANSLATION_CACHE_LIMIT = 10;
const LEX_HISTORY_KEY = "lex_history";
const LEX_HISTORY_LIMIT = 500;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(DEFAULTS);
  await ensureDynamicRules();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDynamicRules();
});

async function ensureDynamicRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_HEADER_RULE_ID, TTS_HEADER_RULE_ID, TTS_API_HEADER_RULE_ID],
      addRules: [
        {
          id: PDF_HEADER_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "x-frame-options", operation: "remove" },
              { header: "content-security-policy", operation: "remove" },
            ],
          },
          condition: {
            regexFilter: "^https?://.*\\.pdf([?#].*)?$",
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "other"],
          },
        },
        {
          id: TTS_HEADER_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "referer", operation: "remove" }],
          },
          condition: {
            urlFilter: "||translate.google.com/translate_tts",
            resourceTypes: ["media", "xmlhttprequest", "other"],
          },
        },
        {
          id: TTS_API_HEADER_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "referer", operation: "remove" }],
          },
          condition: {
            urlFilter: "||translate.googleapis.com/translate_tts",
            resourceTypes: ["media", "xmlhttprequest", "other"],
          },
        },
      ],
    });
  } catch (_) {
    // ignore dynamic rules failures
  }
}

function buildViewerUrl(fileUrl) {
  return `${chrome.runtime.getURL(VIEWER_PAGE)}?file=${encodeURIComponent(fileUrl)}`;
}

function isViewerUrl(url) {
  return url.startsWith(chrome.runtime.getURL(VIEWER_PAGE));
}

function stripHash(url) {
  const idx = url.indexOf("#");
  return idx >= 0 ? url.slice(0, idx) : url;
}

function isPdfByPattern(url) {
  const normalized = stripHash(url).toLowerCase();
  if (normalized.startsWith("blob:")) {
    return true;
  }
  return /\.pdf($|[?&])/i.test(normalized);
}

function isPdfCandidateForHead(url) {
  return /^https?:/i.test(url) && !isPdfByPattern(url);
}

async function isPdfByContentType(url) {
  if (!isPdfCandidateForHead(url)) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_HEAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    return contentType.toLowerCase().includes("application/pdf");
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function maybeRedirectPdfNavigation(details) {
  if (details.frameId !== 0 || !details.tabId || details.tabId < 0) {
    return;
  }

  const url = details.url || "";
  if (!url || isViewerUrl(url)) {
    return;
  }

  let shouldRedirect = isPdfByPattern(url);
  if (!shouldRedirect) {
    shouldRedirect = await isPdfByContentType(url);
  }
  if (!shouldRedirect) {
    return;
  }

  try {
    await chrome.tabs.update(details.tabId, { url: buildViewerUrl(url) });
  } catch (_) {
    // ignore tab update failures
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  maybeRedirectPdfNavigation(details);
});

chrome.action.onClicked.addListener(async (tab) => {
  const url = tab?.url || "";
  if (!url || !tab?.id || isViewerUrl(url)) {
    return;
  }

  const isLocalPdf = /^file:/i.test(url) && isPdfByPattern(url);
  const isRemotePdf = isPdfByPattern(url) || (await isPdfByContentType(url));

  if (!isLocalPdf && !isRemotePdf) {
    return;
  }

  try {
    await chrome.tabs.update(tab.id, { url: buildViewerUrl(url) });
  } catch (_) {
    // ignore tab update failures
  }
});

async function getTranslationCache() {
  try {
    const data = await chrome.storage.local.get([TRANSLATION_CACHE_KEY]);
    const entries = data[TRANSLATION_CACHE_KEY];
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

async function setTranslationCache(entries) {
  try {
    await chrome.storage.local.set({
      [TRANSLATION_CACHE_KEY]: entries.slice(0, TRANSLATION_CACHE_LIMIT),
    });
  } catch (_) {
    // ignore cache write failures
  }
}

function getCacheKey(text, l1, l2) {
  return `${text.toLowerCase()}::${l1}::${l2}`;
}

async function readFromCache(cacheKey) {
  const entries = await getTranslationCache();
  const hit = entries.find((entry) => entry?.key === cacheKey);
  return hit?.value || null;
}

async function upsertCache(cacheKey, value) {
  const entries = await getTranslationCache();
  const nextEntries = [
    { key: cacheKey, value, ts: Date.now() },
    ...entries.filter((entry) => entry?.key !== cacheKey),
  ].slice(0, TRANSLATION_CACHE_LIMIT);

  await setTranslationCache(nextEntries);
}

async function getLexHistory() {
  try {
    const data = await chrome.storage.local.get([LEX_HISTORY_KEY]);
    const entries = data[LEX_HISTORY_KEY];
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

async function saveToHistory({ word, definition, ur, fa, url }) {
  const normalizedWord = (word || "").trim();
  if (!normalizedWord) {
    return false;
  }

  const nextEntry = {
    word: normalizedWord,
    definition: definition || "Definition not found",
    ur: ur || "",
    fa: fa || "",
    timestamp: Date.now(),
    url: url || "",
  };

  const entries = await getLexHistory();
  const filtered = entries.filter(
    (entry) => (entry?.word || "").toLowerCase() !== normalizedWord.toLowerCase(),
  );
  const nextEntries = [nextEntry, ...filtered].slice(0, LEX_HISTORY_LIMIT);

  try {
    await chrome.storage.local.set({ [LEX_HISTORY_KEY]: nextEntries });
    return true;
  } catch (_) {
    return false;
  }
}

async function runTranslationPipeline(text, l1, l2, pageUrl) {
  const cacheKey = getCacheKey(text, l1, l2);
  const cached = await readFromCache(cacheKey);

  if (cached) {
    const historySaved = await saveToHistory({
      word: text,
      definition: cached.dict,
      ur: cached.trans?.ur || "",
      fa: cached.trans?.fa || "",
      url: pageUrl,
    });

    return {
      ...cached,
      historySaved,
      fromCache: true,
    };
  }

  const [dictResponse, l1Response, l2Response] = await Promise.all([
    TranslationService.fetchDictionaryResponse(text),
    TranslationService.fetchTranslationResponse(text, l1),
    TranslationService.fetchTranslationResponse(text, l2),
  ]);

  const dict = TranslationService.parseDictionary(dictResponse);
  const tr1 = RomanizationService.parseTranslationResponse(l1Response, l1);
  const tr2 = RomanizationService.parseTranslationResponse(l2Response, l2);

  const payload = {
    dict: dict.definition,
    phonetic: dict.phonetic,
    trans: {
      [l1]: tr1.translatedText,
      [l2]: tr2.translatedText,
    },
    roman: {
      [l1]: tr1.romanized,
      [l2]: tr2.romanized,
    },
  };

  await upsertCache(cacheKey, payload);
  const historySaved = await saveToHistory({
    word: text,
    definition: payload.dict,
    ur: payload.trans?.ur || (l1 === "ur" ? tr1.translatedText : l2 === "ur" ? tr2.translatedText : ""),
    fa: payload.trans?.fa || (l1 === "fa" ? tr1.translatedText : l2 === "fa" ? tr2.translatedText : ""),
    url: pageUrl,
  });

  return {
    ...payload,
    historySaved,
    fromCache: false,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_PRONUNCIATION" || message?.type === "GET_AUDIO_URL") {
    const text = (message.text || "").trim();
    const lang = (message.lang || "").trim().toLowerCase();

    if (!text || !lang) {
      sendResponse({ ok: false, spoken: false, dataUrl: "", source: "none" });
      return;
    }

    PronunciationService.resolvePronunciation(text, lang).then(sendResponse);
    return true;
  }

  if (message?.type !== "GET_DATA" && message?.type !== "QUERY_TRANSLATION") {
    return;
  }

  const text = (message.text || "").trim();
  const l1 = message.l1 || DEFAULTS.lang1;
  const l2 = message.l2 || DEFAULTS.lang2;
  const pageUrl = message.url || "";

  runTranslationPipeline(text, l1, l2, pageUrl).then(sendResponse);
  return true;
});
