const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadRomanizationService() {
  const servicePath = path.resolve(__dirname, "..", "services", "romanization-service.js");
  const source = fs.readFileSync(servicePath, "utf8");
  const context = { self: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: servicePath });

  const service = context.self && context.self.RomanizationService;
  if (!service) {
    throw new Error("RomanizationService failed to load");
  }
  return service;
}

function loadFixtures() {
  const fixturesDir = path.resolve(__dirname, "fixtures", "romanization");
  return fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const fullPath = path.join(fixturesDir, file);
      return {
        name: file,
        ...JSON.parse(fs.readFileSync(fullPath, "utf8")),
      };
    });
}

function runFixture(service, fixture) {
  if (fixture.mode === "translation") {
    const actual = service.parseTranslationResponse(fixture.input, fixture.targetLang);
    assert.strictEqual(
      actual.translatedText,
      fixture.expected.translatedText,
      `${fixture.name}: translatedText mismatch`,
    );
    assert.strictEqual(
      actual.romanized,
      fixture.expected.romanized,
      `${fixture.name}: romanized mismatch`,
    );
    return;
  }

  if (fixture.mode === "back_translation") {
    const actual = service.parseRomanizationFromBackTranslationResponse(fixture.input);
    assert.strictEqual(
      actual,
      fixture.expected.romanized,
      `${fixture.name}: back romanization mismatch`,
    );
    return;
  }

  throw new Error(`Unsupported fixture mode '${fixture.mode}' in ${fixture.name}`);
}

function runUsabilityAssertions(service) {
  assert.strictEqual(
    service.isRomanizationUsable("dubarah daryaft"),
    true,
    "Expected latin transliteration to be usable",
  );
  assert.strictEqual(service.isRomanizationUsable(""), false, "Expected empty text to be unusable");
  assert.strictEqual(
    service.isRomanizationUsable("۔۔"),
    false,
    "Expected non-latin-only text to be unusable",
  );
}

function main() {
  const service = loadRomanizationService();
  const fixtures = loadFixtures();

  let passed = 0;
  fixtures.forEach((fixture) => {
    runFixture(service, fixture);
    passed += 1;
  });

  runUsabilityAssertions(service);

  console.log(`Romanization parser tests passed (${passed} fixtures + usability checks).`);
}

main();
