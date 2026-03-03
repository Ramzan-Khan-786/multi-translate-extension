let activeLexPopup = null;

const POPUP_ID = "lex-pro-popup";
const DEFAULT_LANGS = { lang1: "ur", lang2: "fa" };
const LANGUAGE_OPTIONS = [
  { code: "ur", label: "Urdu", rtl: true },
  { code: "ar", label: "Arabic", rtl: true },
  { code: "fa", label: "Farsi", rtl: true },
  { code: "hi", label: "Hindi", rtl: false },
];
const MIN_SELECTION_LENGTH = 2;
const MAX_SELECTION_LENGTH = 180;
const SELECTION_DEBOUNCE_MS = 250;
const PDF_POLL_MS = 300;
const IS_PDF_MODE = window.location.protocol === "chrome-extension:";

let lastDispatchedSelection = "";
let selectionDebounceId = null;
let pdfPollTimer = null;
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

function safeSendMessage(message, callback) {
  const runtime = getRuntime();
  if (!runtime || !runtime.id || typeof runtime.sendMessage !== "function") {
    return;
  }

  runtime.sendMessage(message, (response) => {
    if (runtime.lastError) {
      return;
    }
    callback(response);
  });
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
  const ctx = await ensureAudioContext();
  if (!ctx) {
    const audio = new Audio(dataUrl);
    await audio.play();
    return;
  }

  const response = await fetch(dataUrl);
  const bytes = await response.arrayBuffer();
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

function removePopup() {
  if (activeLexPopup) {
    activeLexPopup.remove();
    activeLexPopup = null;
  }
}

function getLanguageMeta(code) {
  return LANGUAGE_OPTIONS.find((opt) => opt.code === code) || null;
}

function buildLanguageSelect(selectedCode, prefKey) {
  const options = LANGUAGE_OPTIONS.map((lang) => {
    const selected = selectedCode === lang.code ? "selected" : "";
    return `<option value="${lang.code}" ${selected}>${lang.label}</option>`;
  }).join("");

  return `<select class="lex-switcher" data-pref="${prefKey}">${options}</select>`;
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

async function getLangPrefs() {
  const storage = getStorageArea();
  if (!storage || typeof storage.get !== "function") {
    return { ...DEFAULT_LANGS };
  }

  try {
    const prefs = await storage.get(["lang1", "lang2"]);
    return {
      lang1: prefs.lang1 || DEFAULT_LANGS.lang1,
      lang2: prefs.lang2 || DEFAULT_LANGS.lang2,
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

  try {
    await storage.set({ [key]: value });
  } catch (_) {
    // no-op
  }
}

async function fetchAndRender(text, pointer) {
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
        return;
      }
      renderPopup({ data, text, pointer, lang1, lang2 });
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

  popup.innerHTML = `
    <div class="lex-bar">
      <span>LEXICON PRO</span>
      <span class="lex-history-icon ${data.historySaved ? "saved" : ""}" title="Saved to history">
        ${data.historySaved ? "&#10003;" : ""}
      </span>
      <button id="lex-close" type="button" aria-label="Close">X</button>
    </div>
    <div class="lex-content">
      <div class="lex-pane main-pane">
        <label>English Definition ${data.phonetic ? `(${data.phonetic})` : ""}</label>
        <div class="lex-word">${text}</div>
        <div class="lex-text">${data.dict || "Definition not found"}</div>
      </div>
      <div class="lex-pane">
        <label>Native Script</label>
        ${buildLanguageSelect(lang1, "lang1")}
        <div class="lex-trans ${lang1DirClass}">${data.trans?.[lang1] || "Translation unavailable"}</div>
        <div class="lex-roman">${data.roman?.[lang1] || "loading..."}</div>
        <button class="lex-audio-btn" type="button" data-audio-lang="${lang1}" aria-label="Play audio (${lang1})">
          <span class="lex-audio-icon">&#128266;</span>
          <span class="lex-audio-spinner" aria-hidden="true"></span>
        </button>
      </div>
      <div class="lex-pane">
        <label>Native Script</label>
        ${buildLanguageSelect(lang2, "lang2")}
        <div class="lex-trans ${lang2DirClass}">${data.trans?.[lang2] || "Translation unavailable"}</div>
        <div class="lex-roman">${data.roman?.[lang2] || "loading..."}</div>
        <button class="lex-audio-btn" type="button" data-audio-lang="${lang2}" aria-label="Play audio (${lang2})">
          <span class="lex-audio-icon">&#128266;</span>
          <span class="lex-audio-spinner" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(popup);
  activeLexPopup = popup;

  applyPopupPosition(popup, pointer);

  const closeBtn = popup.querySelector("#lex-close");
  closeBtn?.addEventListener("click", removePopup);

  popup.querySelectorAll(".lex-switcher").forEach((selectEl) => {
    selectEl.addEventListener("change", async (event) => {
      const target = event.target;
      const prefKey = target.getAttribute("data-pref");
      await setLangPref(prefKey, target.value);
      fetchAndRender(text, pointer);
    });
  });

  popup.querySelectorAll(".lex-audio-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.classList.contains("loading")) {
        return;
      }

      const lang = button.getAttribute("data-audio-lang") || "";
      const speechText = (data.trans?.[lang] || text || "").trim();
      if (!lang || !speechText) {
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
        }
      } catch (_) {
        button.classList.remove("loading");
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

  pdfPollTimer = setInterval(() => {
    handleSelectionSource(getSelectionAnchorPoint());
  }, PDF_POLL_MS);
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

if (window.location.protocol === "file:" && /\.pdf$/i.test(window.location.pathname)) {
  console.warn(
    "Lexicon Pro: For local PDFs, enable 'Allow access to file URLs' in chrome://extensions for this extension.",
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
