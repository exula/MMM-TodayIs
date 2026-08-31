# MMM-TodayIs

A hands-off MagicMirror² module that answers one question every day:

> **Today is... what?**

It dynamically gathers public holidays, historical events, and fun observances, then creates a polished poster. OpenAI is optional enrichment, not a dependency: if the API is unavailable or disabled, the module creates a local fallback placard from the same live sources.

## Features

- No holiday database to maintain.
- No image library to maintain.
- OpenAI Responses API enrichment with optional web search.
- Non-LLM fallback mode that works without an OpenAI key.
- Nager.Date public holiday source.
- Wikipedia On This Day source.
- Public List of National Days page as a supplemental observance source.
- Bundled month/day observances as a reliable baseline when live sources are unavailable.
- Wikimedia Commons image discovery and local caching.
- AI-generated copy/art direction rendered by deterministic CSS.
- Multiple built-in visual styles.
- Multi-card daily rotation with manual navigation and pause/resume notifications.
- Responsive typography and a designed no-image fallback.
- Source health diagnostics, provenance links, and explainable candidate scoring.
- Content policy controls for family-friendly displays.
- A standalone browser preview for theme and layout development.
- Automatic migration of legacy single-placard cache files.
- Caches today's result and optionally prefetches tomorrow.
- Graceful degradation when any upstream source fails.
- No npm runtime dependencies; Node 18+ built-ins only.

## Install

```bash
cd ~/MagicMirror/modules
unzip MMM-TodayIs.zip
cd MMM-TodayIs
npm run validate
```

No `npm install` is required.

## Configuration

Add to `config/config.js`:

```javascript
{
  module: "MMM-TodayIs",
  position: "middle_center",
  config: {
    countryCode: "US",
    timezone: "America/New_York",
    updateHour: 5,
    updateMinute: 30,
    cacheDays: 14,
    prefetchTomorrow: true,
    maxEvents: 4,
    rotationInterval: 15 * 60 * 1000,
    locale: "en-US",
    showSource: true,
    theme: "auto",

    ai: {
      enabled: true,
      model: "gpt-5.6-luna",
      webSearch: true
    },

    sources: {
      publicHolidays: true,
      wikipedia: true,
      nationalDaysPage: true,
      funHolidays: true,
      localList: true,
      images: true
    },

    fallback: {
      enabled: true,
      useEmoji: true
    },

    content: {
      excludePolitics: true,
      excludeTragedy: true,
      excludeDeaths: true,
      includeBirthdays: false,
      familyFriendly: true,
      preferredCategories: ["food", "animal", "science", "nature", "music", "books", "celebration"]
    },

    labels: {
      todayIs: "TODAY IS",
      onThisDay: "ON THIS DAY",
      loading: "Finding something interesting about today…",
      error: "Unable to load today's placard."
    },

    width: 900,
    height: 520,
    refreshCheckInterval: 60000,
    transitionDuration: 1000,
    debug: false
  }
}
```

`theme` can be `auto`, `modern`, `minimal`, `retro`, `history`, `celebration`, `science`, `food`, or `animal`. In `auto` mode each placard chooses a style from its content category. Set `rotationInterval` below `10000` to disable automatic rotation; manual navigation remains available.

The default OpenAI model is `gpt-5.6-luna`, an OpenAI API model optimized for cost-sensitive workloads. The model is used only for editorial selection/copy/art direction; it does not generate HTML or CSS.

## OpenAI secret

The API key belongs on the Node side. Do **not** put it in `config.js`.

```bash
export OPENAI_API_KEY="sk-..."
```

When MagicMirror is launched by PM2 or systemd, make sure the service receives the variable. The browser-side module never receives the key.

If `OPENAI_API_KEY` is missing, `ai.enabled` is true, or the OpenAI request fails, MMM-TodayIs automatically switches to the local fallback.

To run permanently without OpenAI:

```javascript
ai: {
  enabled: false
}
```

## Fallback mode

Fallback selection is deliberately deterministic in architecture, but the actual event list remains dynamic. It uses live Nager, Wikipedia, and the public national-day index, filters out unsuitable events, scores likely fun/interesting observances, infers a broad visual category from the title, and chooses a generic caption template.

Examples:

- `National Pizza Day` → food / 🍿-style food imagery / food layout
- `National Dog Day` → animal / 🐾 / animal layout
- space/astronomy event → science / 🚀 / science layout
- historical event → history / 📜 / historical layout

The fallback does not require a curated holiday list.

Fallback selection is explainable. Each candidate receives a category, final score, and a list of scoring reasons. With `debug: true`, the display shows a compact source-health overlay and the Node log reports configuration corrections and upstream failures.

## MagicMirror notifications

The module accepts these notifications from other modules:

- `TODAYIS_REFRESH` rebuilds today's content and images.
- `TODAYIS_NEXT` and `TODAYIS_PREVIOUS` navigate the daily shortlist.
- `TODAYIS_PAUSE` and `TODAYIS_RESUME` control automatic rotation.

It emits `TODAYIS_UPDATED` with the date, placard count, and source diagnostics, and emits `TODAYIS_ERROR` when the display cannot be loaded. These notifications make it straightforward to integrate touch, voice, motion, or presence modules.

## Caching and offline behavior

Each date is cached as JSON under:

```text
cache/YYYY-MM-DD.json
```

Cache JSON uses a versioned day schema containing the placard shortlist and diagnostics. Legacy single-placard cache files are migrated in memory automatically.

Images are cached under:

```text
public/cache/YYYY-MM-DD-<image-hash>.<jpg|png|webp>
```

The module silently prefetches tomorrow after successfully building today. Prefetched content is cached without being sent to the display, giving you a next-day placard if the network is temporarily unavailable during the next morning's startup.

Old JSON and image cache files are pruned after `cacheDays`.

## Standalone preview

Open `preview/index.html` directly in a browser. The preview works without MagicMirror or a build step and lets you:

- Change theme and card dimensions.
- Toggle the background image.
- Navigate sample short, medium, and long titles.
- Paste and render a complete day JSON payload.

This is intended for visual development; live source collection still runs through the MagicMirror Node helper.

To inspect live source health and the ranked candidate list without launching MagicMirror, run:

```bash
npm run smoke -- 2026-08-31
```

## Manual refresh

From the MagicMirror developer console:

```javascript
MM.getModules().withClassName("MMM-TodayIs").enumerate(m => m.sendSocketNotification("FORCE_REFRESH"));
```

## Sources

- Nager.Date for public holidays.
- Wikipedia On This Day for historical events.
- List of National Days as a supplemental public observance index.
- Wikimedia Commons for images.
- OpenAI Responses API for optional enrichment.

The module does not bundle third-party holiday data or copyrighted image assets.

## Validation

Run:

```bash
npm run validate
```

The validator checks file layout, JavaScript syntax, module naming, API endpoints, fallback paths, cache behavior, secret handling, and configuration structure. The behavioral suite covers silent prefetching, concurrent build sharing, schema-v2 day generation, content filtering, source diagnostics, event-specific image queries, image filtering, deterministic captions, and emoji configuration. GitHub Actions runs the suite on Node 18 and 22. It cannot guarantee that external services remain available or that an API key has access to a particular model.
