(() => {
  const EXTENSION_ENABLED_KEY = "textbridge_enabled";

  const els = {
    toggle: document.getElementById("enabledToggle"),
    badge: document.getElementById("stateBadge"),
    status: document.getElementById("status"),
    pdfBtn: document.getElementById("pdfBtn"),
  };

  function getChrome() {
    return globalThis.chrome || null;
  }

  function resolveEnabled(value) {
    return value !== false;
  }

  function setStatus(message, isError) {
    if (!els.status) {
      return;
    }
    els.status.textContent = message || "";
    els.status.className = `status ${isError ? "error" : "ok"}`;
  }

  function renderState(enabled) {
    if (els.toggle) {
      els.toggle.checked = !!enabled;
    }
    if (els.badge) {
      els.badge.textContent = enabled ? "On" : "Off";
      els.badge.classList.toggle("is-off", !enabled);
    }
    setStatus(
      enabled ? "TextBridge is active." : "TextBridge is paused.",
      false,
    );
  }

  async function loadState() {
    const chromeApi = getChrome();
    if (!chromeApi?.storage?.local?.get) {
      renderState(true);
      return;
    }

    try {
      const data = await chromeApi.storage.local.get([EXTENSION_ENABLED_KEY]);
      renderState(resolveEnabled(data[EXTENSION_ENABLED_KEY]));
    } catch (_) {
      renderState(true);
    }
  }

  async function saveState(enabled) {
    const chromeApi = getChrome();
    if (!chromeApi?.storage?.local?.set) {
      renderState(enabled);
      return;
    }

    try {
      await chromeApi.storage.local.set({ [EXTENSION_ENABLED_KEY]: !!enabled });
      renderState(!!enabled);
    } catch (_) {
      setStatus("Failed to update toggle.", true);
    }
  }

  async function openPdfViewer() {
    const chromeApi = getChrome();
    if (!chromeApi?.tabs?.query || !chromeApi?.runtime?.sendMessage) {
      setStatus("Extension runtime unavailable.", true);
      return;
    }

    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("No active tab found.", true);
      return;
    }

    try {
      const response = await chromeApi.runtime.sendMessage({
        type: "OPEN_PDF_VIEWER",
        tabId: tab.id,
      });

      if (response?.ok) {
        setStatus("Opening PDF viewer...", false);
        window.close();
        return;
      }

      if (response?.reason === "already_viewer") {
        setStatus("PDF viewer already open.", false);
        return;
      }

      if (response?.reason === "not_pdf") {
        setStatus("This tab is not a PDF.", true);
        return;
      }

      setStatus(response?.error || "Could not open PDF viewer.", true);
    } catch (_) {
      setStatus("Could not reach background service.", true);
    }
  }

  function wireEvents() {
    els.toggle?.addEventListener("change", (event) => {
      const target = event.target;
      saveState(!!target.checked);
    });

    els.pdfBtn?.addEventListener("click", () => {
      openPdfViewer();
    });
  }

  wireEvents();
  loadState();
})();
