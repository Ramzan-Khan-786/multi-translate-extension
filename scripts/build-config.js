#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const MANIFEST_TEMPLATE_PATH = path.join(ROOT_DIR, "manifest.template.json");
const MANIFEST_OUTPUT_PATH = path.join(ROOT_DIR, "manifest.json");
const RUNTIME_CONFIG_OUTPUT_PATH = path.join(ROOT_DIR, "services", "runtime-config.js");

const DEFAULTS = {
  GOOGLE_TRANSLATE_API_BASE: "https://translate.googleapis.com",
  GOOGLE_TRANSLATE_WEB_BASE: "https://translate.google.com",
  DICTIONARY_API_BASE: "https://api.dictionaryapi.dev",
  GOOGLE_SHEETS_API_BASE: "https://sheets.googleapis.com",
  GOOGLE_AUTH_URI: "https://accounts.google.com/o/oauth2/auth",
  GOOGLE_TOKEN_URI: "https://oauth2.googleapis.com/token",
  GOOGLE_AUTH_PROVIDER_CERT_URL: "https://www.googleapis.com/oauth2/v1/certs",
  GOOGLE_SHEETS_SCOPE: "https://www.googleapis.com/auth/spreadsheets",
};

function normalizeNewlines(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function stripInlineComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
      if (!quote) {
        quote = char;
      } else if (quote === char) {
        quote = "";
      }
      continue;
    }

    if (char === "#" && !quote) {
      return value.slice(0, i).trim();
    }
  }

  return value.trim();
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(source) {
  const output = {};
  const lines = normalizeNewlines(source).split("\n");

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1);
    if (!key) {
      return;
    }

    output[key] = unquote(stripInlineComment(rawValue));
  });

  return output;
}

function readEnvVars() {
  const fileVars = fs.existsSync(ENV_PATH)
    ? parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"))
    : {};
  return {
    ...fileVars,
    ...process.env,
  };
}

