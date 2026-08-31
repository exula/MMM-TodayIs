const assert = require("assert");
const Module = require("module");

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
    busy: false,
    cacheFile: date => `missing-${date}`,
    buildDay: async (...args) => calls.push(args)
  };
  await helper.prefetchTomorrow.call(context, "2026-08-31");
  assert.deepStrictEqual(calls, [["2026-09-01", false, { notify: false }]]);
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

async function run() {
  await testPrefetchIsSilent();
  testFallbackUsesSpecificImageQuery();
  testFallbackCaptionIsStable();
  testEmojiCanBeDisabled();
  await testCommonsImageFiltering();
  console.log("PASS  behavioral tests");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
