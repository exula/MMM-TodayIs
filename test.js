const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const originalLoad = Module._load;
Module._load = function mockNodeHelper(request, parent, isMain) {
  if (request === "node_helper") return { create: definition => definition };
  return originalLoad.call(this, request, parent, isMain);
};
const helper = require("./node_helper");
Module._load = originalLoad;

async function testPrefetchIsSilent() {
  const calls = [];
  const context = {
    builds: new Map(),
    cacheFile: date => `missing-${date}`,
    buildDay: async (...args) => calls.push(args)
  };
  await helper.prefetchTomorrow.call(context, "2026-08-31");
  assert.deepStrictEqual(calls, [["2026-09-01", false, { notify: false }]]);
}

async function testCandidateDiagnosticsAndPolicy() {
  const context = {
    config: {
      sources: { publicHolidays: false, wikipedia: true, nationalDaysPage: false, funHolidays: false, localList: true },
      content: { excludePolitics: true, excludeTragedy: true, excludeDeaths: true, includeBirthdays: false, familyFriendly: true, preferredCategories: ["food"] }
    },
    log() {},
    fetchWikipedia: async () => [
      { type: "history", title: "A tragic battle killed many people", source: "Wikipedia", score: 90 },
      { type: "history", title: "A telescope discovered a comet", source: "Wikipedia", score: 55 }
    ],
    fetchLocalList: async () => [{ type: "observance", title: "National Trail Mix Day", source: "local", score: 88 }]
  };
  const result = await helper.collectCandidates.call(context, "2026-08-31");
  assert.strictEqual(result.candidates.some(item => /tragic battle/i.test(item.title)), false);
  assert.strictEqual(result.candidates[0].title, "National Trail Mix Day");
  assert.strictEqual(result.diagnostics.find(item => item.source === "Wikipedia").status, "ok");
  assert.strictEqual(result.diagnostics.find(item => item.source === "Nager.Date").status, "disabled");
}

async function testBuildCreatesVersionedDay() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-todayis-test-"));
  const notifications = [];
  const context = {
    config: { ai: { enabled: false }, fallback: { enabled: true, useEmoji: true }, sources: { images: false }, content: {}, maxEvents: 2 },
    collectCandidates: async () => ({ candidates: [
      { type: "observance", title: "National Trail Mix Day", source: "local", score: 100, finalScore: 100, category: "food" },
      { type: "history", title: "A telescope discovered a comet", source: "Wikipedia", score: 55, finalScore: 55, category: "science" }
    ], diagnostics: [{ source: "fixture", status: "ok", count: 2, durationMs: 1 }] }),
    createFallbackPlacard: helper.createFallbackPlacard,
    cacheFile: date => path.join(directory, `${date}.json`),
    pruneCache() {},
    sendSocketNotification: (...args) => notifications.push(args),
    log() {}
  };
  try {
    const day = await helper.performBuildDay.call(context, "2026-08-31", false, { notify: true });
    assert.strictEqual(day.schemaVersion, 2);
    assert.strictEqual(day.placards.length, 2);
    assert.strictEqual(notifications[0][0], "DAY");
    assert.strictEqual(JSON.parse(fs.readFileSync(context.cacheFile("2026-08-31"), "utf8")).schemaVersion, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testConcurrentBuildsAreShared() {
  let count = 0;
  const context = {
    builds: new Map(),
    performBuildDay: async () => { count += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { date: "2026-08-31" }; }
  };
  const first = helper.buildDay.call(context, "2026-08-31", false);
  const second = helper.buildDay.call(context, "2026-08-31", true);
  assert.strictEqual(first, second);
  await first;
  assert.strictEqual(count, 1);
  assert.strictEqual(context.builds.size, 0);
}

function testFallbackUsesSpecificImageQuery() {
  const placard = helper.createFallbackPlacard.call({
    config: { fallback: { useEmoji: true } }
  }, "2026-08-31", [{
    type: "observance",
    title: "National Trail Mix Day",
    description: "A snack observance",
    source: "local",
    score: 88
  }]);
  assert.match(placard.imageQuery, /trail mix/i);
  assert.notStrictEqual(placard.imageQuery, "delicious food");
}

function testFallbackCaptionIsStable() {
  const context = { config: { fallback: { useEmoji: true } } };
  const candidates = [{ type: "observance", title: "National Trail Mix Day", source: "local", score: 88 }];
  const first = helper.createFallbackPlacard.call(context, "2026-08-31", candidates);
  const second = helper.createFallbackPlacard.call(context, "2026-08-31", candidates);
  assert.strictEqual(first.caption, second.caption);
}

function testEmojiCanBeDisabled() {
  const placard = helper.createFallbackPlacard.call({
    config: { fallback: { useEmoji: false } }
  }, "2026-08-31", [{ type: "observance", title: "National Trail Mix Day", source: "local", score: 88 }]);
  assert.strictEqual(placard.emoji, "");
}

async function testCommonsImageFiltering() {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ query: { pages: {
      1: { index: 1, title: "File:Trail Mix logo.png", imageinfo: [{ mime: "image/png", width: 2000, height: 1000, url: "logo", extmetadata: {} }] },
      2: { index: 2, title: "File:Trail Mix portrait.jpg", imageinfo: [{ mime: "image/jpeg", width: 1000, height: 1600, url: "portrait", extmetadata: {} }] },
      3: { index: 3, title: "File:Trail Mix bowl.jpg", imageinfo: [{ mime: "image/jpeg", width: 2000, height: 1200, url: "wide", extmetadata: { LicenseShortName: { value: "CC0" } } }] }
    } } })
  });
  try {
    const image = await helper.findCommonsImage.call({}, "Trail Mix");
    assert.strictEqual(image.url, "wide");
    assert.match(image.attribution, /CC0/);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testNationalDaysDateSection() {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<p><br>Monday Aug 31, 2026</p><p><a href="https://example.test/trail-mix">National Trail Mix Day</a><br><a href="https://example.test/cats">Ginger Cat Appreciation Day</a></p><p><br>Tuesday Sep 1, 2026</p><p><a href="https://example.test/next">Tomorrow Day</a></p>'
  });
  try {
    const items = await helper.fetchNationalDaysPage.call({ config: { timezone: "America/New_York" } }, "2026-08-31");
    assert.deepStrictEqual(items.map(item => item.title), ["National Trail Mix Day", "Ginger Cat Appreciation Day"]);
    assert.strictEqual(items[0].sourceUrl, "https://example.test/trail-mix");
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await testPrefetchIsSilent();
  testFallbackUsesSpecificImageQuery();
  testFallbackCaptionIsStable();
  testEmojiCanBeDisabled();
  await testCommonsImageFiltering();
  await testNationalDaysDateSection();
  await testCandidateDiagnosticsAndPolicy();
  await testBuildCreatesVersionedDay();
  await testConcurrentBuildsAreShared();
  console.log("PASS  behavioral tests");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
