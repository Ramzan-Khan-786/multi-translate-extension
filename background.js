/**
 * TextBridge Background Orchestrator (MV3 Service Worker)
 *
 * Architecture:
 * - TranslationService: API fetch + dictionary parse
 * - RomanizationService: target-language transliteration parsing
 * - PronunciationService: native TTS + remote TTS fallback
 * - Background orchestrator: caching, history, PDF redirects, DNR header rules
 */

try {
  importScripts("services/runtime-config.js");
} catch (_) {
  // Fallback to built-in defaults in service modules when generated config is missing.
}

importScripts(
  "services/translation-service.js",
  "services/romanization-service.js",
  "services/pronunciation-service.js",
  "services/sheets-history-service.js",
);

const DEFAULTS = {
  lang1: "ur",
  lang2: "hi",
};
const SUPPORTED_LANGS = new Set(["en", "ur", "hi"]);

const VIEWER_PAGE = "viewer.html";
const PDF_HEAD_TIMEOUT_MS = 2500;

const PDF_HEADER_RULE_ID = 1001;
const TTS_HEADER_RULE_ID = 1002;
const TTS_API_HEADER_RULE_ID = 1003;

const TRANSLATION_CACHE_KEY = "translationCacheV2";
const TRANSLATION_CACHE_LIMIT = 50;
const TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEX_HISTORY_KEY = "lex_history";
const LEX_HISTORY_LIMIT = 500;
const LOCAL_HISTORY_MODE_KEY = "sheets_local_history_mode";
const LOCAL_HISTORY_MODE_HYBRID = "hybrid";
const LOCAL_HISTORY_MODE_SHEET_ONLY = "sheet_only";
const RUNTIME_ENDPOINTS = globalThis.TextBridgeRuntimeConfig?.endpoints || {};
const TRANSLATE_WEB_BASE = normalizeBaseUrl(
  RUNTIME_ENDPOINTS.translateWebBase,
  "https://translate.google.com",
);
const TRANSLATE_API_BASE = normalizeBaseUrl(
  RUNTIME_ENDPOINTS.translateApiBase,
  "https://translate.googleapis.com",
);
const TTS_WEB_RULE_FILTER = buildTtsUrlFilter(TRANSLATE_WEB_BASE, "/translate_tts");
const TTS_API_RULE_FILTER = buildTtsUrlFilter(TRANSLATE_API_BASE, "/translate_tts");
const inflightTranslationRequests = new Map();
let translationCacheMemory = [];
let translationCacheHydrated = false;
let localHistoryModeHydrated = false;
let localHistoryModeCache = LOCAL_HISTORY_MODE_HYBRID;

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return String(fallback || "").trim();
  }

  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch (_) {
    return String(fallback || "").trim().replace(/\/+$/, "");
  }
}

function buildTtsUrlFilter(baseUrl, pathSuffix) {
  const fallback = "||translate.google.com/translate_tts";
  const suffix = String(pathSuffix || "").startsWith("/") ? pathSuffix : `/${pathSuffix || ""}`;

  try {
    const parsed = new URL(baseUrl);
    const pathname = `${parsed.pathname.replace(/\/+$/, "")}${suffix}`.replace(/\/{2,}/g, "/");
    return `||${parsed.host}${pathname}`;
  } catch (_) {
    return fallback;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(DEFAULTS);
  await ensureDynamicRules();
  await cleanupTranslationCache();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDynamicRules();
  cleanupTranslationCache();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[LOCAL_HISTORY_MODE_KEY]) {
    localHistoryModeCache = normalizeLocalHistoryMode(changes[LOCAL_HISTORY_MODE_KEY].newValue);
    localHistoryModeHydrated = true;
  }
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
            urlFilter: TTS_WEB_RULE_FILTER,
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
            urlFilter: TTS_API_RULE_FILTER,
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

function isTranslationCacheEntryFresh(entry, now = Date.now()) {
  if (!entry || typeof entry.key !== "string" || !entry.value) {
    return false;
  }
  const ts = Number(entry.ts || 0);
  if (!Number.isFinite(ts) || ts <= 0) {
    return false;
  }
  return now - ts <= TRANSLATION_CACHE_TTL_MS;
}

function normalizeLocalHistoryMode(value) {
  return String(value || "").toLowerCase() === LOCAL_HISTORY_MODE_SHEET_ONLY
    ? LOCAL_HISTORY_MODE_SHEET_ONLY
    : LOCAL_HISTORY_MODE_HYBRID;
}

async function getLocalHistoryMode() {
  if (localHistoryModeHydrated) {
    return localHistoryModeCache;
  }

  try {
    const data = await chrome.storage.local.get([LOCAL_HISTORY_MODE_KEY]);
    localHistoryModeCache = normalizeLocalHistoryMode(data[LOCAL_HISTORY_MODE_KEY]);
  } catch (_) {
    localHistoryModeCache = LOCAL_HISTORY_MODE_HYBRID;
  }
  localHistoryModeHydrated = true;
  return localHistoryModeCache;
}

async function isSheetOnlyLocalHistoryMode() {
  const mode = await getLocalHistoryMode();
  return mode === LOCAL_HISTORY_MODE_SHEET_ONLY;
}

function pruneTranslationCacheEntries(entries) {
  const now = Date.now();
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => isTranslationCacheEntryFresh(entry, now))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, TRANSLATION_CACHE_LIMIT);
}

