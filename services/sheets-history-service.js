(function (global) {
  const CONFIG_KEYS = {
    enabled: "sheets_sync_enabled",
    spreadsheetId: "sheets_spreadsheet_id",
    sheetName: "sheets_sheet_name",
    simpleSheetName: "sheets_simple_sheet_name",
    localHistoryMode: "sheets_local_history_mode",
  };

  const DEFAULT_CONFIG = {
    enabled: false,
    spreadsheetId: "",
    sheetName: "TextBridge History",
    simpleSheetName: "TextBridge Quick",
    localHistoryMode: "hybrid",
  };

  const HISTORY_HEADERS = ["word", "definition", "ur", "hi", "timestamp", "url"];
  const QUICK_HEADERS = ["En", "Ur", "Hi"];
  const RUNTIME_ENDPOINTS = global.TextBridgeRuntimeConfig?.endpoints || {};
  const SHEETS_BASE_URL = normalizeSheetsBaseUrl(RUNTIME_ENDPOINTS.sheetsApiBase);
  const READY_SHEET_CACHE = new Set();
  let writeQueue = Promise.resolve();

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

  function normalizeSheetsBaseUrl(value) {
    const base = normalizeBaseUrl(value, "https://sheets.googleapis.com");
    if (/\/v4\/spreadsheets$/i.test(base)) {
      return base;
    }
    return `${base}/v4/spreadsheets`;
  }

  function normalizeSheetName(value, fallbackName = DEFAULT_CONFIG.sheetName) {
    const text = String(value || "").trim();
    return text || fallbackName;
  }

  function normalizeLocalHistoryMode(value) {
    return String(value || "").toLowerCase() === "sheet_only" ? "sheet_only" : "hybrid";
  }

  function normalizeSpreadsheetId(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return text;
  }

  function toBoolean(value) {
    return value === true;
  }

  function getStorage() {
    const c = global.chrome;
    if (!c || !c.storage || !c.storage.local) {
      return null;
    }
    return c.storage.local;
  }

  function getIdentity() {
    const c = global.chrome;
    if (!c || !c.identity) {
      return null;
    }
    return c.identity;
  }

  function getRuntime() {
    const c = global.chrome;
    return c && c.runtime ? c.runtime : null;
  }

  async function readConfig() {
    const storage = getStorage();
    if (!storage) {
      return { ...DEFAULT_CONFIG };
    }

    try {
      const raw = await storage.get([
        CONFIG_KEYS.enabled,
        CONFIG_KEYS.spreadsheetId,
        CONFIG_KEYS.sheetName,
        CONFIG_KEYS.simpleSheetName,
        CONFIG_KEYS.localHistoryMode,
      ]);

      return {
        enabled: toBoolean(raw[CONFIG_KEYS.enabled]),
        spreadsheetId: normalizeSpreadsheetId(raw[CONFIG_KEYS.spreadsheetId] || ""),
        sheetName: normalizeSheetName(
          raw[CONFIG_KEYS.sheetName] || DEFAULT_CONFIG.sheetName,
          DEFAULT_CONFIG.sheetName,
        ),
        simpleSheetName: normalizeSheetName(
          raw[CONFIG_KEYS.simpleSheetName] || DEFAULT_CONFIG.simpleSheetName,
          DEFAULT_CONFIG.simpleSheetName,
        ),
        localHistoryMode: normalizeLocalHistoryMode(raw[CONFIG_KEYS.localHistoryMode]),
      };
    } catch (_) {
      return { ...DEFAULT_CONFIG };
    }
  }

  async function writeConfig(partialConfig) {
    const storage = getStorage();
    if (!storage) {
      return readConfig();
    }

    const current = await readConfig();
    const next = {
      enabled:
        typeof partialConfig?.enabled === "boolean" ? partialConfig.enabled : current.enabled,
      spreadsheetId:
        typeof partialConfig?.spreadsheetId === "string"
          ? normalizeSpreadsheetId(partialConfig.spreadsheetId)
          : current.spreadsheetId,
      sheetName:
        typeof partialConfig?.sheetName === "string"
          ? normalizeSheetName(partialConfig.sheetName, DEFAULT_CONFIG.sheetName)
          : current.sheetName,
      simpleSheetName:
        typeof partialConfig?.simpleSheetName === "string"
          ? normalizeSheetName(partialConfig.simpleSheetName, DEFAULT_CONFIG.simpleSheetName)
          : current.simpleSheetName,
      localHistoryMode:
        typeof partialConfig?.localHistoryMode === "string"
          ? normalizeLocalHistoryMode(partialConfig.localHistoryMode)
          : current.localHistoryMode,
    };

    try {
      await storage.set({
        [CONFIG_KEYS.enabled]: next.enabled,
        [CONFIG_KEYS.spreadsheetId]: next.spreadsheetId,
        [CONFIG_KEYS.sheetName]: next.sheetName,
        [CONFIG_KEYS.simpleSheetName]: next.simpleSheetName,
        [CONFIG_KEYS.localHistoryMode]: next.localHistoryMode,
      });
    } catch (_) {
      // ignore storage write errors
    }

    return next;
  }

  function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
      const identity = getIdentity();
      if (!identity || typeof identity.getAuthToken !== "function") {
        reject(new Error("Chrome identity API is unavailable."));
        return;
      }

      try {
        identity.getAuthToken({ interactive: !!interactive }, (token) => {
          const runtime = getRuntime();
          const err = runtime && runtime.lastError ? runtime.lastError.message : "";
          if (err || !token) {
            reject(new Error(err || "Could not retrieve Google auth token."));
            return;
          }
          resolve(token);
        });
      } catch (_) {
        reject(new Error("Failed to request Google auth token."));
      }
    });
  }

  function removeCachedAuthToken(token) {
    return new Promise((resolve) => {
      const identity = getIdentity();
      if (!identity || typeof identity.removeCachedAuthToken !== "function" || !token) {
        resolve();
        return;
      }

      try {
        identity.removeCachedAuthToken({ token }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function toA1Range(sheetName, cellRange) {
    const escapedSheetName = normalizeSheetName(sheetName).replace(/'/g, "''");
    return `'${escapedSheetName}'!${cellRange}`;
  }

  function toColumnLabel(columnCount) {
    let value = Number(columnCount || 0);
    if (!Number.isFinite(value) || value <= 0) {
      return "A";
    }

    let label = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      value = Math.floor((value - 1) / 26);
    }
    return label;
  }

  async function sheetsRequest(spreadsheetId, path, method, token, body) {
    const url = `${SHEETS_BASE_URL}/${encodeURIComponent(spreadsheetId)}${path}`;
    const response = await fetch(url, {
      method: method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      url,
    };
  }

  async function authorizedSheetsRequest(requestFactory, interactive) {
    const firstToken = await getAuthToken(interactive);
    let result = await requestFactory(firstToken);

    if (result.status === 401 || result.status === 403) {
      await removeCachedAuthToken(firstToken);
      const secondToken = await getAuthToken(interactive);
      result = await requestFactory(secondToken);
    }

    return result;
  }

  function getSheetReadyKey(spreadsheetId, sheetName) {
    return `${spreadsheetId}::${normalizeSheetName(sheetName).toLowerCase()}`;
  }

  async function ensureSheetExists(spreadsheetId, sheetName, headers, interactive) {
    const key = getSheetReadyKey(spreadsheetId, sheetName);
    if (READY_SHEET_CACHE.has(key)) {
      return { ok: true };
    }

    const metadata = await authorizedSheetsRequest(
      (token) =>
        sheetsRequest(
          spreadsheetId,
          "?fields=sheets.properties.title",
          "GET",
          token,
        ),
      interactive,
    );

    if (!metadata.ok) {
      return {
        ok: false,
        error: "Could not read spreadsheet metadata.",
        status: metadata.status,
      };
    }

    const exists = (metadata.data?.sheets || []).some((sheet) => {
      const title = sheet?.properties?.title || "";
      return title === normalizeSheetName(sheetName);
    });

    if (!exists) {
      const addSheetResult = await authorizedSheetsRequest(
        (token) =>
          sheetsRequest(
            spreadsheetId,
            ":batchUpdate",
            "POST",
            token,
            {
              requests: [{ addSheet: { properties: { title: normalizeSheetName(sheetName) } } }],
            },
          ),
        interactive,
      );

      if (!addSheetResult.ok) {
        return {
          ok: false,
          error: "Could not create target sheet tab.",
          status: addSheetResult.status,
        };
      }
    }

    const headerEnd = toColumnLabel((headers || []).length);
    const headerRange = encodeURIComponent(toA1Range(sheetName, `A1:${headerEnd}1`));
    const headerRead = await authorizedSheetsRequest(
      (token) =>
        sheetsRequest(
          spreadsheetId,
          `/values/${headerRange}`,
          "GET",
          token,
        ),
      interactive,
    );

    if (!headerRead.ok) {
      return {
        ok: false,
        error: "Could not validate header row.",
        status: headerRead.status,
      };
    }

    const currentHeader = Array.isArray(headerRead.data?.values?.[0]) ? headerRead.data.values[0] : [];
    const shouldSetHeader =
      currentHeader.length === 0 ||
      (headers || []).some((header, index) => String(currentHeader[index] || "").trim() !== header);

    if (shouldSetHeader) {
      const headerWrite = await authorizedSheetsRequest(
        (token) =>
          sheetsRequest(
            spreadsheetId,
            `/values/${headerRange}?valueInputOption=RAW`,
            "PUT",
            token,
            { values: [headers || []] },
          ),
        interactive,
      );

      if (!headerWrite.ok) {
        return {
          ok: false,
          error: "Could not write header row.",
          status: headerWrite.status,
        };
      }
    }

    READY_SHEET_CACHE.add(key);
    return { ok: true };
  }

  function entryToRow(entry) {
    const timestamp = Number(entry?.timestamp || 0);
    return [
      String(entry?.word || "").trim(),
      String(entry?.definition || "").trim(),
      String(entry?.ur || "").trim(),
      String(entry?.hi || "").trim(),
      timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString(),
      String(entry?.url || "").trim(),
    ];
  }

  function entryToSimpleRow(entry) {
    return [
      String(entry?.word || "").trim(),
      String(entry?.ur || "").trim(),
      String(entry?.hi || "").trim(),
    ];
  }

  function buildRowKey(row) {
    return [
      String(row?.[0] || "").trim().toLowerCase(),
      String(row?.[4] || "").trim(),
      String(row?.[5] || "").trim(),
    ].join("::");
  }

  function buildSimpleRowKey(row) {
    return String(row?.[0] || "").trim().toLowerCase();
  }

  async function fetchExistingRowKeys(
    spreadsheetId,
    sheetName,
    columnCount,
    keyBuilder,
    interactive,
  ) {
    const rangeEnd = toColumnLabel(columnCount);
    const range = encodeURIComponent(toA1Range(sheetName, `A2:${rangeEnd}`));
    const result = await authorizedSheetsRequest(
      (token) =>
        sheetsRequest(
          spreadsheetId,
          `/values/${range}`,
          "GET",
          token,
        ),
      interactive,
    );

    if (!result.ok) {
      return { ok: false, keys: new Set(), status: result.status };
    }

    const values = Array.isArray(result.data?.values) ? result.data.values : [];
    const builder = typeof keyBuilder === "function" ? keyBuilder : () => "";
    const keys = new Set(values.map((row) => builder(row)).filter(Boolean));
    return { ok: true, keys };
  }

  async function appendRows(spreadsheetId, sheetName, rows, columnCount, interactive) {
    const normalizedRows = (rows || []).filter((row) => Array.isArray(row) && row[0]);
    if (normalizedRows.length === 0) {
      return { ok: true, appended: 0 };
    }

    const rangeEnd = toColumnLabel(columnCount);
    const range = encodeURIComponent(toA1Range(sheetName, `A:${rangeEnd}`));
    const result = await authorizedSheetsRequest(
      (token) =>
        sheetsRequest(
          spreadsheetId,
          `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          "POST",
          token,
          { majorDimension: "ROWS", values: normalizedRows },
        ),
      interactive,
    );

    if (!result.ok) {
      return {
        ok: false,
        error: "Could not append rows to Google Sheets.",
        status: result.status,
      };
    }

    return { ok: true, appended: normalizedRows.length };
  }

  async function syncSingleEntry(entry, interactive) {
    const config = await readConfig();
    if (!config.enabled) {
      return { ok: false, reason: "disabled" };
    }
    if (!config.spreadsheetId) {
      return { ok: false, reason: "missing_spreadsheet_id" };
    }

    const detailedReady = await ensureSheetExists(
      config.spreadsheetId,
      config.sheetName,
      HISTORY_HEADERS,
      interactive,
    );
    if (!detailedReady.ok) {
      return detailedReady;
    }

    const detailedAppend = await appendRows(
      config.spreadsheetId,
      config.sheetName,
      [entryToRow(entry)],
      HISTORY_HEADERS.length,
      interactive,
    );
    if (!detailedAppend.ok) {
      READY_SHEET_CACHE.delete(getSheetReadyKey(config.spreadsheetId, config.sheetName));
      return detailedAppend;
    }

    const quickReady = await ensureSheetExists(
      config.spreadsheetId,
      config.simpleSheetName,
      QUICK_HEADERS,
      interactive,
    );
    if (!quickReady.ok) {
      return quickReady;
    }

    const quickAppend = await appendRows(
      config.spreadsheetId,
      config.simpleSheetName,
      [entryToSimpleRow(entry)],
      QUICK_HEADERS.length,
      interactive,
    );
    if (!quickAppend.ok) {
      READY_SHEET_CACHE.delete(getSheetReadyKey(config.spreadsheetId, config.simpleSheetName));
    }

    return {
      ok: !!(detailedAppend.ok && quickAppend.ok),
      appended: detailedAppend.appended || 0,
      quickAppended: quickAppend.appended || 0,
      error: detailedAppend.error || quickAppend.error || "",
    };
  }

  function enqueueEntry(entry) {
    writeQueue = writeQueue
      .then(() => syncSingleEntry(entry, false))
      .catch(() => ({ ok: false }));
    return writeQueue;
  }

  async function syncAllEntries(entries, interactive) {
    const config = await readConfig();
    if (!config.enabled) {
      return { ok: false, reason: "disabled", appended: 0 };
    }
    if (!config.spreadsheetId) {
      return { ok: false, reason: "missing_spreadsheet_id", appended: 0 };
    }

    const detailedReady = await ensureSheetExists(
      config.spreadsheetId,
      config.sheetName,
      HISTORY_HEADERS,
      interactive,
    );
    if (!detailedReady.ok) {
      return { ...detailedReady, appended: 0, quickAppended: 0 };
    }

    const quickReady = await ensureSheetExists(
      config.spreadsheetId,
      config.simpleSheetName,
      QUICK_HEADERS,
      interactive,
    );
    if (!quickReady.ok) {
      return { ...quickReady, appended: 0, quickAppended: 0 };
    }

    const allRows = (Array.isArray(entries) ? entries : [])
      .slice()
      .reverse()
      .map((entry) => entryToRow(entry));
    const allSimpleRows = (Array.isArray(entries) ? entries : [])
      .slice()
      .reverse()
      .map((entry) => entryToSimpleRow(entry));

    const existingDetailed = await fetchExistingRowKeys(
      config.spreadsheetId,
      config.sheetName,
      HISTORY_HEADERS.length,
      buildRowKey,
      interactive,
    );
    if (!existingDetailed.ok) {
      return {
        ok: false,
        appended: 0,
        quickAppended: 0,
        error: "Could not read existing detailed sheet rows.",
      };
    }

    const existingQuick = await fetchExistingRowKeys(
      config.spreadsheetId,
      config.simpleSheetName,
      QUICK_HEADERS.length,
      buildSimpleRowKey,
      interactive,
    );
    if (!existingQuick.ok) {
      return {
        ok: false,
        appended: 0,
        quickAppended: 0,
        error: "Could not read existing quick sheet rows.",
      };
    }

    const rows = allRows.filter((row) => !existingDetailed.keys.has(buildRowKey(row)));
    const quickRows = allSimpleRows.filter((row) => !existingQuick.keys.has(buildSimpleRowKey(row)));
    const detailedAppend = await appendRows(
      config.spreadsheetId,
      config.sheetName,
      rows,
      HISTORY_HEADERS.length,
      interactive,
    );
    const quickAppend = await appendRows(
      config.spreadsheetId,
      config.simpleSheetName,
      quickRows,
      QUICK_HEADERS.length,
      interactive,
    );
    return {
      ok: !!(detailedAppend.ok && quickAppend.ok),
      appended: detailedAppend.appended || 0,
      quickAppended: quickAppend.appended || 0,
      reason: detailedAppend.reason || quickAppend.reason || "",
      error: detailedAppend.error || quickAppend.error || "",
    };
  }

  async function authorize(interactive) {
    try {
      await getAuthToken(interactive);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : "Authorization failed." };
    }
  }

  global.SheetsHistoryService = {
    getConfig: readConfig,
    setConfig: writeConfig,
    enqueueEntry,
    syncSingleEntry,
    syncAllEntries,
    authorize,
    constants: {
      CONFIG_KEYS,
      DEFAULT_CONFIG,
    },
  };
})(self);
