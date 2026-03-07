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
  const ocrToggle = document.getElementById("ocrToggle");
  const lowResourceToggle = document.getElementById("lowResourceToggle");

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
  const STATUS_CLEAR_DEFAULT_MS = 1100;
  const OCR_ENABLED_KEY = "pdf_ocr_enabled";
  const LOW_RESOURCE_KEY = "pdf_low_resource_mode";

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
  let textDetector = null;
  let ocrInFlight = false;
  let lastOcrTs = 0;
  let ocrEnabled = true;
  let lowResourceMode = false;
  let statusClearTimer = null;
  let selectionDebounceMs = SELECTION_DEBOUNCE_MS;
  let cleanupIdleMs = CLEANUP_IDLE_MS;
  let ocrThrottleMs = OCR_THROTTLE_MS;

  function raf(fn) {
    requestAnimationFrame(fn);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getStorageArea() {
    const c = globalThis.chrome;
    return c && c.storage && c.storage.local ? c.storage.local : null;
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
    };

    if (!storage || typeof storage.get !== "function") {
      ocrEnabled = defaults[OCR_ENABLED_KEY];
      lowResourceMode = defaults[LOW_RESOURCE_KEY];
      return;
    }

    try {
      const settings = await storage.get([OCR_ENABLED_KEY, LOW_RESOURCE_KEY]);
      ocrEnabled =
        typeof settings[OCR_ENABLED_KEY] === "boolean"
          ? settings[OCR_ENABLED_KEY]
          : defaults[OCR_ENABLED_KEY];
      lowResourceMode =
        typeof settings[LOW_RESOURCE_KEY] === "boolean"
          ? settings[LOW_RESOURCE_KEY]
          : defaults[LOW_RESOURCE_KEY];
    } catch (_) {
      ocrEnabled = defaults[OCR_ENABLED_KEY];
      lowResourceMode = defaults[LOW_RESOURCE_KEY];
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

  function syncSettingsUi() {
    if (ocrToggle) {
      ocrToggle.checked = !!ocrEnabled;
    }
    if (lowResourceToggle) {
      lowResourceToggle.checked = !!lowResourceMode;
    }
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
  }

  function createViewer() {
    if (!window.pdfjsLib || !window.pdfjsViewer) {
      throw new Error("PDF.js failed to initialize.");
    }

    ensureViewerContainerLayout();

    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

    eventBus = new pdfjsViewer.EventBus();
    linkService = new pdfjsViewer.PDFLinkService({ eventBus });

    pdfViewer = new pdfjsViewer.PDFViewer({
      container: viewerContainer,
      viewer: pagesEl,
      eventBus,
      linkService,
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
    installToolbarHandlers();
    installCleanupHooks();

    const params = new URLSearchParams(window.location.search);
    const fileParam = params.get("file");

    if (!fileParam) {
      showNote("No PDF URL was provided.");
      return;
    }

    const sourceUrl = decodeFileParam(fileParam);
    setViewerTitle(sourceUrl);
    showSourceHints(sourceUrl);

    try {
      createViewer();
      await openPdf(sourceUrl);
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
    if (pdfViewer && typeof pdfViewer.cleanup === "function") {
      pdfViewer.cleanup();
    }
    if (pdfDocument && typeof pdfDocument.cleanup === "function") {
      pdfDocument.cleanup();
    }
    pdfViewer = null;
    pdfDocument = null;
  });

  init();
})();