async function readRawTranslationCache() {
  try {
    const data = await chrome.storage.local.get([TRANSLATION_CACHE_KEY]);
    const entries = data[TRANSLATION_CACHE_KEY];
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

async function setTranslationCache(entries) {
  const pruned = pruneTranslationCacheEntries(entries);
  translationCacheMemory = pruned;
  translationCacheHydrated = true;

  try {
    await chrome.storage.local.set({
      [TRANSLATION_CACHE_KEY]: pruned,
    });
  } catch (_) {
    // ignore cache write failures
  }
}

async function cleanupTranslationCache() {
  if (!translationCacheHydrated) {
    const rawEntries = await readRawTranslationCache();
    const prunedEntries = pruneTranslationCacheEntries(rawEntries);
    translationCacheMemory = prunedEntries;
    translationCacheHydrated = true;

    if (rawEntries.length !== prunedEntries.length) {
      await setTranslationCache(prunedEntries);
    }
    return prunedEntries;
  }

  const prunedEntries = pruneTranslationCacheEntries(translationCacheMemory);
  translationCacheMemory = prunedEntries;
  return prunedEntries;
}

async function getTranslationCache() {
  if (translationCacheHydrated) {
    return translationCacheMemory;
  }
  return cleanupTranslationCache();
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

async function saveToHistory({ word, definition, ur, hi, url }) {
  const normalizedWord = (word || "").trim();
  if (!normalizedWord) {
    return false;
  }

  const nextEntry = {
    word: normalizedWord,
    definition: definition || "Definition not found",
    ur: ur || "",
    hi: hi || "",
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
    if (globalThis.SheetsHistoryService?.enqueueEntry) {
      // Fire-and-forget: history sync should never block translation UX.
      globalThis.SheetsHistoryService.enqueueEntry(nextEntry)
        .then(async (syncResult) => {
          if (!syncResult?.ok) {
            return;
          }

          const sheetOnlyMode = await isSheetOnlyLocalHistoryMode();
          if (!sheetOnlyMode) {
            return;
          }

          const freshEntries = await getLexHistory();
          const filteredEntries = freshEntries.filter((entry) => {
            const sameWord =
              String(entry?.word || "").toLowerCase() === normalizedWord.toLowerCase();
            const sameTimestamp =
              Number(entry?.timestamp || 0) === Number(nextEntry.timestamp || -1);
            return !(sameWord && sameTimestamp);
          });

          if (filteredEntries.length === freshEntries.length) {
            return;
          }

          try {
            await chrome.storage.local.set({ [LEX_HISTORY_KEY]: filteredEntries });
          } catch (_) {
            // ignore cleanup errors
          }
        })
        .catch(() => {
          // ignore sheets sync failures
        });
    }
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
      hi: cached.trans?.hi || "",
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

  async function enhanceRomanization(targetLang, translatedText, currentRomanized) {
    const normalizedLang = (targetLang || "").toLowerCase();
    if (!["ur", "hi"].includes(normalizedLang)) {
      return "";
    }
    if (!translatedText) {
      return "";
    }
    if (RomanizationService.isRomanizationUsable(currentRomanized)) {
      return currentRomanized;
    }

    // Fallback transliteration pass:
    // translate translated script text back with sl=<target>, tl=en, dt=rm.
    const backResponse = await TranslationService.fetchTranslationResponse(
      translatedText,
      "en",
      5000,
      normalizedLang,
    );
    const fallbackRomanized =
      RomanizationService.parseRomanizationFromBackTranslationResponse(backResponse);

    return RomanizationService.isRomanizationUsable(fallbackRomanized)
      ? fallbackRomanized
      : currentRomanized || "";
  }

  const [roman1, roman2] = await Promise.all([
    enhanceRomanization(l1, tr1.translatedText, tr1.romanized),
    enhanceRomanization(l2, tr2.translatedText, tr2.romanized),
  ]);

  const payload = {
    dict: dict.definition,
    phonetic: dict.phonetic,
    trans: {
      [l1]: tr1.translatedText,
      [l2]: tr2.translatedText,
    },
    roman: {
      [l1]: roman1,
      [l2]: roman2,
    },
  };

  await upsertCache(cacheKey, payload);
  const historySaved = await saveToHistory({
    word: text,
    definition: payload.dict,
    ur: payload.trans?.ur || (l1 === "ur" ? tr1.translatedText : l2 === "ur" ? tr2.translatedText : ""),
    hi: payload.trans?.hi || (l1 === "hi" ? tr1.translatedText : l2 === "hi" ? tr2.translatedText : ""),
    url: pageUrl,
  });

  return {
    ...payload,
    historySaved,
    fromCache: false,
  };
}

function getInflightRequestKey(text, l1, l2) {
  return getCacheKey(text, l1, l2);
}

function runTranslationPipelineDedup(text, l1, l2, pageUrl) {
  const key = getInflightRequestKey(text, l1, l2);
  const existingPromise = inflightTranslationRequests.get(key);
  if (existingPromise) {
    return existingPromise;
  }

  const nextPromise = runTranslationPipeline(text, l1, l2, pageUrl).finally(() => {
    inflightTranslationRequests.delete(key);
  });
  inflightTranslationRequests.set(key, nextPromise);
  return nextPromise;
}

function normalizeRequestedLang(value, fallback) {
  return SUPPORTED_LANGS.has(value) ? value : fallback;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SHEETS_GET_CONFIG") {
    if (!globalThis.SheetsHistoryService?.getConfig) {
      sendResponse({ ok: false, error: "Sheets service unavailable." });
      return;
    }
    globalThis.SheetsHistoryService.getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch(() => sendResponse({ ok: false, error: "Could not read Sheets config." }));
    return true;
  }

  if (message?.type === "SHEETS_SET_CONFIG") {
    if (!globalThis.SheetsHistoryService?.setConfig) {
      sendResponse({ ok: false, error: "Sheets service unavailable." });
      return;
    }
    globalThis.SheetsHistoryService.setConfig(message.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch(() => sendResponse({ ok: false, error: "Could not save Sheets config." }));
    return true;
  }

  if (message?.type === "SHEETS_AUTH") {
    if (!globalThis.SheetsHistoryService?.authorize) {
      sendResponse({ ok: false, error: "Sheets service unavailable." });
      return;
    }
    globalThis.SheetsHistoryService.authorize(true)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "Authorization failed." }));
    return true;
  }

  if (message?.type === "SHEETS_SYNC_NOW") {
    if (!globalThis.SheetsHistoryService?.syncAllEntries) {
      sendResponse({ ok: false, error: "Sheets service unavailable.", appended: 0 });
      return;
    }

    getLexHistory()
      .then((history) =>
        globalThis.SheetsHistoryService.syncAllEntries(history, true).then((result) => ({
          history,
          result,
        })),
      )
      .then(async ({ result }) => {
        if (result?.ok) {
          const sheetOnlyMode = await isSheetOnlyLocalHistoryMode();
          if (sheetOnlyMode) {
            try {
              await chrome.storage.local.set({ [LEX_HISTORY_KEY]: [] });
            } catch (_) {
              // ignore cleanup failures
            }
          }
        }
        sendResponse(result);
      })
      .catch(() =>
        sendResponse({
          ok: false,
          error: "Manual sync failed.",
          appended: 0,
        }),
      );
    return true;
  }

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
  const l1 = normalizeRequestedLang((message.l1 || "").toLowerCase(), DEFAULTS.lang1);
  const l2 = normalizeRequestedLang((message.l2 || "").toLowerCase(), DEFAULTS.lang2);
  const pageUrl = message.url || "";

  runTranslationPipelineDedup(text, l1, l2, pageUrl)
    .then(sendResponse)
    .catch(() => {
      sendResponse({
        dict: "Definition not found",
        phonetic: "",
        trans: {
          [l1]: "",
          [l2]: "",
        },
        roman: {
          [l1]: "",
          [l2]: "",
        },
        historySaved: false,
        fromCache: false,
      });
    });
  return true;
});
