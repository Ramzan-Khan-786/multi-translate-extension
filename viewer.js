(function () {
  const noteEl = document.getElementById("viewerNote");
  const pagesEl = document.getElementById("pdfPages");
  const viewerContainer = document.getElementById("viewerContainer");
  const viewerStatus = document.getElementById("viewerStatus");
  const zoomSelect = document.getElementById("zoomSelect");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const pageNumberInput = document.getElementById("pageNumberInput");
  const pageCountLabel = document.getElementById("pageCountLabel");
  const openSearchBtn = document.getElementById("openSearchBtn");
  const searchPanel = document.getElementById("searchPanel");
  const searchInput = document.getElementById("searchInput");
  const searchCount = document.getElementById("searchCount");
  const searchPrevBtn = document.getElementById("searchPrevBtn");
  const searchNextBtn = document.getElementById("searchNextBtn");
  const searchResults = document.getElementById("searchResults");
  const searchEmpty = document.getElementById("searchEmpty");
  const closeSearchPanel = document.getElementById("closeSearchPanel");
  const ocrToggle = document.getElementById("ocrToggle");
  const lowResourceToggle = document.getElementById("lowResourceToggle");
  const highlightToggle = document.getElementById("highlightToggle");
  const eraseToggle = document.getElementById("eraseToggle");
  const addBookmarkBtn = document.getElementById("addBookmarkBtn");
  const toggleBookmarksBtn = document.getElementById("toggleBookmarksBtn");
  const downloadPdfBtn = document.getElementById("downloadPdfBtn");
  const highlightColorPicker = document.getElementById("highlightColorPicker");
  const bookmarkPanel = document.getElementById("bookmarkPanel");
  const bookmarkList = document.getElementById("bookmarkList");
  const bookmarkEmpty = document.getElementById("bookmarkEmpty");
  const closeBookmarkPanel = document.getElementById("closeBookmarkPanel");

  const WORKER_URL = "pdfjs/pdf.worker.min.js";
  const DEFAULT_SCALE_VALUE = "page-width";
  const LOW_RESOURCE_SCALE_VALUE = "page-fit";
  const SELECTION_DEBOUNCE_MS = 180;
  const LOW_RESOURCE_SELECTION_DEBOUNCE_MS = 260;
  const CLEANUP_IDLE_MS = 700;
  const LOW_RESOURCE_CLEANUP_IDLE_MS = 1100;
  const ZOOM_STEP = 1.1;
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 4;
  const MAX_CANVAS_PIXELS = 16777216;
  const LOW_RESOURCE_MAX_CANVAS_PIXELS = 8388608;
  const OCR_THROTTLE_MS = 900;
  const LOW_RESOURCE_OCR_THROTTLE_MS = 1600;
  const OCR_CROP_SIZE_CSS = 260;
  const OCR_MAX_RESULT_CHARS = 140;
  const SEARCH_INPUT_DEBOUNCE_MS = 180;
  const SEARCH_SNIPPET_CONTEXT_CHARS = 48;
  const STATUS_CLEAR_DEFAULT_MS = 1100;
  const OCR_ENABLED_KEY = "pdf_ocr_enabled";
  const LOW_RESOURCE_KEY = "pdf_low_resource_mode";
  const HIGHLIGHT_COLOR_KEY = "pdf_highlight_color";
  const PDF_ANNOTATIONS_KEY = "pdf_annotations_v1";
  const MIN_HIGHLIGHT_RECT_PX = 2;
  const DEFAULT_HIGHLIGHT_COLOR = "#ffe082";
  const HIGHLIGHT_EXPORT_OPACITY = 0.35;
  const ANNOTATION_EDITOR_PREFIX = "pdfjs_internal_editor_";
  const EXPORT_ANNOTATION_PREFIX = `${ANNOTATION_EDITOR_PREFIX}textbridge_highlight_`;
  const BOOKMARK_AUTOHIDE_MS = 5000;

  let selectionDebounce = null;
  let lastSelection = "";
  let lastPointer = {
    clientX: Math.round(window.innerWidth / 2),
    clientY: Math.round(window.innerHeight / 2),
  };
  let pointerDown = false;
  let cleanupTimer = null;
  let cleanupIdleHandle = null;
  let lastCleanupScheduleTs = 0;

  let pdfViewer = null;
  let pdfDocument = null;
  let eventBus = null;
  let linkService = null;
  let findController = null;
  let textDetector = null;
  let ocrInFlight = false;
  let lastOcrTs = 0;
  let ocrEnabled = true;
  let lowResourceMode = false;
  let statusClearTimer = null;
  let selectionDebounceMs = SELECTION_DEBOUNCE_MS;
  let cleanupIdleMs = CLEANUP_IDLE_MS;
  let ocrThrottleMs = OCR_THROTTLE_MS;
  let highlightMode = false;
  let eraseMode = false;
  let currentDocId = "";
  let pdfAnnotations = { highlights: [], bookmarks: [] };
  let annotationsReady = false;
  let highlightColor = DEFAULT_HIGHLIGHT_COLOR;
  let exportAnnotationIds = new Set();
  let bookmarkAutoHideTimer = null;
  let searchInputDebounce = null;
  let searchPanelOpen = false;
  let currentSearchQuery = "";
  let renderedSearchQuery = "";
  let searchMatchesCount = { current: 0, total: 0 };
  let searchPageTextCache = [];
  let searchPageTextPromise = null;
  let searchResultsBuildToken = 0;

  function raf(fn) {
    requestAnimationFrame(fn);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function getStorageArea() {
    const c = globalThis.chrome;
    return c && c.storage && c.storage.local ? c.storage.local : null;
  }

  function createId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeHexColor(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return DEFAULT_HIGHLIGHT_COLOR;
    }
    if (/^#[0-9a-f]{6}$/i.test(raw)) {
      return raw;
    }
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      const r = raw[1];
      const g = raw[2];
      const b = raw[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return DEFAULT_HIGHLIGHT_COLOR;
  }

  function hexToRgbArray(value) {
    const hex = normalizeHexColor(value).replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return [r, g, b];
  }

  function hexToRgba(value, alpha) {
    const [r, g, b] = hexToRgbArray(value);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function isLowEndDevice() {
    const hw = Number(navigator.hardwareConcurrency || 0);
    const mem = Number(navigator.deviceMemory || 0);
    if (hw > 0 && hw <= 4) {
      return true;
    }
    if (mem > 0 && mem <= 4) {
      return true;
    }
    return false;
  }

  async function loadViewerSettings() {
    const storage = getStorageArea();
    const lowEnd = isLowEndDevice();
    const defaults = {
      [OCR_ENABLED_KEY]: !lowEnd,
      [LOW_RESOURCE_KEY]: lowEnd,
      [HIGHLIGHT_COLOR_KEY]: DEFAULT_HIGHLIGHT_COLOR,
    };

    if (!storage || typeof storage.get !== "function") {
      ocrEnabled = defaults[OCR_ENABLED_KEY];
      lowResourceMode = defaults[LOW_RESOURCE_KEY];
      highlightColor = defaults[HIGHLIGHT_COLOR_KEY];
      return;
    }

    try {
      const settings = await storage.get([OCR_ENABLED_KEY, LOW_RESOURCE_KEY, HIGHLIGHT_COLOR_KEY]);
      ocrEnabled =
        typeof settings[OCR_ENABLED_KEY] === "boolean"
          ? settings[OCR_ENABLED_KEY]
          : defaults[OCR_ENABLED_KEY];
      lowResourceMode =
        typeof settings[LOW_RESOURCE_KEY] === "boolean"
          ? settings[LOW_RESOURCE_KEY]
          : defaults[LOW_RESOURCE_KEY];
      highlightColor =
        typeof settings[HIGHLIGHT_COLOR_KEY] === "string" && settings[HIGHLIGHT_COLOR_KEY]
          ? settings[HIGHLIGHT_COLOR_KEY]
          : defaults[HIGHLIGHT_COLOR_KEY];
    } catch (_) {
      ocrEnabled = defaults[OCR_ENABLED_KEY];
      lowResourceMode = defaults[LOW_RESOURCE_KEY];
      highlightColor = defaults[HIGHLIGHT_COLOR_KEY];
    }
  }

  async function saveViewerSetting(key, value) {
    const storage = getStorageArea();
    if (!storage || typeof storage.set !== "function") {
      return;
    }

    try {
      await storage.set({ [key]: value });
    } catch (_) {
      // ignore setting write errors
    }
  }

  function normalizeAnnotationPayload(payload) {
    return {
      highlights: Array.isArray(payload?.highlights) ? payload.highlights : [],
      bookmarks: Array.isArray(payload?.bookmarks) ? payload.bookmarks : [],
    };
  }

  async function readAnnotationStore() {
    const storage = getStorageArea();
    if (!storage || typeof storage.get !== "function") {
      return {};
    }

    try {
      const data = await storage.get([PDF_ANNOTATIONS_KEY]);
      const store = data[PDF_ANNOTATIONS_KEY];
      return store && typeof store === "object" ? store : {};
    } catch (_) {
      return {};
    }
  }

  async function loadAnnotationsForDoc(docId) {
    annotationsReady = false;
    pdfAnnotations = { highlights: [], bookmarks: [] };
    if (!docId) {
      annotationsReady = true;
      return;
    }

    const store = await readAnnotationStore();
    if (Object.prototype.hasOwnProperty.call(store, docId)) {
      pdfAnnotations = normalizeAnnotationPayload(store[docId]);
    } else {
      pdfAnnotations = { highlights: [], bookmarks: [] };
    }
    annotationsReady = true;
  }

  async function saveAnnotationsForDoc(docId) {
    const storage = getStorageArea();
    if (!storage || typeof storage.set !== "function" || !docId) {
      return;
    }

    try {
      const data = await storage.get([PDF_ANNOTATIONS_KEY]);
      const store = data[PDF_ANNOTATIONS_KEY];
      const nextStore = store && typeof store === "object" ? { ...store } : {};
      nextStore[docId] = pdfAnnotations;
      await storage.set({ [PDF_ANNOTATIONS_KEY]: nextStore });
    } catch (_) {
      // ignore storage failures
    }
  }

  function syncSettingsUi() {
    if (ocrToggle) {
      ocrToggle.checked = !!ocrEnabled;
    }
    if (lowResourceToggle) {
      lowResourceToggle.checked = !!lowResourceMode;
    }
    syncHighlightColorUi();
  }

  function syncHighlightColorUi() {
    highlightColor = normalizeHexColor(highlightColor);
    if (highlightColorPicker) {
      highlightColorPicker.value = highlightColor;
    }
    const swatches = document.querySelectorAll(".pdf-color-swatch[data-color]");
    swatches.forEach((swatch) => {
      const color = normalizeHexColor(swatch.getAttribute("data-color") || "");
      swatch.style.background = color;
      swatch.classList.toggle("is-active", color === highlightColor);
    });
  }

  function enforceOcrAvailability() {
    if (typeof TextDetector !== "undefined") {
      return;
    }
    ocrEnabled = false;
    if (ocrToggle) {
      ocrToggle.checked = false;
      ocrToggle.disabled = true;
      ocrToggle.title = "OCR is not supported in this browser build.";
    }
    setTransientStatus("OCR unsupported", 1400);
  }

  function showNote(text) {
    if (!noteEl) {
      return;
    }
    raf(() => {
      noteEl.textContent = text;
      noteEl.style.display = "block";
    });
  }

  function hideNote() {
    if (!noteEl) {
      return;
    }
    raf(() => {
      noteEl.textContent = "";
      noteEl.style.display = "none";
    });
  }

  function setStatus(text) {
    if (!viewerStatus) {
      return;
    }
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    viewerStatus.textContent = text || "";
  }

  function clearStatusAfter(ms = STATUS_CLEAR_DEFAULT_MS) {
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    statusClearTimer = setTimeout(() => {
      statusClearTimer = null;
      setStatus("");
    }, ms);
  }

  function setTransientStatus(text, ms = STATUS_CLEAR_DEFAULT_MS) {
    setStatus(text);
    clearStatusAfter(ms);
  }

  function normalizeSearchQuery(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function updateSearchCountUi(matchesCount = searchMatchesCount) {
    searchMatchesCount = {
      current: Math.max(0, Number(matchesCount?.current) || 0),
      total: Math.max(0, Number(matchesCount?.total) || 0),
    };

    if (searchCount) {
      searchCount.textContent = searchMatchesCount.total
        ? `${searchMatchesCount.current} / ${searchMatchesCount.total}`
        : "0 / 0";
    }
    if (searchPrevBtn) {
      searchPrevBtn.disabled = searchMatchesCount.total === 0;
    }
    if (searchNextBtn) {
      searchNextBtn.disabled = searchMatchesCount.total === 0;
    }
  }

  function setSearchEmptyMessage(message) {
    if (!searchEmpty) {
      return;
    }
    searchEmpty.textContent = message || "";
    searchEmpty.style.display = message ? "block" : "none";
  }

  function syncSearchResultSelection(resultNumber = searchMatchesCount.current, scrollIntoView = false) {
    if (!searchResults) {
      return;
    }

    const selectedNumber = Math.max(0, Number(resultNumber) || 0);
    searchResults.querySelectorAll(".pdf-search-result.is-active").forEach((item) => {
      item.classList.remove("is-active");
    });

    if (!selectedNumber) {
      return;
    }

    const activeItem = searchResults.querySelector(
      `.pdf-search-result[data-result-number="${selectedNumber}"]`,
    );
    if (!activeItem) {
      return;
    }

    activeItem.classList.add("is-active");
    if (scrollIntoView) {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }

  function syncSearchPanelToggleUi() {
    if (!openSearchBtn) {
      return;
    }
    openSearchBtn.classList.toggle("is-active", searchPanelOpen);
    openSearchBtn.setAttribute("aria-expanded", searchPanelOpen ? "true" : "false");
  }

  function setSearchPanelOpen(open, options = {}) {
    searchPanelOpen = !!open;
    if (searchPanel) {
      searchPanel.hidden = !searchPanelOpen;
      searchPanel.style.display = searchPanelOpen ? "flex" : "none";
    }
    syncSearchPanelToggleUi();

    if (searchPanelOpen && options.focusInput) {
      raf(() => {
        searchInput?.focus();
        if (options.selectQuery && searchInput?.value) {
          searchInput.select();
        }
      });
    }
  }

  function invalidateSearchResults() {
    searchResultsBuildToken += 1;
    renderedSearchQuery = "";
    if (searchResults) {
      searchResults.innerHTML = "";
    }
    syncSearchResultSelection(0);
  }

  function resetSearchCache() {
    searchPageTextCache = [];
    searchPageTextPromise = null;
  }

  function clearSearchResultsUi(message = "Type a word to search the full PDF.") {
    invalidateSearchResults();
    updateSearchCountUi({ current: 0, total: 0 });
    setSearchEmptyMessage(message);
  }

  function clearPdfSearch(options = {}) {
    if (searchInputDebounce) {
      clearTimeout(searchInputDebounce);
      searchInputDebounce = null;
    }
    currentSearchQuery = "";
    clearSearchResultsUi(options.message || "Type a word to search the full PDF.");
    if (!options.keepInput && searchInput) {
      searchInput.value = "";
    }
    setStatus("");

    if (eventBus) {
      eventBus.dispatch("findbarclose", {
        source: findController || window,
      });
    }
  }

  function extractTextContentString(textContent) {
    const parts = [];
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    items.forEach((item) => {
      if (item?.str) {
        parts.push(item.str);
      }
      if (item?.hasEOL) {
        parts.push("\n");
      }
    });
    return parts.join("");
  }

  async function getSearchPageTexts() {
    if (!pdfDocument) {
      return [];
    }
    if (searchPageTextCache.length === pdfDocument.numPages) {
      return searchPageTextCache;
    }
    if (searchPageTextPromise) {
      return searchPageTextPromise;
    }

    const docRef = pdfDocument;
    searchPageTextPromise = (async () => {
      const texts = [];
      for (let pageNumber = 1; pageNumber <= docRef.numPages; pageNumber += 1) {
        const page = await docRef.getPage(pageNumber);
        const textContent = await page.getTextContent({ disableNormalization: true });
        texts.push(extractTextContentString(textContent));
      }
      if (pdfDocument === docRef) {
        searchPageTextCache = texts;
      }
      return texts;
    })().catch((error) => {
      searchPageTextPromise = null;
      throw error;
    });

    return searchPageTextPromise;
  }

  function compactSearchSnippetText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function appendSearchSnippet(container, pageText, matchStart, matchLength) {
    const safeStart = clamp(Number(matchStart) || 0, 0, pageText.length);
    const safeEnd = clamp(safeStart + Math.max(1, Number(matchLength) || 1), safeStart, pageText.length);
    const snippetStart = Math.max(0, safeStart - SEARCH_SNIPPET_CONTEXT_CHARS);
    const snippetEnd = Math.min(pageText.length, safeEnd + SEARCH_SNIPPET_CONTEXT_CHARS);
    const before = compactSearchSnippetText(pageText.slice(snippetStart, safeStart));
    const matchText =
      compactSearchSnippetText(pageText.slice(safeStart, safeEnd)) || currentSearchQuery;
    const after = compactSearchSnippetText(pageText.slice(safeEnd, snippetEnd));
    const beforeText = `${snippetStart > 0 ? "… " : ""}${before}`;
    const afterText = `${after ? ` ${after}` : ""}${snippetEnd < pageText.length ? " …" : ""}`;

    if (beforeText) {
      container.append(beforeText);
      if (!beforeText.endsWith(" ")) {
        container.append(" ");
      }
    }

    const mark = document.createElement("mark");
    mark.textContent = matchText;
    container.append(mark);

    if (afterText) {
      container.append(afterText);
    }
  }

  function createSearchResultButton(resultNumber, pageIndex, matchIndex, pageText, matchStart, matchLength) {
    const item = document.createElement("button");
    item.className = "pdf-search-result";
    item.type = "button";
    item.setAttribute("data-result-number", String(resultNumber));

    const label = document.createElement("div");
    label.className = "pdf-search-result-label";
    label.textContent = `${resultNumber}. Page ${pageIndex + 1}`;

    const snippet = document.createElement("div");
    snippet.className = "pdf-search-result-snippet";
    appendSearchSnippet(snippet, pageText, matchStart, matchLength);

    item.appendChild(label);
    item.appendChild(snippet);
    item.addEventListener("click", () => {
      jumpToSearchResult(pageIndex, matchIndex, resultNumber);
    });

    return item;
  }

  async function renderSearchResultsList(query) {
    const targetQuery = normalizeSearchQuery(query);
    if (!searchResults || !targetQuery || !findController) {
      return;
    }

    const totalMatches = Math.max(0, Number(searchMatchesCount.total) || 0);
    const buildToken = ++searchResultsBuildToken;
    renderedSearchQuery = "";
    searchResults.innerHTML = "";

    if (!totalMatches) {
      setSearchEmptyMessage(`No matches found for "${targetQuery}".`);
      syncSearchResultSelection(0);
      return;
    }

    setSearchEmptyMessage("Building numbered results...");

    let pageTexts = [];
    try {
      pageTexts = await getSearchPageTexts();
    } catch (_) {
      if (buildToken !== searchResultsBuildToken || targetQuery !== currentSearchQuery) {
        return;
      }
      setSearchEmptyMessage("Matches were found, but snippets could not be loaded.");
      return;
    }

    if (buildToken !== searchResultsBuildToken || targetQuery !== currentSearchQuery || !findController) {
      return;
    }

    const fragment = document.createDocumentFragment();
    const pageMatches = Array.isArray(findController.pageMatches) ? findController.pageMatches : [];
    const pageMatchesLength = Array.isArray(findController.pageMatchesLength)
      ? findController.pageMatchesLength
      : [];
    let resultNumber = 0;

    pageMatches.forEach((matches, pageIndex) => {
      const safeMatches = Array.isArray(matches) ? matches : [];
      const safeLengths = Array.isArray(pageMatchesLength[pageIndex]) ? pageMatchesLength[pageIndex] : [];
      const pageText = String(pageTexts[pageIndex] || "");

      safeMatches.forEach((matchStart, matchIndex) => {
        resultNumber += 1;
        const matchLength = Math.max(1, Number(safeLengths[matchIndex]) || targetQuery.length || 1);
        fragment.appendChild(
          createSearchResultButton(
            resultNumber,
            pageIndex,
            matchIndex,
            pageText,
            matchStart,
            matchLength,
          ),
        );
      });
    });

    if (buildToken !== searchResultsBuildToken || targetQuery !== currentSearchQuery) {
      return;
    }

    searchResults.innerHTML = "";
    searchResults.appendChild(fragment);
    renderedSearchQuery = targetQuery;
    setSearchEmptyMessage(resultNumber ? "" : `No matches found for "${targetQuery}".`);
    syncSearchResultSelection(searchMatchesCount.current, searchPanelOpen);
  }

  function jumpToSearchResult(pageIndex, matchIndex, resultNumber) {
    if (!findController || !eventBus || !pdfDocument) {
      return;
    }

    const safePageIndex = clamp(Number(pageIndex) || 0, 0, Math.max(pdfDocument.numPages - 1, 0));
    const pageMatches = Array.isArray(findController.pageMatches?.[safePageIndex])
      ? findController.pageMatches[safePageIndex]
      : [];
    const safeMatchIndex = clamp(Number(matchIndex) || 0, 0, Math.max(pageMatches.length - 1, 0));
    if (!pageMatches.length) {
      return;
    }

    findController._selected.pageIdx = safePageIndex;
    findController._selected.matchIdx = safeMatchIndex;
    findController._offset.pageIdx = safePageIndex;
    findController._offset.matchIdx = safeMatchIndex;
    findController._offset.wrapped = false;
    findController._scrollMatches = true;

    const globalResultNumber = Math.max(1, Number(resultNumber) || safeMatchIndex + 1);
    goToPage(safePageIndex + 1);
    updateSearchCountUi({
      current: globalResultNumber,
      total: searchMatchesCount.total,
    });
    syncSearchResultSelection(globalResultNumber, true);

    raf(() => {
      eventBus.dispatch("updatetextlayermatches", {
        source: findController,
        pageIndex: -1,
      });
    });
  }

  function runPdfSearch(rawQuery, options = {}) {
    if (searchInputDebounce) {
      clearTimeout(searchInputDebounce);
      searchInputDebounce = null;
    }

    const query = normalizeSearchQuery(rawQuery);
    if (!query) {
      clearPdfSearch();
      return;
    }
    if (!eventBus || !findController) {
      return;
    }

    const isNewQuery = query !== currentSearchQuery;
    currentSearchQuery = query;
    setSearchPanelOpen(true);

    if (isNewQuery) {
      clearSearchResultsUi("Searching full PDF...");
      setStatus("Searching...");
    }

    eventBus.dispatch("find", {
      source: findController,
      type: "again",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: !!options.findPrevious,
      matchDiacritics: false,
    });
  }

  function schedulePdfSearchFromInput() {
    if (searchInputDebounce) {
      clearTimeout(searchInputDebounce);
      searchInputDebounce = null;
    }

    searchInputDebounce = setTimeout(() => {
      searchInputDebounce = null;
      runPdfSearch(searchInput?.value || "");
    }, SEARCH_INPUT_DEBOUNCE_MS);
  }

  function syncAnnotationModeUi() {
    if (highlightToggle) {
      highlightToggle.classList.toggle("is-active", highlightMode);
      highlightToggle.setAttribute("aria-pressed", highlightMode ? "true" : "false");
    }
    if (eraseToggle) {
      eraseToggle.classList.toggle("is-active", eraseMode);
      eraseToggle.setAttribute("aria-pressed", eraseMode ? "true" : "false");
    }

    if (document.body) {
      document.body.classList.toggle("pdf-highlight-mode", highlightMode);
      document.body.classList.toggle("pdf-erase-mode", eraseMode);
      if (highlightMode) {
        document.body.setAttribute("data-pdf-highlight-mode", "on");
      } else {
        document.body.removeAttribute("data-pdf-highlight-mode");
      }
      if (eraseMode) {
        document.body.setAttribute("data-pdf-erase-mode", "on");
      } else {
        document.body.removeAttribute("data-pdf-erase-mode");
      }
    }
  }

  function setHighlightMode(enabled) {
    highlightMode = !!enabled;
    if (highlightMode) {
      eraseMode = false;
    }
    syncAnnotationModeUi();
  }

  function setEraseMode(enabled) {
    eraseMode = !!enabled;
    if (eraseMode) {
      highlightMode = false;
    }
    syncAnnotationModeUi();
  }

  function applyPerformanceProfile() {
    if (lowResourceMode) {
      selectionDebounceMs = LOW_RESOURCE_SELECTION_DEBOUNCE_MS;
      cleanupIdleMs = LOW_RESOURCE_CLEANUP_IDLE_MS;
      ocrThrottleMs = LOW_RESOURCE_OCR_THROTTLE_MS;
      return;
    }

    selectionDebounceMs = SELECTION_DEBOUNCE_MS;
    cleanupIdleMs = CLEANUP_IDLE_MS;
    ocrThrottleMs = OCR_THROTTLE_MS;
  }

  function decodeFileParam(rawValue) {
    let decoded = rawValue || "";

    // The viewer URL encodes the source URL once.
    // If the source URL already had escaped bytes (e.g. %20), they appear as %25xx.
    // Decode only this double-encoding layer to keep valid URL escaping intact.
    if (!/%25[0-9a-f]{2}/i.test(decoded)) {
      return decoded;
    }

    try {
      decoded = decodeURIComponent(decoded);
    } catch (_) {
      // keep original value
    }

    return decoded;
  }

  function normalizeDocumentId(pdfUrl) {
    if (!pdfUrl) {
      return "";
    }

    try {
      const url = new URL(pdfUrl);
      url.hash = "";
      return url.toString();
    } catch (_) {
      return String(pdfUrl).split("#")[0] || String(pdfUrl);
    }
  }

  function extractPdfFileName(pdfUrl) {
    if (!pdfUrl) {
      return "";
    }

    try {
      const url = new URL(pdfUrl);
      const lastSegment = (url.pathname || "").split("/").pop() || "";
      return lastSegment ? decodeURIComponent(lastSegment) : "";
    } catch (_) {
      const clean = String(pdfUrl).split(/[?#]/)[0] || "";
      const lastSegment = clean.slice(clean.lastIndexOf("/") + 1);
      try {
        return lastSegment ? decodeURIComponent(lastSegment) : "";
      } catch (_) {
        return lastSegment;
      }
    }
  }

  function setViewerTitle(pdfUrl) {
    const fileName = extractPdfFileName(pdfUrl);
    document.title = fileName || "TextBridge PDF Viewer";
  }

  function normalizeSelection(raw) {
    return (raw || "").replace(/\s+/g, " ").trim();
  }

  function dispatchSelection(text, point) {
    const normalized = normalizeSelection(text);
    if (!normalized) {
      return false;
    }
    if (normalized === lastSelection) {
      return false;
    }

    lastSelection = normalized;
    raf(() => {
      document.dispatchEvent(
        new CustomEvent("lexicon-pro-selection", {
          detail: {
            text: normalized,
            clientX: point.clientX,
            clientY: point.clientY,
          },
          bubbles: true,
        }),
      );
    });
    return true;
  }

  function extractWordAtOffset(sourceText, offset) {
    const text = String(sourceText || "");
    const safeOffset = clamp(Number(offset) || 0, 0, text.length);
    const left = text.slice(0, safeOffset).match(/[\p{L}\p{M}\p{N}'-]+$/u)?.[0] || "";
    const right = text.slice(safeOffset).match(/^[\p{L}\p{M}\p{N}'-]+/u)?.[0] || "";
    return normalizeSelection(`${left}${right}`);
  }

  function getSelectionPoint() {
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

  function emitSelection(sourceEvent) {
    const text = window.getSelection()?.toString() || "";
    if (!text) {
      lastSelection = "";
      return false;
    }

    const point =
      sourceEvent && typeof sourceEvent.clientX === "number"
        ? { clientX: sourceEvent.clientX, clientY: sourceEvent.clientY }
        : getSelectionPoint();

    return dispatchSelection(text, point);
  }

  function tryEmitSelectionFromCaret(sourceEvent) {
    const clientX =
      sourceEvent && typeof sourceEvent.clientX === "number"
        ? sourceEvent.clientX
        : lastPointer.clientX;
    const clientY =
      sourceEvent && typeof sourceEvent.clientY === "number"
        ? sourceEvent.clientY
        : lastPointer.clientY;

    let textNode = null;
    let offset = 0;

    try {
      if (typeof document.caretPositionFromPoint === "function") {
        const pos = document.caretPositionFromPoint(clientX, clientY);
        textNode = pos?.offsetNode || null;
        offset = pos?.offset || 0;
      } else if (typeof document.caretRangeFromPoint === "function") {
        const range = document.caretRangeFromPoint(clientX, clientY);
        textNode = range?.startContainer || null;
        offset = range?.startOffset || 0;
      }
    } catch (_) {
      return false;
    }

    if (!textNode) {
      return false;
    }

    const textSource =
      textNode.nodeType === Node.TEXT_NODE
        ? textNode.textContent || ""
        : textNode.textContent || "";
    if (!textSource) {
      return false;
    }

    const extractedWord = extractWordAtOffset(textSource, offset);
    if (!extractedWord || extractedWord.length < 2) {
      return false;
    }

    return dispatchSelection(extractedWord, { clientX, clientY });
  }

  function getPageCanvasFromEvent(sourceEvent) {
    const target = sourceEvent?.target;
    if (!target || typeof target.closest !== "function") {
      return null;
    }

    const pageEl = target.closest(".page");
    if (!pageEl) {
      return null;
    }
    return pageEl.querySelector("canvas");
  }

  function createOcrCrop(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    const cssHalf = OCR_CROP_SIZE_CSS / 2;
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const cropCssW = Math.min(OCR_CROP_SIZE_CSS, rect.width);
    const cropCssH = Math.min(Math.round(OCR_CROP_SIZE_CSS * 0.5), rect.height);
    const cropCssX = clamp(localX - cssHalf, 0, Math.max(0, rect.width - cropCssW));
    const cropCssY = clamp(localY - cropCssH / 2, 0, Math.max(0, rect.height - cropCssH));

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const sx = Math.max(0, Math.floor(cropCssX * scaleX));
    const sy = Math.max(0, Math.floor(cropCssY * scaleY));
    const sw = Math.max(1, Math.floor(cropCssW * scaleX));
    const sh = Math.max(1, Math.floor(cropCssH * scaleY));

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = sw;
    tmpCanvas.height = sh;

    const ctx = tmpCanvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    return {
      image: tmpCanvas,
      centerX: sw / 2,
      centerY: sh / 2,
    };
  }

  async function maybeEmitOcrSelection(sourceEvent) {
    if (!sourceEvent || typeof sourceEvent.clientX !== "number") {
      return false;
    }
    if (typeof TextDetector === "undefined") {
      return false;
    }
    if (ocrInFlight) {
      return false;
    }
    if (Date.now() - lastOcrTs < ocrThrottleMs) {
      return false;
    }

    const canvas = getPageCanvasFromEvent(sourceEvent);
    if (!canvas) {
      return false;
    }

    const hasTextLayer = !!canvas.closest(".page")?.querySelector(".textLayer span");
    if (hasTextLayer) {
      return false;
    }

    const crop = createOcrCrop(canvas, sourceEvent.clientX, sourceEvent.clientY);
    if (!crop) {
      return false;
    }

    if (!textDetector) {
      try {
        textDetector = new TextDetector({ languages: ["en"] });
      } catch (_) {
        textDetector = new TextDetector();
      }
    }

    ocrInFlight = true;
    lastOcrTs = Date.now();
    setStatus("OCR...");

    try {
      const blocks = await textDetector.detect(crop.image);
      if (!Array.isArray(blocks) || blocks.length === 0) {
        setTransientStatus("No text detected", 900);
        return false;
      }

      let bestText = "";
      let bestScore = Number.POSITIVE_INFINITY;
      for (const block of blocks) {
        const raw = normalizeSelection(block?.rawValue || "");
        if (raw.length < 2) {
          continue;
        }
        const box = block?.boundingBox;
        const boxCenterX =
          box && Number.isFinite(box.x) && Number.isFinite(box.width)
            ? box.x + box.width / 2
            : crop.centerX;
        const boxCenterY =
          box && Number.isFinite(box.y) && Number.isFinite(box.height)
            ? box.y + box.height / 2
            : crop.centerY;
        const distance = Math.hypot(boxCenterX - crop.centerX, boxCenterY - crop.centerY);
        if (distance < bestScore) {
          bestScore = distance;
          bestText = raw;
        }
      }

      if (!bestText) {
        setTransientStatus("No text detected", 900);
        return false;
      }

      const clipped = bestText.slice(0, OCR_MAX_RESULT_CHARS);
      const emitted = dispatchSelection(clipped, {
        clientX: sourceEvent.clientX,
        clientY: sourceEvent.clientY,
      });
      setStatus("");
      return emitted;
    } catch (_) {
      setTransientStatus("OCR unavailable", 1300);
      return false;
    } finally {
      ocrInFlight = false;
    }
  }

  function scheduleViewerCleanup() {
    const now = Date.now();
    if (now - lastCleanupScheduleTs < 140) {
      return;
    }
    lastCleanupScheduleTs = now;

    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
    }
    if (cleanupIdleHandle && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(cleanupIdleHandle);
      cleanupIdleHandle = null;
    }

    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;

      const runCleanup = () => {
        if (pdfViewer && typeof pdfViewer.cleanup === "function") {
          pdfViewer.cleanup();
        }
        if (pdfDocument && typeof pdfDocument.cleanup === "function") {
          pdfDocument.cleanup();
        }
      };

      if (typeof requestIdleCallback === "function") {
        cleanupIdleHandle = requestIdleCallback(() => {
          cleanupIdleHandle = null;
          runCleanup();
        });
        return;
      }

      runCleanup();
    }, cleanupIdleMs);
  }

  function scheduleSelectionEmit(sourceEvent) {
    if (selectionDebounce) {
      clearTimeout(selectionDebounce);
    }

    selectionDebounce = setTimeout(() => {
      selectionDebounce = null;
      const emitted = emitSelection(sourceEvent);
      if (emitted) {
        return;
      }

      // If text selection exists but is unchanged, skip expensive fallbacks.
      if (normalizeSelection(window.getSelection()?.toString() || "")) {
        return;
      }

      const isMouseFallback =
        sourceEvent &&
        sourceEvent.type === "mouseup" &&
        Number(sourceEvent.detail || 0) >= 2 &&
        typeof sourceEvent.clientX === "number";
      if (!isMouseFallback) {
        return;
      }

      if (tryEmitSelectionFromCaret(sourceEvent)) {
        return;
      }

      if (!ocrEnabled) {
        return;
      }

      void maybeEmitOcrSelection(sourceEvent);
    }, selectionDebounceMs);
  }

  function installCleanupHooks() {
    if (!viewerContainer) {
      return;
    }

    viewerContainer.addEventListener("scroll", scheduleViewerCleanup, { passive: true });
    window.addEventListener("resize", scheduleViewerCleanup, { passive: true });
  }

  function ensureViewerContainerLayout() {
    if (!viewerContainer) {
      return;
    }

    const style = window.getComputedStyle(viewerContainer);
    if (style.position !== "absolute") {
      viewerContainer.style.position = "absolute";
      viewerContainer.style.top = "44px";
      viewerContainer.style.left = "0";
      viewerContainer.style.right = "0";
      viewerContainer.style.bottom = "0";
      viewerContainer.style.overflow = "auto";
      viewerContainer.style.overflowX = "hidden";
    }
  }

  function installSelectionObservers() {
    document.addEventListener(
      "mousemove",
      (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
      },
      { passive: true },
    );

    document.addEventListener(
      "mousedown",
      () => {
        pointerDown = true;
      },
      true,
    );

    document.addEventListener(
      "mouseup",
      (event) => {
        pointerDown = false;
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
        scheduleSelectionEmit(event);
      },
      true,
    );

    document.addEventListener(
      "selectionchange",
      () => {
        const hasSelection = normalizeSelection(window.getSelection()?.toString() || "").length > 0;
        if (!pointerDown && !hasSelection) {
          return;
        }
        scheduleSelectionEmit();
      },
      true,
    );

    document.addEventListener(
      "keyup",
      (event) => {
        scheduleSelectionEmit(event);
      },
      true,
    );
  }

  function getPageElementFromPoint(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target || typeof target.closest !== "function") {
      return null;
    }
    return target.closest(".page");
  }

  function collectHighlightRects(selection) {
    const rectsByPage = new Map();
    if (!selection || selection.rangeCount === 0) {
      return rectsByPage;
    }

    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      const rects = Array.from(range.getClientRects() || []);
      rects.forEach((rect) => {
        if (rect.width < MIN_HIGHLIGHT_RECT_PX || rect.height < MIN_HIGHLIGHT_RECT_PX) {
          return;
        }
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const pageEl = getPageElementFromPoint(centerX, centerY);
        if (!pageEl) {
          return;
        }
        const pageRect = pageEl.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
          return;
        }
        const pageNumber = Number(pageEl.getAttribute("data-page-number") || 0);
        if (!pageNumber) {
          return;
        }

        const normalized = {
          x: clamp01((rect.left - pageRect.left) / pageRect.width),
          y: clamp01((rect.top - pageRect.top) / pageRect.height),
          w: clamp01(rect.width / pageRect.width),
          h: clamp01(rect.height / pageRect.height),
        };

        if (normalized.w <= 0 || normalized.h <= 0) {
          return;
        }

        if (!rectsByPage.has(pageNumber)) {
          rectsByPage.set(pageNumber, []);
        }
        rectsByPage.get(pageNumber).push(normalized);
      });
    }

    return rectsByPage;
  }

  function renderHighlightsForPage(pageNumber) {
    if (!pagesEl || !pageNumber) {
      return;
    }
    const pageEl = pagesEl.querySelector(`.page[data-page-number="${pageNumber}"]`);
    if (!pageEl) {
      return;
    }
    let layer = pageEl.querySelector(".pdf-highlight-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "pdf-highlight-layer";
      pageEl.appendChild(layer);
    }
    layer.innerHTML = "";

    const highlights = Array.isArray(pdfAnnotations?.highlights)
      ? pdfAnnotations.highlights.filter((item) => Number(item?.page) === Number(pageNumber))
      : [];

    highlights.forEach((highlight) => {
      const rects = Array.isArray(highlight?.rects) ? highlight.rects : [];
      rects.forEach((rect) => {
        if (!rect) {
          return;
        }
        const block = document.createElement("div");
        block.className = "pdf-highlight";
        block.setAttribute("data-highlight-id", highlight.id || "");
        block.style.background = hexToRgba(highlight.color || highlightColor, 0.65);
        block.style.left = `${clamp01(rect.x) * 100}%`;
        block.style.top = `${clamp01(rect.y) * 100}%`;
        block.style.width = `${clamp01(rect.w) * 100}%`;
        block.style.height = `${clamp01(rect.h) * 100}%`;
        layer.appendChild(block);
      });
    });
  }

  function renderAllHighlights() {
    if (!pagesEl) {
      return;
    }
    const pageEls = pagesEl.querySelectorAll(".page[data-page-number]");
    pageEls.forEach((pageEl) => {
      const pageNumber = Number(pageEl.getAttribute("data-page-number") || 0);
      if (pageNumber) {
        renderHighlightsForPage(pageNumber);
      }
    });
  }

  async function addHighlightsFromSelection() {
    if (!annotationsReady || !highlightMode) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const rectsByPage = collectHighlightRects(selection);
    if (rectsByPage.size === 0) {
      return;
    }

    rectsByPage.forEach((rects, pageNumber) => {
      pdfAnnotations.highlights.push({
        id: createId(),
        page: pageNumber,
        rects,
        color: highlightColor,
        createdAt: Date.now(),
      });
      renderHighlightsForPage(pageNumber);
    });

    try {
      selection.removeAllRanges();
    } catch (_) {
      // ignore selection cleanup errors
    }

    await saveAnnotationsForDoc(currentDocId);
    setTransientStatus("Highlighted", 900);
  }

  async function removeHighlightById(id) {
    if (!id || !Array.isArray(pdfAnnotations?.highlights)) {
      return;
    }
    const target = pdfAnnotations.highlights.find((item) => item?.id === id);
    pdfAnnotations.highlights = pdfAnnotations.highlights.filter((item) => item?.id !== id);
    if (target) {
      renderHighlightsForPage(target.page);
      await saveAnnotationsForDoc(currentDocId);
      setTransientStatus("Highlight removed", 900);
    }
  }

  function setBookmarkPanelOpen(open) {
    if (!bookmarkPanel || !toggleBookmarksBtn) {
      return;
    }
    bookmarkPanel.hidden = !open;
    bookmarkPanel.style.display = open ? "flex" : "none";
    toggleBookmarksBtn.setAttribute("aria-expanded", open ? "true" : "false");

    if (bookmarkAutoHideTimer) {
      clearTimeout(bookmarkAutoHideTimer);
      bookmarkAutoHideTimer = null;
    }
    if (open) {
      bookmarkAutoHideTimer = setTimeout(() => {
        bookmarkAutoHideTimer = null;
        setBookmarkPanelOpen(false);
      }, BOOKMARK_AUTOHIDE_MS);
    }
  }

  function openBookmarkPanel() {
    renderBookmarksPanel();
    setBookmarkPanelOpen(true);
  }

  function renderBookmarksPanel() {
    if (!bookmarkList || !bookmarkEmpty || !toggleBookmarksBtn) {
      return;
    }
    const bookmarks = Array.isArray(pdfAnnotations?.bookmarks)
      ? [...pdfAnnotations.bookmarks]
      : [];
    bookmarks.sort((a, b) => Number(a?.page || 0) - Number(b?.page || 0));

    bookmarkList.innerHTML = "";
    if (bookmarks.length === 0) {
      bookmarkEmpty.style.display = "block";
      toggleBookmarksBtn.textContent = "Marks";
      return;
    }

    bookmarkEmpty.style.display = "none";
    toggleBookmarksBtn.textContent = `Marks (${bookmarks.length})`;

    bookmarks.forEach((bookmark) => {
      const item = document.createElement("div");
      item.className = "pdf-bookmark-item";

      const link = document.createElement("button");
      link.className = "pdf-bookmark-link";
      link.type = "button";
      link.textContent = `Page ${bookmark.page || 1}`;
      link.addEventListener("click", () => {
        goToPage(bookmark.page || 1);
        setBookmarkPanelOpen(false);
      });

      const removeBtn = document.createElement("button");
      removeBtn.className = "pdf-bookmark-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "X";
      removeBtn.setAttribute("aria-label", "Remove bookmark");
      removeBtn.addEventListener("click", async () => {
        pdfAnnotations.bookmarks = pdfAnnotations.bookmarks.filter(
          (entry) => entry?.id !== bookmark.id,
        );
        await saveAnnotationsForDoc(currentDocId);
        renderBookmarksPanel();
      });

      item.appendChild(link);
      item.appendChild(removeBtn);
      bookmarkList.appendChild(item);
    });
  }

  async function addBookmark() {
    if (!pdfViewer || !annotationsReady) {
      return;
    }
    const page = Number(pdfViewer.currentPageNumber || 1);
    const exists = Array.isArray(pdfAnnotations.bookmarks)
      ? pdfAnnotations.bookmarks.some((item) => Number(item?.page) === page)
      : false;
    if (exists) {
      setTransientStatus("Bookmark exists", 900);
      return;
    }
    pdfAnnotations.bookmarks.push({
      id: createId(),
      page,
      createdAt: Date.now(),
    });
    await saveAnnotationsForDoc(currentDocId);
    renderBookmarksPanel();
    setTransientStatus("Bookmark added", 900);
  }

  function installSearchHandlers() {
    openSearchBtn?.addEventListener("click", () => {
      const nextOpen = !searchPanelOpen;
      setSearchPanelOpen(nextOpen, {
        focusInput: nextOpen,
        selectQuery: nextOpen,
      });
    });

    closeSearchPanel?.addEventListener("click", () => {
      setSearchPanelOpen(false);
    });

    searchInput?.addEventListener("input", () => {
      setSearchPanelOpen(true);
      schedulePdfSearchFromInput();
    });

    searchInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (searchInputDebounce) {
          clearTimeout(searchInputDebounce);
          searchInputDebounce = null;
        }
        runPdfSearch(searchInput.value, { findPrevious: !!event.shiftKey });
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (normalizeSearchQuery(searchInput.value)) {
          clearPdfSearch();
        } else {
          setSearchPanelOpen(false);
        }
      }
    });

    searchPrevBtn?.addEventListener("click", () => {
      runPdfSearch(searchInput?.value || currentSearchQuery, { findPrevious: true });
    });

    searchNextBtn?.addEventListener("click", () => {
      runPdfSearch(searchInput?.value || currentSearchQuery);
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchPanelOpen(true, {
            focusInput: true,
            selectQuery: true,
          });
          return;
        }

        if (event.key === "F3") {
          const query = normalizeSearchQuery(searchInput?.value || currentSearchQuery);
          if (!query) {
            return;
          }
          event.preventDefault();
          runPdfSearch(query, { findPrevious: !!event.shiftKey });
        }
      },
      true,
    );
  }

  function transformInkPoints(points, rect, rotation) {
    const output = points.slice();
    const [left, bottom, right, top] = rect;
    const rot = ((Number(rotation) || 0) % 360 + 360) % 360;
    switch (rot) {
      case 0:
        for (let i = 0; i < output.length; i += 2) {
          output[i] -= left;
          output[i + 1] = top - output[i + 1];
        }
        break;
      case 90:
        for (let i = 0; i < output.length; i += 2) {
          const x = output[i];
          output[i] = output[i + 1] + left;
          output[i + 1] = x + bottom;
        }
        break;
      case 180:
        for (let i = 0; i < output.length; i += 2) {
          output[i] = right - output[i];
          output[i + 1] += bottom;
        }
        break;
      case 270:
        for (let i = 0; i < output.length; i += 2) {
          const x = output[i];
          output[i] = right - output[i + 1];
          output[i + 1] = top - x;
        }
        break;
      default:
        return output;
    }
    return output;
  }

  function rectToPdfCoords(pageView, rect) {
    const viewport = pageView?.viewport;
    if (!viewport) {
      return null;
    }
    const x1 = rect.x * viewport.width;
    const y1 = rect.y * viewport.height;
    const x2 = (rect.x + rect.w) * viewport.width;
    const y2 = (rect.y + rect.h) * viewport.height;
    const [pdfX1, pdfY1] = viewport.convertToPdfPoint(x1, y1);
    const [pdfX2, pdfY2] = viewport.convertToPdfPoint(x2, y2);
    return {
      left: Math.min(pdfX1, pdfX2),
      right: Math.max(pdfX1, pdfX2),
      bottom: Math.min(pdfY1, pdfY2),
      top: Math.max(pdfY1, pdfY2),
    };
  }

  function resetExportAnnotations() {
    if (!pdfDocument?.annotationStorage) {
      exportAnnotationIds = new Set();
      return;
    }
    for (const id of exportAnnotationIds) {
      pdfDocument.annotationStorage.remove(id);
    }
    exportAnnotationIds = new Set();
  }

  function buildInkAnnotationForRect(pageView, highlight, rect, index) {
    const coords = rectToPdfCoords(pageView, rect);
    if (!coords) {
      return null;
    }
    const height = Math.max(1, coords.top - coords.bottom);
    const y = coords.bottom + height / 2;
    const bezier = [coords.left, y, coords.left, y, coords.right, y, coords.right, y];
    const points = [coords.left, y, coords.right, y];
    const rectArray = [coords.left, coords.bottom, coords.right, coords.top];
    const rotation = Number(pageView?.rotation || pageView?.viewport?.rotation || 0);
    const bezierLocal = transformInkPoints(bezier, rectArray, rotation);
    const pointsLocal = transformInkPoints(points, rectArray, rotation);

    return {
      id: `${EXPORT_ANNOTATION_PREFIX}${highlight.id || "h"}_${index}`,
      data: {
        annotationType: window.pdfjsLib?.AnnotationEditorType?.INK || 15,
        color: hexToRgbArray(highlight.color || highlightColor),
        thickness: height,
        opacity: HIGHLIGHT_EXPORT_OPACITY,
        paths: [
          {
            bezier: bezierLocal,
            points: pointsLocal,
          },
        ],
        pageIndex: Number(highlight.page || 1) - 1,
        rect: rectArray,
        rotation,
      },
    };
  }

  function applyHighlightsToAnnotationStorage() {
    if (!pdfDocument?.annotationStorage || !pdfViewer) {
      return 0;
    }
    resetExportAnnotations();

    const highlights = Array.isArray(pdfAnnotations?.highlights) ? pdfAnnotations.highlights : [];
    let count = 0;

    highlights.forEach((highlight) => {
      const pageIndex = Number(highlight?.page || 0) - 1;
      if (pageIndex < 0) {
        return;
      }
      const pageView = pdfViewer.getPageView(pageIndex);
      if (!pageView) {
        return;
      }
      const rects = Array.isArray(highlight?.rects) ? highlight.rects : [];
      rects.forEach((rect, idx) => {
        const annotation = buildInkAnnotationForRect(pageView, highlight, rect, idx);
        if (!annotation) {
          return;
        }
        pdfDocument.annotationStorage.setValue(annotation.id, annotation.data);
        exportAnnotationIds.add(annotation.id);
        count += 1;
      });
    });

    return count;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "document.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1200);
  }

  function getDownloadFileName() {
    const base = extractPdfFileName(currentDocId) || "document.pdf";
    return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  }

  async function downloadPdfWithHighlights() {
    if (!pdfDocument) {
      return;
    }
    setStatus("Preparing download...");
    try {
      const count = applyHighlightsToAnnotationStorage();
      if (count === 0) {
        const bytes = await pdfDocument.getData();
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), getDownloadFileName());
        setTransientStatus("Downloaded", 1000);
        return;
      }

      const bytes = await pdfDocument.saveDocument();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), getDownloadFileName());
      setTransientStatus("Downloaded with highlights", 1400);
    } catch (error) {
      try {
        const bytes = await pdfDocument.getData();
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), getDownloadFileName());
        setTransientStatus("Downloaded (no highlights)", 1400);
      } catch (_) {
        setTransientStatus("Download failed", 1600);
      }
    }
  }

  function installAnnotationHandlers() {
    highlightToggle?.addEventListener("click", () => {
      setHighlightMode(!highlightMode);
    });

    eraseToggle?.addEventListener("click", () => {
      setEraseMode(!eraseMode);
    });

    addBookmarkBtn?.addEventListener("click", () => {
      void addBookmark();
    });

    document.querySelectorAll(".pdf-color-swatch[data-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        const color = swatch.getAttribute("data-color") || "";
        if (!color) {
          return;
        }
        highlightColor = normalizeHexColor(color);
        void saveViewerSetting(HIGHLIGHT_COLOR_KEY, highlightColor);
        syncHighlightColorUi();
      });
    });

    highlightColorPicker?.addEventListener("change", () => {
      highlightColor = normalizeHexColor(highlightColorPicker.value);
      void saveViewerSetting(HIGHLIGHT_COLOR_KEY, highlightColor);
      syncHighlightColorUi();
    });

    toggleBookmarksBtn?.addEventListener("click", () => {
      openBookmarkPanel();
    });

    closeBookmarkPanel?.addEventListener("click", () => {
      setBookmarkPanelOpen(false);
    });

    downloadPdfBtn?.addEventListener("click", () => {
      void downloadPdfWithHighlights();
    });

    document.addEventListener(
      "mouseup",
      (event) => {
        if (!highlightMode) {
          return;
        }
        if (event && event.button !== 0) {
          return;
        }
        setTimeout(() => {
          void addHighlightsFromSelection();
        }, 0);
      },
      true,
    );

    pagesEl?.addEventListener("click", (event) => {
      if (!eraseMode) {
        return;
      }
      const target = event.target;
      if (!target || typeof target.closest !== "function") {
        return;
      }
      const highlightEl = target.closest(".pdf-highlight");
      const highlightId = highlightEl?.getAttribute("data-highlight-id") || "";
      if (!highlightId) {
        return;
      }
      void removeHighlightById(highlightId);
    });

    document.addEventListener("mousedown", (event) => {
      if (!bookmarkPanel || bookmarkPanel.hidden) {
        return;
      }
      const target = event.target;
      if (
        (bookmarkPanel && bookmarkPanel.contains(target)) ||
        (toggleBookmarksBtn && toggleBookmarksBtn.contains(target))
      ) {
        return;
      }
      setBookmarkPanelOpen(false);
    });
  }

  function applyZoom(value) {
    if (!pdfViewer || !value) {
      return;
    }

    if (
      value === "page-width" ||
      value === "page-fit" ||
      value === "auto" ||
      value === "page-actual"
    ) {
      pdfViewer.currentScaleValue = value;
      scheduleViewerCleanup();
      return;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      pdfViewer.currentScale = clamp(numeric, MIN_SCALE, MAX_SCALE);
      scheduleViewerCleanup();
    }
  }

  function syncZoomSelect(scale, presetValue) {
    if (!zoomSelect) {
      return;
    }

    if (
      presetValue &&
      Array.from(zoomSelect.options).some((option) => option.value === presetValue)
    ) {
      zoomSelect.value = presetValue;
      return;
    }

    const options = Array.from(zoomSelect.options);
    const matched = options.find((option) => {
      const numeric = Number(option.value);
      return Number.isFinite(numeric) && Math.abs(numeric - scale) < 0.01;
    });
    if (matched) {
      zoomSelect.value = matched.value;
      return;
    }

    let dynamicOption = zoomSelect.querySelector('option[data-dynamic-zoom="true"]');
    if (!dynamicOption) {
      dynamicOption = document.createElement("option");
      dynamicOption.setAttribute("data-dynamic-zoom", "true");
      zoomSelect.appendChild(dynamicOption);
    }
    dynamicOption.value = String(Number((scale || 1).toFixed(2)));
    dynamicOption.textContent = `${Math.round((scale || 1) * 100)}%`;
    zoomSelect.value = dynamicOption.value;
  }

  function getCurrentScale() {
    return pdfViewer && Number.isFinite(pdfViewer.currentScale) ? pdfViewer.currentScale : 1;
  }

  function stepZoom(direction) {
    const current = getCurrentScale();
    const next = direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
    applyZoom(Number(clamp(next, MIN_SCALE, MAX_SCALE).toFixed(2)));
  }

  function clampPageNumber(value) {
    const maxPages = pdfDocument?.numPages || 1;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 1;
    }
    return clamp(Math.floor(numeric), 1, maxPages);
  }

  function updatePageUi(pageNumber) {
    if (pageNumberInput) {
      pageNumberInput.value = String(clampPageNumber(pageNumber));
    }
  }

  function goToPage(pageNumber) {
    if (!pdfViewer || !pdfDocument) {
      return;
    }
    const safePage = clampPageNumber(pageNumber);
    pdfViewer.currentPageNumber = safePage;
    updatePageUi(safePage);
    scheduleViewerCleanup();
  }

  function installToolbarHandlers() {
    zoomSelect?.addEventListener("change", () => {
      applyZoom(zoomSelect.value || DEFAULT_SCALE_VALUE);
    });

    zoomInBtn?.addEventListener("click", () => {
      stepZoom(1);
    });

    zoomOutBtn?.addEventListener("click", () => {
      stepZoom(-1);
    });

    pageNumberInput?.addEventListener("change", () => {
      goToPage(pageNumberInput.value);
    });

    pageNumberInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        goToPage(pageNumberInput.value);
      }
    });

    ocrToggle?.addEventListener("change", async () => {
      ocrEnabled = !!ocrToggle.checked;
      await saveViewerSetting(OCR_ENABLED_KEY, ocrEnabled);
      setTransientStatus(ocrEnabled ? "OCR on" : "OCR off", 900);
    });

    lowResourceToggle?.addEventListener("change", async () => {
      const nextValue = !!lowResourceToggle.checked;
      await saveViewerSetting(LOW_RESOURCE_KEY, nextValue);
      lowResourceMode = nextValue;
      applyPerformanceProfile();
      setStatus("Reloading...");
      window.location.reload();
    });
  }

  function bindViewerEvents() {
    if (!eventBus) {
      return;
    }

    eventBus.on("pagesinit", () => {
      const defaultScale = lowResourceMode ? LOW_RESOURCE_SCALE_VALUE : DEFAULT_SCALE_VALUE;
      applyZoom(zoomSelect?.value || defaultScale);
      updatePageUi(1);
      scheduleViewerCleanup();
    });

    eventBus.on("pagesloaded", (evt) => {
      if (pageCountLabel) {
        const pagesCount = evt?.pagesCount || pdfDocument?.numPages || 0;
        pageCountLabel.textContent = `/ ${pagesCount}`;
      }
      setStatus("");
    });

    eventBus.on("pagechanging", (evt) => {
      updatePageUi(evt?.pageNumber || 1);
    });

    eventBus.on("scalechanging", (evt) => {
      syncZoomSelect(evt?.scale || getCurrentScale(), evt?.presetValue || "");
      scheduleViewerCleanup();
    });

    eventBus.on("pagerendered", (evt) => {
      const pageNumber = Number(evt?.pageNumber || 0);
      if (pageNumber) {
        renderHighlightsForPage(pageNumber);
      }
    });

    eventBus.on("textlayerrendered", (evt) => {
      const pageNumber = Number(evt?.pageNumber || 0);
      if (pageNumber) {
        renderHighlightsForPage(pageNumber);
      }
    });

    eventBus.on("updatefindcontrolstate", (evt) => {
      if (evt?.source && evt.source !== findController) {
        return;
      }

      const inputQuery = normalizeSearchQuery(searchInput?.value || "");
      if (!inputQuery && !currentSearchQuery) {
        updateSearchCountUi({ current: 0, total: 0 });
        syncSearchResultSelection(0);
        return;
      }

      const rawQuery =
        typeof evt?.rawQuery === "string" ? normalizeSearchQuery(evt.rawQuery) : currentSearchQuery;
      if (!rawQuery) {
        return;
      }

      currentSearchQuery = rawQuery;
      updateSearchCountUi(evt?.matchesCount);

      if (!searchMatchesCount.total) {
        invalidateSearchResults();
        setSearchEmptyMessage(`No matches found for "${rawQuery}".`);
        setTransientStatus("No matches", 900);
        return;
      }

      setStatus("");
      syncSearchResultSelection(searchMatchesCount.current, searchPanelOpen);

      if (
        renderedSearchQuery !== rawQuery ||
        searchResults?.childElementCount !== searchMatchesCount.total
      ) {
        void renderSearchResultsList(rawQuery);
      }
    });
  }

  function createViewer() {
    if (!window.pdfjsLib || !window.pdfjsViewer) {
      throw new Error("PDF.js failed to initialize.");
    }

    ensureViewerContainerLayout();

    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

    eventBus = new pdfjsViewer.EventBus();
    linkService = new pdfjsViewer.PDFLinkService({ eventBus });
    findController = new pdfjsViewer.PDFFindController({
      linkService,
      eventBus,
      updateMatchesCountOnProgress: false,
    });

    pdfViewer = new pdfjsViewer.PDFViewer({
      container: viewerContainer,
      viewer: pagesEl,
      eventBus,
      linkService,
      findController,
      textLayerMode: 2,
      removePageBorders: false,
      enhanceTextSelection: true,
      useOnlyCssZoom: false,
      maxCanvasPixels: lowResourceMode ? LOW_RESOURCE_MAX_CANVAS_PIXELS : MAX_CANVAS_PIXELS,
    });

    linkService.setViewer(pdfViewer);
    bindViewerEvents();
  }

  function createDocumentParams(url) {
    return {
      url,
      withCredentials: false,
      disableAutoFetch: !!lowResourceMode,
      disableStream: false,
      disableRange: false,
      rangeChunkSize: lowResourceMode ? 32768 : 65536,
      maxImageSize: -1,
      isEvalSupported: false,
      useSystemFonts: true,
      stopAtErrors: false,
    };
  }

  async function openPdf(url) {
    resetSearchCache();
    setStatus("Loading...");
    const loadingTask = pdfjsLib.getDocument(createDocumentParams(url));
    const documentRef = await loadingTask.promise;
    pdfDocument = documentRef;

    linkService.setDocument(pdfDocument, null);
    pdfViewer.setDocument(pdfDocument);

    if (pageCountLabel) {
      pageCountLabel.textContent = `/ ${pdfDocument.numPages || 0}`;
    }
    updatePageUi(1);
    scheduleViewerCleanup();
  }

  function showSourceHints(pdfUrl) {
    if (/^blob:/i.test(pdfUrl)) {
      showNote(
        "Blob PDF URLs may fail after redirect due to origin isolation. Reopen the source page and click the extension icon again.",
      );
      return;
    }

    hideNote();
  }

  async function init() {
    await loadViewerSettings();
    applyPerformanceProfile();
    syncSettingsUi();
    enforceOcrAvailability();

    if (zoomSelect && lowResourceMode && zoomSelect.value === DEFAULT_SCALE_VALUE) {
      zoomSelect.value = LOW_RESOURCE_SCALE_VALUE;
    }
    if (lowResourceMode) {
      setTransientStatus("Lite mode", 1600);
    }

    installSelectionObservers();
    installSearchHandlers();
    installToolbarHandlers();
    installCleanupHooks();
    installAnnotationHandlers();
    syncAnnotationModeUi();
    syncSearchPanelToggleUi();
    clearSearchResultsUi();

    const params = new URLSearchParams(window.location.search);
    const fileParam = params.get("file");

    if (!fileParam) {
      showNote("No PDF URL was provided.");
      return;
    }

    const sourceUrl = decodeFileParam(fileParam);
    currentDocId = normalizeDocumentId(sourceUrl);
    setViewerTitle(sourceUrl);
    showSourceHints(sourceUrl);

    try {
      createViewer();
      await openPdf(sourceUrl);
      await loadAnnotationsForDoc(currentDocId);
      renderBookmarksPanel();
      renderAllHighlights();
      hideNote();
    } catch (error) {
      setStatus("Failed");
      if (/^file:/i.test(sourceUrl)) {
        showNote(
          `Failed to render PDF: ${error.message}. Enable 'Allow access to file URLs' in chrome://extensions for TextBridge.`,
        );
      } else {
        showNote(`Failed to render PDF: ${error.message}`);
      }
    }
  }

  window.addEventListener("beforeunload", () => {
    if (selectionDebounce) {
      clearTimeout(selectionDebounce);
      selectionDebounce = null;
    }
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    if (cleanupIdleHandle && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(cleanupIdleHandle);
      cleanupIdleHandle = null;
    }
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    if (searchInputDebounce) {
      clearTimeout(searchInputDebounce);
      searchInputDebounce = null;
    }
    if (pdfViewer && typeof pdfViewer.cleanup === "function") {
      pdfViewer.cleanup();
    }
    if (pdfDocument && typeof pdfDocument.cleanup === "function") {
      pdfDocument.cleanup();
    }
    findController = null;
    pdfViewer = null;
    pdfDocument = null;
  });

  init();
})();