function normalizeHttpsUrl(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${name} is required.`);
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }

  return text.replace(/\/+$/, "");
}

function normalizeOauthClientId(value) {
  const clientId = String(value || "").trim();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is required.");
  }
  if (!/^[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId)) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID looks invalid. Expected *.apps.googleusercontent.com",
    );
  }
  return clientId;
}

function normalizeSheetsScope(value) {
  const scope = normalizeHttpsUrl(value, "GOOGLE_SHEETS_SCOPE");
  if (!scope.includes("spreadsheets")) {
    throw new Error("GOOGLE_SHEETS_SCOPE must be a Google Sheets scope URL.");
  }
  return scope;
}

function toHostPermission(baseUrl) {
  const parsed = new URL(baseUrl);
  return `${parsed.origin}/*`;
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : []).filter(
        (item) => typeof item === "string" && item.trim(),
      ),
    ),
  );
}

function ensureTemplateManifest() {
  if (!fs.existsSync(MANIFEST_TEMPLATE_PATH)) {
    throw new Error(
      "manifest.template.json not found. Add it and re-run the build.",
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_TEMPLATE_PATH, "utf8"));
}

function buildRuntimeSettings(env) {
  const oauth = {
    clientId: normalizeOauthClientId(env.GOOGLE_OAUTH_CLIENT_ID),
    projectId: String(env.GOOGLE_OAUTH_PROJECT_ID || "").trim(),
    authUri: normalizeHttpsUrl(env.GOOGLE_AUTH_URI || DEFAULTS.GOOGLE_AUTH_URI, "GOOGLE_AUTH_URI"),
    tokenUri: normalizeHttpsUrl(
      env.GOOGLE_TOKEN_URI || DEFAULTS.GOOGLE_TOKEN_URI,
      "GOOGLE_TOKEN_URI",
    ),
    authProviderCertUrl: normalizeHttpsUrl(
      env.GOOGLE_AUTH_PROVIDER_CERT_URL || DEFAULTS.GOOGLE_AUTH_PROVIDER_CERT_URL,
      "GOOGLE_AUTH_PROVIDER_CERT_URL",
    ),
    sheetsScope: normalizeSheetsScope(env.GOOGLE_SHEETS_SCOPE || DEFAULTS.GOOGLE_SHEETS_SCOPE),
  };

  const endpoints = {
    translateApiBase: normalizeHttpsUrl(
      env.GOOGLE_TRANSLATE_API_BASE || DEFAULTS.GOOGLE_TRANSLATE_API_BASE,
      "GOOGLE_TRANSLATE_API_BASE",
    ),
    translateWebBase: normalizeHttpsUrl(
      env.GOOGLE_TRANSLATE_WEB_BASE || DEFAULTS.GOOGLE_TRANSLATE_WEB_BASE,
      "GOOGLE_TRANSLATE_WEB_BASE",
    ),
    dictionaryApiBase: normalizeHttpsUrl(
      env.DICTIONARY_API_BASE || DEFAULTS.DICTIONARY_API_BASE,
      "DICTIONARY_API_BASE",
    ),
    sheetsApiBase: normalizeHttpsUrl(
      env.GOOGLE_SHEETS_API_BASE || DEFAULTS.GOOGLE_SHEETS_API_BASE,
      "GOOGLE_SHEETS_API_BASE",
    ),
  };

  return {
    oauth,
    endpoints,
    security: {
      requireHttps: true,
    },
  };
}

function buildManifest(templateManifest, runtimeSettings) {
  const templateHostPermissions = Array.isArray(templateManifest.host_permissions)
    ? templateManifest.host_permissions
    : [];

  const generatedHostPermissions = [
    "<all_urls>",
    toHostPermission(runtimeSettings.endpoints.translateApiBase),
    toHostPermission(runtimeSettings.endpoints.translateWebBase),
    toHostPermission(runtimeSettings.endpoints.dictionaryApiBase),
    toHostPermission(runtimeSettings.endpoints.sheetsApiBase),
  ];

  return {
    ...templateManifest,
    host_permissions: uniqueStrings([
      ...templateHostPermissions,
      ...generatedHostPermissions,
    ]),
    oauth2: {
      ...(templateManifest.oauth2 || {}),
      client_id: runtimeSettings.oauth.clientId,
      scopes: [runtimeSettings.oauth.sheetsScope],
    },
  };
}

function buildRuntimeConfigSource(runtimeSettings) {
  const json = JSON.stringify(runtimeSettings, null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return [
    "/**",
    " * Auto-generated by scripts/build-config.js",
    " * Do not edit manually.",
    " */",
    "(function (global) {",
    "  global.TextBridgeRuntimeConfig = Object.freeze(",
    `${json}`,
    "  );",
    "})(self);",
    "",
  ].join("\n");
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeOutputs(manifest, runtimeConfigSource) {
  fs.writeFileSync(
    MANIFEST_OUTPUT_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(RUNTIME_CONFIG_OUTPUT_PATH, runtimeConfigSource, "utf8");
}

function runCheck(manifest, runtimeConfigSource) {
  const expectedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const currentManifest = readFileIfExists(MANIFEST_OUTPUT_PATH);
  const currentRuntimeConfig = readFileIfExists(RUNTIME_CONFIG_OUTPUT_PATH);

  let hasError = false;
  if (normalizeNewlines(currentManifest) !== normalizeNewlines(expectedManifest)) {
    console.error("manifest.json is out of date. Run: npm run build:config");
    hasError = true;
  }
  if (normalizeNewlines(currentRuntimeConfig) !== normalizeNewlines(runtimeConfigSource)) {
    console.error("services/runtime-config.js is out of date. Run: npm run build:config");
    hasError = true;
  }

  if (hasError) {
    process.exit(1);
  }

  console.log("Config check passed.");
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");

  const envExists = fs.existsSync(ENV_PATH);
  const hasProcessClientId = typeof process.env.GOOGLE_OAUTH_CLIENT_ID === "string";
  if (!envExists && !hasProcessClientId) {
    throw new Error("Missing .env. Create it from .env.example before building.");
  }

  const env = readEnvVars();
  const runtimeSettings = buildRuntimeSettings(env);
  const templateManifest = ensureTemplateManifest();
  const manifest = buildManifest(templateManifest, runtimeSettings);
  const runtimeConfigSource = buildRuntimeConfigSource(runtimeSettings);

  if (checkOnly) {
    runCheck(manifest, runtimeConfigSource);
    return;
  }

  writeOutputs(manifest, runtimeConfigSource);
  console.log("Generated manifest.json and services/runtime-config.js from environment config.");
}

try {
  main();
} catch (error) {
  const message = error && error.message ? error.message : "Unknown error";
  console.error(`build-config failed: ${message}`);
  process.exit(1);
}
