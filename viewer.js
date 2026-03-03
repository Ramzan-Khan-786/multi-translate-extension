(function () {
  const noteEl = document.getElementById("viewerNote");
  const pagesEl = document.getElementById("pdfPages");
  const viewerContainer = document.getElementById("viewerContainer");
  const zoomSelect = document.getElementById("zoomSelect");

  const WORKER_URL = "pdfjs/pdf.worker.min.js";
  const SELECTION_DEBOUNCE_MS = 250;
  const SELECTION_POLL_MS = 320;

  let selectionDebounce = null;
  let lastSelection = "";
  let lastPointer = {
    clientX: Math.round(window.innerWidth / 2),
    clientY: Math.round(window.innerHeight / 2),
  };
  let pdfViewer = null;

  function raf(fn) {
    requestAnimationFrame(fn);
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

  function normalizeSelection(raw) {
    return (raw || "").replace(/\s+/g, " ").trim();
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
    const text = normalizeSelection(window.getSelection()?.toString() || "");
    if (!text) {
      lastSelection = "";
      return;
    }

    if (text === lastSelection) {
      return;
    }
    lastSelection = text;

    const point =
      sourceEvent && typeof sourceEvent.clientX === "number"
        ? { clientX: sourceEvent.clientX, clientY: sourceEvent.clientY }
        : getSelectionPoint();

    raf(() => {
      document.dispatchEvent(
        new CustomEvent("lexicon-pro-selection", {
          detail: {
            text,
            clientX: point.clientX,
            clientY: point.clientY,
          },
          bubbles: true,
        }),
      );
    });
  }

  function scheduleSelectionEmit(sourceEvent) {
    if (selectionDebounce) {
      clearTimeout(selectionDebounce);
    }

    selectionDebounce = setTimeout(() => {
      selectionDebounce = null;
      emitSelection(sourceEvent);
    }, SELECTION_DEBOUNCE_MS);
  }

  async function checkPdfContentType(url) {
    if (!/^https?:/i.test(url)) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
      });
      const type = response.headers.get("content-type") || "";
      return type.toLowerCase();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchPdfData(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "default",
    });

    if (!response.ok) {
      throw new Error(`Unable to load PDF (${response.status})`);
    }

    return response.arrayBuffer();
  }

  function installSelectionObservers() {
    document.addEventListener("mousemove", (event) => {
      lastPointer = { clientX: event.clientX, clientY: event.clientY };
    });

    document.addEventListener(
      "mouseup",
      (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
        scheduleSelectionEmit(event);
      },
      true,
    );

    document.addEventListener(
      "selectionchange",
      () => {
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

    setInterval(() => {
      scheduleSelectionEmit();
    }, SELECTION_POLL_MS);
  }

  function installZoomHandler() {
    if (!zoomSelect) {
      return;
    }

    zoomSelect.addEventListener("change", () => {
      const nextScale = Number(zoomSelect.value || "1");
      if (!pdfViewer || !Number.isFinite(nextScale) || nextScale <= 0) {
        return;
      }
      pdfViewer.currentScale = nextScale;
    });
  }

  async function renderPdf(arrayBuffer) {
    if (!window.pdfjsLib || !window.pdfjsViewer) {
      throw new Error("PDF.js failed to initialize.");
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({ eventBus });

    pdfViewer = new pdfjsViewer.PDFViewer({
      container: viewerContainer,
      viewer: pagesEl,
      eventBus,
      linkService,
      textLayerMode: 2,
      removePageBorders: false,
      // Keep this for compatibility with some pdfjs builds.
      enhanceTextSelection: true,
    });

    linkService.setViewer(pdfViewer);

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDocument = await loadingTask.promise;

    linkService.setDocument(pdfDocument, null);
    pdfViewer.setDocument(pdfDocument);

    eventBus.on("pagesinit", () => {
      const initialScale = Number(zoomSelect?.value || "1");
      pdfViewer.currentScale = Number.isFinite(initialScale) && initialScale > 0 ? initialScale : 1;
    });
  }

  async function init() {
    installSelectionObservers();
    installZoomHandler();

    const params = new URLSearchParams(window.location.search);
    const file = params.get("file");

    if (!file) {
      showNote("No PDF URL was provided.");
      return;
    }

    const decoded = decodeURIComponent(file);

    if (/^file:/i.test(decoded)) {
      showNote(
        "If this local PDF does not load, enable 'Allow access to file URLs' in chrome://extensions for Lexicon Pro.",
      );
    }

    if (/^blob:/i.test(decoded)) {
      showNote(
        "Blob PDF URLs may fail after redirect due to origin isolation. Reopen the source page and click the extension icon again.",
      );
    } else {
      const type = await checkPdfContentType(decoded);
      if (type && !type.includes("application/pdf")) {
        showNote(`This URL responded with Content-Type '${type}', so it may not be a PDF.`);
      }
    }

    try {
      const pdfData = await fetchPdfData(decoded);
      await renderPdf(pdfData);
    } catch (error) {
      showNote(`Failed to render PDF: ${error.message}`);
    }
  }

  init();
})();