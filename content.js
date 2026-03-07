let activeLexPopup = null;

const POPUP_ID = "lex-pro-popup";
const DEFAULT_LANGS = { lang1: "ur", lang2: "hi" };
const LANGUAGE_OPTIONS = [
  { code: "ur", label: "Urdu", rtl: true },
  { code: "hi", label: "Hindi", rtl: false },
  { code: "en", label: "English", rtl: false },
];
const MIN_SELECTION_LENGTH = 2;
const MAX_SELECTION_LENGTH = 180;
const SELECTION_DEBOUNCE_MS = 250;
const MESSAGE_RESPONSE_TIMEOUT_MS = 6000;
const PDF_POLL_MS = 300;
const POPUP_IDLE_CLOSE_MS = 5000;
const IS_PDF_MODE = window.location.protocol === "chrome-extension:";
const HAS_PDFJS_SELECTION_BRIDGE = IS_PDF_MODE && !!document.getElementById("pdfPages");
const SUPPORTED_LANG_CODES = new Set(LANGUAGE_OPTIONS.map((item) => item.code));

let lastDispatchedSelection = "";
let selectionDebounceId = null;
let pdfPollTimer = null;
let popupIdleTimer = null;
let lastPointer = {
  clientX: Math.round(window.innerWidth / 2),
  clientY: Math.round(window.innerHeight / 2),
};
let audioContext = null;

function getRuntime() {
  const c = globalThis.chrome;
  return c && c.runtime ? c.runtime : null;
}

function getStorageArea() {
  const c = globalThis.chrome;
  return c && c.storage && c.storage.local ? c.storage.local : null;
}

function safeSendMessage(message, onSuccess, onError, timeoutMs = MESSAGE_RESPONSE_TIMEOUT_MS) {
  const runtime = getRuntime();
  if (!runtime || !runtime.id || typeof runtime.sendMessage !== "function") {
    onError?.("runtime");
    return;
  }

  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    onError?.("timeout");
  }, timeoutMs);

  const finishSuccess = (response) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeoutId);
    onSuccess?.(response);
  };

  const finishError = (reason) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeoutId);
    onError?.(reason || "runtime");
  };

  try {
    runtime.sendMessage(message, (response) => {
      if (runtime.lastError) {
        finishError("runtime");
        return;
      }
      finishSuccess(response);
    });
  } catch (_) {
    finishError("runtime");
  }
}

function requestAudioUrl(text, lang) {
  return new Promise((resolve) => {
    safeSendMessage(
      {
        type: "GET_PRONUNCIATION",
        text,
        lang,
      },
      (response) => {
        resolve(response || { ok: false, spoken: false, dataUrl: "" });
      },
      () => {
        resolve({ ok: false, spoken: false, dataUrl: "" });
      },
    );
  });
}

async function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    return null;
  }
  if (!audioContext) {
    audioContext = new Ctx();
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (_) {
      return audioContext;
    }
  }
  return audioContext;
}

