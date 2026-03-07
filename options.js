(function () {
  const els = {
    spreadsheetId: document.getElementById("spreadsheet-id"),
    sheetName: document.getElementById("sheet-name"),
    simpleSheetName: document.getElementById("simple-sheet-name"),
    enabled: document.getElementById("enabled"),
    sheetOnlyMode: document.getElementById("sheet-only-mode"),
    saveBtn: document.getElementById("save-btn"),
    authBtn: document.getElementById("auth-btn"),
    syncBtn: document.getElementById("sync-btn"),
    status: document.getElementById("status"),
    oauthWarning: document.getElementById("oauth-warning"),
  };

  function getRuntime() {
    const c = globalThis.chrome;
    return c && c.runtime ? c.runtime : null;
  }

  function setStatus(message, isError) {
    if (!els.status) {
      return;
    }
    els.status.textContent = message || "";
    els.status.className = `status ${isError ? "error" : "ok"}`;
  }

  function setBusy(isBusy) {
    [els.saveBtn, els.authBtn, els.syncBtn].forEach((button) => {
      if (button) {
        button.disabled = !!isBusy;
      }
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      const runtime = getRuntime();
      if (!runtime || !runtime.id || typeof runtime.sendMessage !== "function") {
        resolve({ ok: false, error: "Extension runtime unavailable." });
        return;
      }

      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          resolve({ ok: false, error: runtime.lastError.message || "Message failed." });
          return;
        }
        resolve(response || { ok: false, error: "No response from background." });
      });
    });
  }

  function applyConfig(config) {
    if (!config) {
      return;
    }
    if (els.spreadsheetId) {
      els.spreadsheetId.value = config.spreadsheetId || "";
    }
    if (els.sheetName) {
      els.sheetName.value = config.sheetName || "TextBridge History";
    }
    if (els.simpleSheetName) {
      els.simpleSheetName.value = config.simpleSheetName || "TextBridge Quick";
    }
    if (els.enabled) {
      els.enabled.checked = config.enabled === true;
    }
    if (els.sheetOnlyMode) {
      els.sheetOnlyMode.checked = String(config.localHistoryMode || "hybrid") === "sheet_only";
    }
  }

  async function loadConfig() {
    const response = await sendMessage({ type: "SHEETS_GET_CONFIG" });
    if (!response?.ok) {
      setStatus(response?.error || "Could not load settings.", true);
      return;
    }
    applyConfig(response.config);
    setStatus("Settings loaded.", false);
  }

  function readForm() {
    return {
      spreadsheetId: (els.spreadsheetId?.value || "").trim(),
      sheetName: (els.sheetName?.value || "").trim(),
      simpleSheetName: (els.simpleSheetName?.value || "").trim(),
      enabled: !!els.enabled?.checked,
      localHistoryMode: els.sheetOnlyMode?.checked ? "sheet_only" : "hybrid",
    };
  }

  async function saveConfig() {
    const payload = readForm();
    if (payload.enabled && !payload.spreadsheetId) {
      setStatus("Spreadsheet ID is required when sync is enabled.", true);
      return;
    }

    setBusy(true);
    const response = await sendMessage({
      type: "SHEETS_SET_CONFIG",
      config: payload,
    });
    setBusy(false);

    if (!response?.ok) {
      setStatus(response?.error || "Could not save settings.", true);
      return;
    }

    applyConfig(response.config);
    setStatus("Settings saved.", false);
  }

  async function connectGoogle() {
    setBusy(true);
    const response = await sendMessage({ type: "SHEETS_AUTH" });
    setBusy(false);

    if (!response?.ok) {
      setStatus(response?.error || "Google connection failed.", true);
      return;
    }
    setStatus("Google account connected.", false);
  }

  async function syncNow() {
    const payload = readForm();
    if (!payload.spreadsheetId) {
      setStatus("Set spreadsheet ID first.", true);
      return;
    }

    setBusy(true);
    await sendMessage({
      type: "SHEETS_SET_CONFIG",
      config: payload,
    });

    const response = await sendMessage({ type: "SHEETS_SYNC_NOW" });
    setBusy(false);

    if (!response?.ok) {
      const reason = response?.reason ? ` (${response.reason})` : "";
      setStatus((response?.error || "Manual sync failed.") + reason, true);
      return;
    }

    const detailedCount = Number(response.appended || 0);
    const quickCount = Number(response.quickAppended || 0);
    setStatus(
      `History synced. Detailed rows: ${detailedCount}, Quick rows: ${quickCount}.`,
      false,
    );
  }

  function checkManifestOAuthClient() {
    try {
      const manifest = getRuntime()?.getManifest?.() || {};
      const clientId = manifest?.oauth2?.client_id || "";
      const isPlaceholder = String(clientId).includes("REPLACE_WITH_EXTENSION_OAUTH_CLIENT_ID");
      if (els.oauthWarning) {
        els.oauthWarning.style.display = isPlaceholder ? "block" : "none";
      }
    } catch (_) {
      // ignore
    }
  }

  function wireEvents() {
    els.saveBtn?.addEventListener("click", saveConfig);
    els.authBtn?.addEventListener("click", connectGoogle);
    els.syncBtn?.addEventListener("click", syncNow);
  }

  checkManifestOAuthClient();
  wireEvents();
  loadConfig();
})();