async function playDataUrlWithAudioContext(dataUrl) {
  const tryHtmlAudio = async () => {
    const audio = new Audio(dataUrl);
    await audio.play();
  };

  try {
    const ctx = await ensureAudioContext();
    if (!ctx) {
      await tryHtmlAudio();
      return;
    }

    const response = await fetch(dataUrl);
    const bytes = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (_) {
    await tryHtmlAudio();
  }
}

function removePopup() {
  clearPopupIdleTimer();
  if (activeLexPopup) {
    activeLexPopup.remove();
    activeLexPopup = null;
  }
}

function clearPopupIdleTimer() {
  if (!popupIdleTimer) {
    return;
  }
  clearTimeout(popupIdleTimer);
  popupIdleTimer = null;
}

function schedulePopupIdleClose(popup) {
  clearPopupIdleTimer();
  popupIdleTimer = setTimeout(() => {
    if (activeLexPopup === popup && !popup.matches(":hover")) {
      removePopup();
    }
  }, POPUP_IDLE_CLOSE_MS);
}

function getLanguageMeta(code) {
  return LANGUAGE_OPTIONS.find((opt) => opt.code === code) || null;
}

function buildLanguageSelect(selectedCode, prefKey) {
  const selectEl = document.createElement("select");
  selectEl.className = "lex-switcher";
  selectEl.setAttribute("data-pref", prefKey);

  LANGUAGE_OPTIONS.forEach((lang) => {
    const optionEl = document.createElement("option");
    optionEl.value = lang.code;
    optionEl.textContent = lang.label;
    if (selectedCode === lang.code) {
      optionEl.selected = true;
    }
    selectEl.appendChild(optionEl);
  });

  return selectEl;
}

function applyPopupPosition(popup, pointer) {
  const margin = 12;
  let left = pointer.clientX + margin;
  let top = pointer.clientY + margin;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const rect = popup.getBoundingClientRect();

  if (rect.right > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (rect.bottom > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function normalizeSelection(raw) {
  return (raw || "").replace(/\s+/g, " ").trim();
}

function getSelectionAnchorPoint() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return lastPointer;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return lastPointer;
  }

  return {
    clientX: rect.left + Math.min(rect.width, 40),
    clientY: rect.bottom,
  };
}

function isSelectionInRange(text) {
  return text.length >= MIN_SELECTION_LENGTH && text.length <= MAX_SELECTION_LENGTH;
}

function normalizeLangOrDefault(value, fallback) {
  return SUPPORTED_LANG_CODES.has(value) ? value : fallback;
}

async function getLangPrefs() {
  const storage = getStorageArea();
  if (!storage || typeof storage.get !== "function") {
    return { ...DEFAULT_LANGS };
  }

  try {
    const prefs = await storage.get(["lang1", "lang2"]);
    const lang1 = normalizeLangOrDefault(prefs.lang1, DEFAULT_LANGS.lang1);
    const lang2 = normalizeLangOrDefault(prefs.lang2, DEFAULT_LANGS.lang2);
    return {
      lang1,
      lang2,
    };
  } catch (_) {
    return { ...DEFAULT_LANGS };
  }
}

async function setLangPref(key, value) {
  const storage = getStorageArea();
  if (!storage || typeof storage.set !== "function") {
    return;
  }

  if (!SUPPORTED_LANG_CODES.has(value)) {
    return;
  }

  try {
    await storage.set({ [key]: value });
  } catch (_) {
    // no-op
  }
}

async function fetchAndRender(text, pointer, handlers = {}) {
  const onError = typeof handlers.onError === "function" ? handlers.onError : null;
  const onSuccess = typeof handlers.onSuccess === "function" ? handlers.onSuccess : null;

  const runtime = getRuntime();
  if (!runtime || !runtime.id) {
    onError?.("Extension unavailable");
    return;
  }

  const prefs = await getLangPrefs();
  const lang1 = prefs.lang1;
  const lang2 = prefs.lang2;

  safeSendMessage(
    {
      type: "QUERY_TRANSLATION",
      text,
      l1: lang1,
      l2: lang2,
      url: window.location.href,
    },
    (data) => {
      if (!data) {
        onError?.("Translation unavailable");
        return;
      }
      renderPopup({ data, text, pointer, lang1, lang2 });
      onSuccess?.();
    },
    (reason) => {
      if (reason === "timeout") {
        onError?.("Request timed out");
        return;
      }
      onError?.("Extension unavailable");
    },
  );
}

function renderPopup({ data, text, pointer, lang1, lang2 }) {
  removePopup();

  const lang1Meta = getLanguageMeta(lang1);
  const lang2Meta = getLanguageMeta(lang2);

  const popup = document.createElement("div");
  popup.id = POPUP_ID;

  const lang1DirClass = lang1Meta?.rtl ? "rtl" : "";
  const lang2DirClass = lang2Meta?.rtl ? "rtl" : "";
  const lang1CodeClass = `lang-${lang1}`;
  const lang2CodeClass = `lang-${lang2}`;
  const lang1Roman =
    lang1 === "en" ? "-" : data.roman?.[lang1] || "Romanization unavailable";
  const lang2Roman =
    lang2 === "en" ? "-" : data.roman?.[lang2] || "Romanization unavailable";

  const barEl = document.createElement("div");
  barEl.className = "lex-bar";

  const titleEl = document.createElement("span");
  titleEl.textContent = "TextBridge";
  barEl.appendChild(titleEl);

  const runtimeStatusEl = document.createElement("span");
  runtimeStatusEl.className = "lex-runtime-status";
  runtimeStatusEl.textContent = "";
  barEl.appendChild(runtimeStatusEl);

  const historyEl = document.createElement("span");
  historyEl.className = `lex-history-icon ${data.historySaved ? "saved" : ""}`.trim();
  historyEl.title = "Saved to history";
  historyEl.textContent = data.historySaved ? "\u2713" : "";
  barEl.appendChild(historyEl);

  let runtimeStatusTimer = null;
  function showRuntimeStatus(message, timeoutMs = 1200) {
    if (activeLexPopup !== popup) {
      return;
    }
    runtimeStatusEl.textContent = message || "";
    if (runtimeStatusTimer) {
      clearTimeout(runtimeStatusTimer);
      runtimeStatusTimer = null;
    }
    if (!message) {
      return;
    }
    runtimeStatusTimer = setTimeout(() => {
      runtimeStatusTimer = null;
      if (activeLexPopup === popup) {
        runtimeStatusEl.textContent = "";
      }
    }, timeoutMs);
  }

  const closeBtn = document.createElement("button");
  closeBtn.id = "lex-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "X";
  barEl.appendChild(closeBtn);

  const contentEl = document.createElement("div");
  contentEl.className = "lex-content";

  const mainPaneEl = document.createElement("div");
  mainPaneEl.className = "lex-pane main-pane";

  const mainLabelEl = document.createElement("label");
  mainLabelEl.textContent = `English Definition${data.phonetic ? ` (${data.phonetic})` : ""}`;
  mainPaneEl.appendChild(mainLabelEl);

  const wordEl = document.createElement("div");
  wordEl.className = "lex-word";
  wordEl.textContent = text;
  mainPaneEl.appendChild(wordEl);

  const dictEl = document.createElement("div");
  dictEl.className = "lex-text";
  dictEl.textContent = data.dict || "Definition not found";
  mainPaneEl.appendChild(dictEl);

  contentEl.appendChild(mainPaneEl);

  function buildTranslationPane(lang, prefKey, dirClass, codeClass, romanizedText) {
    const paneEl = document.createElement("div");
    paneEl.className = "lex-pane";

    const labelEl = document.createElement("label");
    labelEl.textContent = "Native Script";
    paneEl.appendChild(labelEl);

    const selectEl = buildLanguageSelect(lang, prefKey);
    paneEl.appendChild(selectEl);

    const transEl = document.createElement("div");
    transEl.className = `lex-trans ${dirClass} ${codeClass}`.trim();
    transEl.textContent = data.trans?.[lang] || "Translation unavailable";
    paneEl.appendChild(transEl);

    const romanEl = document.createElement("div");
    romanEl.className = "lex-roman";
    romanEl.textContent = romanizedText;
    paneEl.appendChild(romanEl);

    const audioBtn = document.createElement("button");
    audioBtn.className = "lex-audio-btn";
    audioBtn.type = "button";
    audioBtn.setAttribute("data-audio-lang", lang);
    audioBtn.setAttribute("aria-label", `Play audio (${lang})`);

    const iconEl = document.createElement("span");
    iconEl.className = "lex-audio-icon";
    iconEl.textContent = "\u{1F50A}";
    audioBtn.appendChild(iconEl);

    const spinnerEl = document.createElement("span");
    spinnerEl.className = "lex-audio-spinner";
    spinnerEl.setAttribute("aria-hidden", "true");
    audioBtn.appendChild(spinnerEl);

    paneEl.appendChild(audioBtn);
    return paneEl;
  }

  contentEl.appendChild(
    buildTranslationPane(lang1, "lang1", lang1DirClass, lang1CodeClass, lang1Roman),
  );
  contentEl.appendChild(
    buildTranslationPane(lang2, "lang2", lang2DirClass, lang2CodeClass, lang2Roman),
  );

  popup.appendChild(barEl);
  popup.appendChild(contentEl);

  document.body.appendChild(popup);
  activeLexPopup = popup;

  applyPopupPosition(popup, pointer);
  schedulePopupIdleClose(popup);

  popup.addEventListener("mouseenter", () => {
    clearPopupIdleTimer();
  });
  popup.addEventListener("mouseleave", () => {
    schedulePopupIdleClose(popup);
  });

  closeBtn?.addEventListener("click", removePopup);

  popup.querySelectorAll(".lex-switcher").forEach((selectEl) => {
    selectEl.addEventListener("change", async (event) => {
      const target = event.target;
      const prefKey = target.getAttribute("data-pref");
      await setLangPref(prefKey, target.value);
      fetchAndRender(text, pointer, {
        onError: (msg) => showRuntimeStatus(msg, 1400),
      });
    });
  });

  popup.querySelectorAll(".lex-audio-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.classList.contains("loading")) {
        return;
      }

      const lang = button.getAttribute("data-audio-lang") || "";
      const translatedText = (data.trans?.[lang] || "").trim();
      const speechText = lang === "en" ? (translatedText || text || "").trim() : translatedText;
      if (!lang || !speechText) {
        showRuntimeStatus("Audio unavailable", 1300);
        return;
      }

      button.classList.add("loading");
      try {
        // User gesture unlock for browsers that block async media starts.
        await ensureAudioContext();

        const response = await requestAudioUrl(speechText, lang);

        if (response?.spoken) {
          button.classList.remove("loading");
          return;
        }

        if (!response?.ok || !response.dataUrl) {
          button.classList.remove("loading");
          showRuntimeStatus("Audio unavailable", 1300);
          return;
        }

        const clearLoading = () => {
          button.classList.remove("loading");
        };

        try {
          await playDataUrlWithAudioContext(response.dataUrl);
          clearLoading();
        } catch (_) {
          clearLoading();
          showRuntimeStatus("Audio blocked", 1300);
        }
      } catch (_) {
        button.classList.remove("loading");
        showRuntimeStatus("Audio failed", 1300);
      }
    });
  });
}

function clearSelectionDebounce() {
  if (!selectionDebounceId) {
    return;
  }
  clearTimeout(selectionDebounceId);
  selectionDebounceId = null;
}

function clearPdfPollTimer() {
  if (!pdfPollTimer) {
    return;
  }
  clearInterval(pdfPollTimer);
  pdfPollTimer = null;
}

function queueSelectionTranslation(selection, pointer) {
  clearSelectionDebounce();

  selectionDebounceId = setTimeout(() => {
    selectionDebounceId = null;

    if (!isSelectionInRange(selection)) {
      if (!selection) {
        lastDispatchedSelection = "";
      }
      return;
    }

    if (selection === lastDispatchedSelection) {
      return;
    }

    lastDispatchedSelection = selection;
    fetchAndRender(selection, pointer || lastPointer);
  }, SELECTION_DEBOUNCE_MS);
}

function handleSelectionSource(pointer) {
  const selection = normalizeSelection(window.getSelection()?.toString() || "");
  queueSelectionTranslation(selection, pointer || (IS_PDF_MODE ? getSelectionAnchorPoint() : lastPointer));
}

function installSharedListeners() {
  document.addEventListener("mousemove", (event) => {
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
  });

  document.addEventListener("mousedown", (event) => {
    if (activeLexPopup && !activeLexPopup.contains(event.target)) {
      removePopup();
    }
  });
}

function installPdfMode() {
  document.addEventListener("lexicon-pro-selection", (event) => {
    const detail = event.detail || {};
    const text = normalizeSelection(detail.text || "");
    const pointer = {
      clientX:
        typeof detail.clientX === "number" ? detail.clientX : getSelectionAnchorPoint().clientX,
      clientY:
        typeof detail.clientY === "number" ? detail.clientY : getSelectionAnchorPoint().clientY,
    };

    queueSelectionTranslation(text, pointer);
  });

  document.addEventListener("selectionchange", () => {
    handleSelectionSource(getSelectionAnchorPoint());
  });

  document.addEventListener("mouseup", () => {
    handleSelectionSource(getSelectionAnchorPoint());
  });

  if (!HAS_PDFJS_SELECTION_BRIDGE) {
    pdfPollTimer = setInterval(() => {
      handleSelectionSource(getSelectionAnchorPoint());
    }, PDF_POLL_MS);
  }
}

function installWebMode() {
  document.addEventListener("mouseup", (event) => {
    if (activeLexPopup && activeLexPopup.contains(event.target)) {
      return;
    }

    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    };

    handleSelectionSource(lastPointer);
  });

  document.addEventListener("selectionchange", () => {
    handleSelectionSource(lastPointer);
  });

  document.addEventListener("keyup", () => {
    handleSelectionSource(lastPointer);
  });
}

const runtimeForFilePdfWarning = getRuntime();
if (
  window.location.protocol === "file:" &&
  /\.pdf$/i.test(window.location.pathname) &&
  (!runtimeForFilePdfWarning || !runtimeForFilePdfWarning.id)
) {
  console.warn(
    "TextBridge: For local PDFs, enable 'Allow access to file URLs' in chrome://extensions for this extension.",
  );
}

installSharedListeners();
if (IS_PDF_MODE) {
  installPdfMode();
} else {
  installWebMode();
}

window.addEventListener("beforeunload", () => {
  clearSelectionDebounce();
  clearPdfPollTimer();
});
