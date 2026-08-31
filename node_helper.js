const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SCHEMA_VERSION = 2;

const DEFAULTS = {
  countryCode: "US",
  timezone: "America/New_York",
  updateHour: 5,
  updateMinute: 30,
  cacheDays: 14,
  prefetchTomorrow: true,
  maxEvents: 4,
  locale: "en-US",
  labels: {
    todayIs: "TODAY IS",
    onThisDay: "ON THIS DAY"
  },
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
  debug: false
};

module.exports = NodeHelper.create({
  start() {
    this.config = clone(DEFAULTS);
    this.builds = new Map();
    this.cacheDir = path.join(this.path, "cache");
    this.publicCacheDir = path.join(this.path, "public", "cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.publicCacheDir, { recursive: true });
    this.log("started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "CONFIG") {
      this.config = validateConfig(mergeConfig(DEFAULTS, payload || {}), message => this.log(`config: ${message}`));
      return;
    }
    if (notification === "REQUEST_TODAY") {
      const date = localDate(this.config.timezone);
      this.buildDay(date, false).then(() => {
        if (this.config.prefetchTomorrow) return this.prefetchTomorrow(date);
      }).catch(err => this.handleError(err));
      return;
    }
    if (notification === "FORCE_REFRESH") {
      const date = localDate(this.config.timezone);
      this.buildDay(date, true).then(() => {
        if (this.config.prefetchTomorrow) return this.prefetchTomorrow(date);
      }).catch(err => this.handleError(err));
    }
  },

  buildDay(date, force, options = {}) {
    if (this.builds.has(date)) {
      const active = this.builds.get(date);
      if (options.notify !== false && !active.willNotify) {
        active.willNotify = true;
        return active.then(day => { this.sendSocketNotification("DAY", day); return day; });
      }
      return active;
    }
    const task = this.performBuildDay(date, force, options).finally(() => this.builds.delete(date));
    task.willNotify = options.notify !== false;
    this.builds.set(date, task);
    return task;
  },

  async performBuildDay(date, force, { notify = true } = {}) {
    let day = null;
    const cached = !force ? readJson(this.cacheFile(date)) : null;
    day = normalizeCachedDay(cached, date);
    if (day) {
      if (notify) this.sendSocketNotification("DAY", day);
    } else {
        const collected = await this.collectCandidates(date);
        const candidates = collected.candidates;
        const placards = [];

        if (this.config.ai?.enabled && process.env.OPENAI_API_KEY) {
          try {
            const aiPlacard = await this.createAIPlacard(date, candidates);
            aiPlacard.mode = "ai";
            placards.push(aiPlacard);
          } catch (err) {
            this.log(`AI unavailable; using fallback: ${err.message}`);
            collected.diagnostics.push({ source: "OpenAI", status: "error", message: err.message });
          }
        } else if (this.config.ai?.enabled) {
          this.log("OPENAI_API_KEY is not set; using fallback");
          collected.diagnostics.push({ source: "OpenAI", status: "disabled", message: "OPENAI_API_KEY is not set" });
        }

        if (this.config.fallback?.enabled !== false) {
          const selected = selectCandidates(candidates, this.config.maxEvents);
          for (const candidate of selected) {
            if (placards.some(item => normalizeTitle(item.title) === normalizeTitle(candidate.title))) continue;
            const fallbackPlacard = this.createFallbackPlacard(date, [candidate]);
            fallbackPlacard.mode = "fallback";
            placards.push(fallbackPlacard);
            if (placards.length >= this.config.maxEvents) break;
          }
        }
        if (!placards.length) throw new Error("No placard could be created");

        if (this.config.sources?.images) {
          await Promise.all(placards.map(async placard => {
            try {
              let image = placard.sourceImage?.title ? await this.findCommonsFile(placard.sourceImage.title) : null;
              if (!image && placard.imageQuery) image = await this.findCommonsImage(placard.imageQuery);
              if (image) {
                const cachedImage = await this.cacheImage(image, date);
                placard.imageUrl = cachedImage.url;
                placard.imageAttribution = cachedImage.attribution;
                placard.imagePageUrl = cachedImage.descriptionUrl || null;
              }
            } catch (err) {
              this.log(`image unavailable for ${placard.title}: ${err.message}`);
            }
            delete placard.sourceImage;
          }));
        }

        day = {
          schemaVersion: SCHEMA_VERSION,
          date,
          placards,
          diagnostics: collected.diagnostics,
          generatedAt: new Date().toISOString()
        };
        writeJson(this.cacheFile(date), day);
        this.pruneCache();
        if (notify) this.sendSocketNotification("DAY", day);
    }
    return day;
  },

  async prefetchTomorrow(today) {
    const tomorrow = addDays(today, 1);
    if (normalizeCachedDay(readJson(this.cacheFile(tomorrow)), tomorrow) || this.builds.has(tomorrow)) return;
    await this.buildDay(tomorrow, false, { notify: false });
  },

  async collectCandidates(date) {
    const jobs = [];
    this.log(`Collecting candidates for ${date}`);
    const add = (source, enabled, run) => jobs.push({ source, enabled, run });
    add("Nager.Date", this.config.sources?.publicHolidays, () => this.fetchNager(date));
    add("Wikipedia", this.config.sources?.wikipedia, () => this.fetchWikipedia(date));
    add("List of National Days", this.config.sources?.nationalDaysPage, () => this.fetchNationalDaysPage(date));
    add("Todays Holidays", this.config.sources?.funHolidays, () => this.fetchFunHolidays(date));
    add("Local observances", this.config.sources?.localList, () => this.fetchLocalList(date));
    const diagnostics = [];
    const results = await Promise.all(jobs.map(async job => {
      if (!job.enabled) {
        diagnostics.push({ source: job.source, status: "disabled", count: 0, durationMs: 0 });
        return [];
      }
      const started = Date.now();
      try {
        const items = await job.run();
        diagnostics.push({ source: job.source, status: items.length ? "ok" : "empty", count: items.length, durationMs: Date.now() - started });
        return items;
      } catch (err) {
        this.log(`${job.source} unavailable: ${err.message}`);
        diagnostics.push({ source: job.source, status: "error", count: 0, durationMs: Date.now() - started, message: err.message });
        return [];
      }
    }));
    const candidates = uniqueByTitle(results.flat().filter(Boolean))
      .filter(candidate => isAllowedCandidate(candidate, this.config.content))
      .map(candidate => enrichCandidate(candidate, this.config.content))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 60);
    return { candidates, diagnostics };
  },

  async fetchLocalList(date) {
    this.log("Fetching Local List of events")
    const result = [];

    try {
      if (!date || typeof date !== "string") {
        this.log("fetchLocalList: invalid date");
        return result;
      }

      const [, month, day] = date.split("-");

      if (!month || !day) {
        this.log(`fetchLocalList: invalid date format: ${date}`);
        return result;
      }

      const mm = String(Number(month)).padStart(2, "0");
      const dd = String(Number(day)).padStart(2, "0");
      const dateKey = `${mm}-${dd}`;

      const file = path.join(this.path, "public", "static_holidays.json");

      const data = JSON.parse(fs.readFileSync(file, "utf8"));

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        this.log("fetchLocalList: local holiday file contains invalid JSON structure");
        return result;
      }

      const events = data[dateKey];

      if (!Array.isArray(events)) {
        return result;
      }

      // Normalize the entries so the rest of the module can
      // treat local events the same as API-provided events.
      for (const event of events) {
        if (!event || typeof event !== "object") {
          continue;
        }

        if (!event.title || typeof event.title !== "string") {
          continue;
        }

        result.push({
          title: event.title.trim(),
          description:
            typeof event.description === "string"
              ? event.description.trim()
              : "",
          source: "Local observances",
          date: dateKey,
          type: "observance",
          score: 88
        });
      }

    } catch (err) {
      throw new Error(`local observance file: ${err.message}`);
    }

    return result;
  },

  async fetchNager(date) {
    const year = date.slice(0, 4);
    const url = `https://date.nager.at/api/v4/Holidays/${encodeURIComponent(this.config.countryCode)}/${year}`;
    const data = await fetchJson(url);
    return Array.isArray(data) ? data.filter(x => x.date === date).map(x => ({
      type: "public-holiday",
      title: x.localName || x.name,
      description: x.name,
      source: "Nager.Date",
      sourceUrl: "https://date.nager.at/",
      score: x.global ? 95 : 75
    })) : [];
  },

  async fetchFunHolidays(date) {
    const [, month, day] = date.split("-");
    const mm = String(Number(month)).padStart(2, "0");
    const dd = String(Number(day)).padStart(2, "0");
    const url = `https://todaysholiday.herokuapp.com/holidays/${mm}/${dd}`;
    this.log(`Fetching ${url}`)
    const data = await fetchJson(url);
    const result = [];
    // Example output 
    // [{"tags":[],"_id":"60a2c383de7f16354791f65b","name":"National Bow Tie Day","month":8,"day":28},{"tags":[],"_id":"60a2c383de7f16354791f65c","name":"National Cherry Turnovers Day","month":8,"day":28},{"tags":[],"_id":"60a2c383de7f16354791f65a","name":"National Power Rangers Day","month":8,"day":28},{"tags":[],"_id":"60a2c383de7f16354791f65d","name":"Rainbow Bridge Remembrance Day","month":8,"day":28}]
    for (const x of (Array.isArray(data) ? data : [])) {
      if (!x?.name || typeof x.name !== "string") continue;
      result.push(
        { 
          type: "holiday",
          title: x.name,
          description: `It's ${x.name}`,
          source: "Todays Holidays",
          sourceUrl: url,
          score: 84
        }
      )
    }
    return result
  },

  async fetchWikipedia(date) {
    const [, month, day] = date.split("-");
    const mm = String(Number(month)).padStart(2, "0");
    const dd = String(Number(day)).padStart(2, "0");
    const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/${mm}/${dd}`;
    const data = await fetchJson(url);
    const result = [];
    for (const e of (data.events || []).slice(0, 15)) {
      const page = e.pages?.[0];
      result.push({ type: "history", title: e.text, description: `On this day in ${e.year}.`, source: "Wikipedia", sourceUrl: page?.content_urls?.desktop?.page, sourceImage: wikipediaImage(page), score: 55, year: e.year });
    }
    for (const e of (data.births || []).slice(0, 5)) {
      const page = e.pages?.[0];
      result.push({ type: "birth", title: `Birthday: ${e.text}`, description: `Born on this day in ${e.year}.`, source: "Wikipedia", sourceUrl: page?.content_urls?.desktop?.page, sourceImage: wikipediaImage(page), score: 38, year: e.year });
    }
    return result;
  },

  async fetchNationalDaysPage(date) {
    const url = "https://www.listofnationaldays.com/what-national-day-is-today/";
    const html = await fetchText(url, { timeout: 20000 });
    const markerParts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", year: "numeric" })
      .formatToParts(new Date(`${date}T12:00:00Z`)).reduce((out, part) => (out[part.type] = part.value, out), {});
    const marker = `${markerParts.weekday} ${markerParts.month} ${markerParts.day}, ${markerParts.year}`;
    const needle = new RegExp(`${escapeRegExp(marker)}\\s*<\\/p>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`, "i");
    const match = html.match(needle);
    if (!match) return [];
    const candidates = [];
    const linkPattern = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const link of match[1].matchAll(linkPattern)) {
      const title = htmlToText(link[2]).trim();
      if (title.length < 4 || title.length > 120) continue;
      candidates.push({ type: "observance", title, description: "Daily observance", source: "List of National Days", sourceUrl: link[1], score: 82 });
    }
    return uniqueByTitle(candidates).slice(0, 30);
  },

  async createAIPlacard(date, candidates) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const candidateText = candidates.length
      ? candidates.map((c, i) => `${i + 1}. [${c.type}] ${c.title} — ${c.description || ""} (${c.source})`).join("\n")
      : "No structured candidates were available.";
    const webInstruction = this.config.ai.webSearch
      ? "Use web search to find additional fun, family-friendly observances for this exact date if the candidates are weak. Do not invent observances."
      : "Do not use web search.";
    const prompt = `You are the creative director for a family MagicMirror display. Today is ${date} in ${this.config.timezone}. Write for locale ${this.config.locale}.\n\nCANDIDATES:\n${candidateText}\n\n${webInstruction}\nChoose ONE genuinely interesting thing about today. Strongly prefer fun national/international observances when available. Otherwise use an interesting historical, science, arts, or culture event. Avoid politics, tragedy, violence, adult topics, and death-focused content.\n\nReturn ONLY JSON matching this shape:\n{"title":"SHORT TITLE","eyebrow":"${this.config.labels?.todayIs || "TODAY IS"}","caption":"witty sentence under 110 chars","emoji":"🍿","imageQuery":"2-6 word image search","style":"food|animal|history|science|celebration|retro|minimal|modern","accentColor":"#RRGGBB","source":"source name"}`;

    const body = {
      model: this.config.ai.model,
      input: prompt,
      max_output_tokens: 500,
      tools: this.config.ai.webSearch ? [{ type: "web_search" }] : undefined
    };
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, 45000);
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const json = await response.json();
    return normalizeAI(parseJsonObject(extractResponseText(json)), date);
  },

  createFallbackPlacard(date, candidates) {
    const candidate = chooseFallbackCandidate(candidates);
    const title = candidate?.title || fallbackDateTitle(date);
    const category = inferCategory(title, candidate?.type);
    const meta = CATEGORY_META[category];
    const caption = fallbackCaption(title, category);
    return {
      date,
      title: title.toUpperCase().slice(0, 100),
      eyebrow: candidate?.type === "history" ? (this.config.labels?.onThisDay || "ON THIS DAY") : (this.config.labels?.todayIs || "TODAY IS"),
      caption,
      emoji: this.config.fallback?.useEmoji === false ? "" : meta.emoji,
      imageQuery: buildImageQuery(title),
      style: meta.style,
      accentColor: meta.accent,
      source: candidate?.source || "Local fallback",
      sourceUrl: candidate?.sourceUrl || null,
      sourceImage: candidate?.sourceImage || null,
      category,
      score: candidate?.finalScore ?? candidate?.score ?? 0,
      reasons: candidate?.reasons || [],
      imageUrl: null,
      imageAttribution: null
    };
  },

  async findCommonsImage(query) {
    const params = new URLSearchParams({ action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "20", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1400", format: "json", origin: "*" });
    const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    return selectCommonsImage(data);
  },

  async findCommonsFile(title) {
    const params = new URLSearchParams({ action: "query", titles: title, prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1400", format: "json", origin: "*" });
    const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    return selectCommonsImage(data);
  },

  async cacheImage(image, date) {
    const ext = image.contentType === "image/png" ? "png" : image.contentType === "image/webp" ? "webp" : "jpg";
    const fingerprint = crypto.createHash("sha256").update(image.url).digest("hex").slice(0, 12);
    const filename = `${date}-${fingerprint}.${ext}`;
    const file = path.join(this.publicCacheDir, filename);
    if (!fs.existsSync(file)) {
      const response = await fetchWithTimeout(image.url, { headers: { "User-Agent": "MMM-TodayIs/1.0 MagicMirror" } }, 30000);
      if (!response.ok) throw new Error(`image HTTP ${response.status}`);
      const responseType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (responseType && !new Set(["image/jpeg", "image/png", "image/webp"]).has(responseType)) throw new Error(`unsupported image content type ${responseType}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 12 * 1024 * 1024) throw new Error("image exceeds 12MB limit");
      fs.writeFileSync(file, buffer, { mode: 0o600 });
    }
    return { ...image, url: `/modules/${this.name}/public/cache/${filename}` };
  },

  cacheFile(date) { return path.join(this.cacheDir, `${date}.json`); },

  pruneCache() {
    const maxAge = Number(this.config.cacheDays || 14) * 86400000;
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      try { if (Date.now() - fs.statSync(path.join(this.cacheDir, name)).mtimeMs > maxAge) fs.unlinkSync(path.join(this.cacheDir, name)); } catch (_) {}
    }
    for (const name of fs.readdirSync(this.publicCacheDir)) {
      if (!/^\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{12})?\.(?:jpg|png|webp)$/.test(name)) continue;
      try { if (Date.now() - fs.statSync(path.join(this.publicCacheDir, name)).mtimeMs > maxAge) fs.unlinkSync(path.join(this.publicCacheDir, name)); } catch (_) {}
    }
  },

  handleError(err) {
    this.error(err);
    this.sendSocketNotification("ERROR", "Unable to create today's placard.");
  },
  log(message) { if (this.config.debug) console.log(`[MMM-TodayIs] ${message}`); },
  error(err) { console.error(`[MMM-TodayIs] ${err.stack || err}`); }
});

function selectCommonsImage(data) {
    const pages = Object.values(data.query?.pages || {});
    const usable = pages.map(p => {
      const info = p.imageinfo?.[0];
      if (!info?.thumburl && !info?.url) return null;
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(info.mime)) return null;
      if (Number(info.width) < 800 || Number(info.height) < 400) return null;
      if (/\b(flag|logo|map|diagram|coat of arms|icon)\b/i.test(p.title)) return null;
      const meta = info.extmetadata || {};
      const license = cleanMeta(meta.LicenseShortName?.value);
      const licenseUrl = cleanMeta(meta.LicenseUrl?.value);
      const artist = cleanMeta(meta.Artist?.value);
      const title = cleanMeta(meta.ObjectName?.value) || p.title.replace(/^File:/, "");
      return { url: info.thumburl || info.url, contentType: info.mime, width: info.width, height: info.height, index: Number(p.index || 9999), descriptionUrl: info.descriptionurl, license, licenseUrl, attribution: `Image: ${title}${artist ? ` — ${artist}` : ""}${license ? ` (${license})` : ""}` };
    }).filter(Boolean);
    usable.sort((a, b) => {
      const aWide = a.width / a.height >= 1.25 ? 0 : 1;
      const bWide = b.width / b.height >= 1.25 ? 0 : 1;
      return aWide - bWide || a.index - b.index;
    });
    return usable[0] || null;
}

const CATEGORY_META = {
  food: { emoji: "🍿", style: "food", accent: "#F4B942", imageQuery: "delicious food" },
  animal: { emoji: "🐾", style: "animal", accent: "#7FC8A9", imageQuery: "cute animal" },
  science: { emoji: "🔬", style: "science", accent: "#63C5DA", imageQuery: "science laboratory" },
  history: { emoji: "📜", style: "history", accent: "#D9A441", imageQuery: "historical photograph" },
  space: { emoji: "🚀", style: "science", accent: "#9B8AFB", imageQuery: "space astronomy" },
  music: { emoji: "🎵", style: "celebration", accent: "#F28F3B", imageQuery: "live music concert" },
  nature: { emoji: "🌎", style: "modern", accent: "#69B578", imageQuery: "beautiful nature" },
  books: { emoji: "📚", style: "retro", accent: "#D9A441", imageQuery: "books library" },
  celebration: { emoji: "🎉", style: "celebration", accent: "#FF6B9D", imageQuery: "colorful celebration" },
  generic: { emoji: "✨", style: "modern", accent: "#F4B942", imageQuery: "interesting object" }
};

function normalizeCachedDay(cached, date) {
  if (!cached) return null;
  if (cached.schemaVersion === SCHEMA_VERSION && cached.date === date && Array.isArray(cached.placards) && cached.placards.length) return cached;
  if (cached.title && cached.date === date) {
    return {
      schemaVersion: SCHEMA_VERSION,
      date,
      placards: [cached],
      diagnostics: [{ source: "cache", status: "migrated", count: 1, durationMs: 0 }],
      generatedAt: cached.generatedAt || new Date().toISOString()
    };
  }
  return null;
}

function validateConfig(config, warn = () => {}) {
  const out = clone(config);
  try { new Intl.DateTimeFormat("en-US", { timeZone: out.timezone }).format(); }
  catch (_) { warn(`invalid timezone '${out.timezone}', using America/New_York`); out.timezone = "America/New_York"; }
  out.countryCode = /^[A-Z]{2}$/i.test(String(out.countryCode)) ? String(out.countryCode).toUpperCase() : "US";
  out.updateHour = clampInteger(out.updateHour, 0, 23, DEFAULTS.updateHour, "updateHour", warn);
  out.updateMinute = clampInteger(out.updateMinute, 0, 59, DEFAULTS.updateMinute, "updateMinute", warn);
  out.cacheDays = clampInteger(out.cacheDays, 1, 365, DEFAULTS.cacheDays, "cacheDays", warn);
  out.maxEvents = clampInteger(out.maxEvents, 1, 10, DEFAULTS.maxEvents, "maxEvents", warn);
  return out;
}

function clampInteger(value, minimum, maximum, fallback, name, warn) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    warn(`invalid ${name} '${value}', using ${fallback}`);
    return fallback;
  }
  return number;
}

function isAllowedCandidate(candidate, content = {}) {
  const text = `${candidate.title || ""} ${candidate.description || ""}`;
  if (!content.includeBirthdays && candidate.type === "birth") return false;
  if (content.excludePolitics && /\b(politic|president|prime minister|election|congress|parliament|impeach)/i.test(text)) return false;
  if (content.excludeTragedy && /\b(tragedy|crash|disaster|earthquake|landslide|stampede|massacre|bomb|war|battle|kill(?:ed|ing|s)?|fatal|troops?|military|invasion)/i.test(text)) return false;
  if (content.excludeDeaths && /\b(death|died|dies|kill(?:ed|ing|s)?|murder|assassinat)/i.test(text)) return false;
  if (content.familyFriendly && /\b(adult|porn|sex|drug|overdose|alcohol|cocktail|vodka)/i.test(text)) return false;
  return true;
}

function enrichCandidate(candidate, content = {}) {
  const category = inferCategory(candidate.title, candidate.type);
  const reasons = [];
  let finalScore = fallbackScore(candidate);
  if (candidate.type === "observance" || candidate.type === "holiday") reasons.push("daily observance");
  if (candidate.source === "Local observances") reasons.push("reliable local baseline");
  if (candidate.sourceImage) { finalScore += 8; reasons.push("source image available"); }
  const preferenceIndex = (content.preferredCategories || []).indexOf(category);
  if (preferenceIndex >= 0) {
    finalScore += 12 + Math.max(0, content.preferredCategories.length - preferenceIndex);
    reasons.push(`preferred ${category} category`);
  }
  return { ...candidate, category, finalScore, reasons };
}

function selectCandidates(candidates, maximum = 4) {
  const selected = [];
  const usedCategories = new Set();
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (!usedCategories.has(candidate.category)) {
      selected.push(candidate);
      usedCategories.add(candidate.category);
    }
  }
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

function wikipediaImage(page) {
  const image = page?.originalimage || page?.thumbnail;
  if (!image?.source || !/upload\.wikimedia\.org\/wikipedia\/commons\//i.test(image.source)) return null;
  const filename = decodeURIComponent(new URL(image.source).pathname.split("/").pop());
  if (!/\.(?:jpe?g|png|webp)$/i.test(filename)) return null;
  return { title: `File:${filename}` };
}

function normalizeTitle(value) { return String(value || "").trim().toLowerCase(); }

function chooseFallbackCandidate(candidates) {
  const viable = candidates.filter(c => !/death|died|war|battle|tragedy|murder|assassinat|politic/i.test(`${c.title} ${c.description || ""}`));
  return viable.sort((a, b) => fallbackScore(b) - fallbackScore(a))[0] || candidates[0] || null;
}
function fallbackScore(c) {
  let score = c.score || 0;
  if (/national|international|world|day|appreciation|food|animal|science/i.test(c.title)) score += 30;
  if (/birthday:/i.test(c.title)) score -= 10;
  if (c.type === "public-holiday") score += 10;
  return score;
}
function inferCategory(title, type) {
  const s = `${title} ${type || ""}`.toLowerCase();
  if (/pizza|popcorn|food|coffee|donut|doughnut|cookie|cake|chocolate|ice cream|burger|bacon|taco|sandwich|pancake|avocado|apple|cheese|peanut|jelly|candy|drink|beverage|trail mix|snack|raisin|cashew|almond/i.test(s)) return "food";
  if (/dog|cat|turtle|bird|animal|pet|puppy|kitten|horse|whale|shark|bee|butterfly|elephant|mutt/i.test(s)) return "animal";
  if (/space|nasa|moon|mars|rocket|astronomy|science|technology|computer|internet|ai |artificial intelligence/i.test(s)) return /space|moon|mars|rocket|astronomy/.test(s) ? "space" : "science";
  if (/music|song|jazz|rock|concert|radio/i.test(s)) return "music";
  if (/book|reading|author|novel|library|literature|poetry/i.test(s)) return "books";
  if (/earth|nature|environment|tree|forest|ocean|water|climate|garden/i.test(s)) return "nature";
  if (type === "history" || /history|anniversary|founded|launched|discovered|born/i.test(s)) return "history";
  if (/festival|celebration|party|friendship|love|smile|hug/i.test(s)) return "celebration";
  return "generic";
}
function fallbackCaption(title, category) {
  const templates = {
    food: [`Apparently, ${title.toLowerCase()} deserves its own day. We're not arguing.`, "Honestly, this one makes perfect sense."],
    animal: ["Go find a furry, feathered, or scaly friend and celebrate.", "The animals have officially entered the chat."],
    science: ["A little science makes every day more interesting.", "Today is a good day to be curious."],
    history: ["A little bit of history hiding in your calendar.", "Today happened once before. Here's the interesting part."],
    space: ["Look up. There's always something interesting happening out there.", "The universe remains spectacularly busy."],
    music: ["Turn something up and celebrate accordingly.", "Today deserves a soundtrack."],
    books: ["A good excuse to read a few more pages.", "Every day is better with a good story."],
    nature: ["Go outside. The original display has better graphics.", "The world outside is doing pretty well today."],
    celebration: ["Apparently, somebody decided this needed its own day.", "Today's excuse to celebrate has arrived."],
    generic: ["Apparently, this is a thing. And now you know.", "Your daily dose of something interesting."]
  };
  const choices = templates[category] || templates.generic;
  const index = [...title].reduce((sum, character) => sum + character.codePointAt(0), 0) % choices.length;
  return choices[index].slice(0, 140);
}
function buildImageQuery(title) {
  const cleanTitle = String(title)
    .replace(/^(National|International|World|Global)\s+/i, "")
    .replace(/\b(day|week|month)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleanTitle || String(title)).slice(0, 100);
}
function fallbackDateTitle(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}
function normalizeAI(x, date) {
  const styles = new Set(["food", "animal", "history", "science", "celebration", "retro", "minimal", "modern"]);
  const title = String(x.title || "Something Interesting About Today").slice(0, 100);
  const category = inferCategory(title);
  return {
    date,
    title,
    eyebrow: String(x.eyebrow || "TODAY IS").slice(0, 40),
    caption: String(x.caption || "A little something worth knowing.").slice(0, 140),
    emoji: String(x.emoji || "✨").slice(0, 8),
    imageQuery: String(x.imageQuery || "interesting object").slice(0, 100),
    style: styles.has(x.style) ? x.style : "modern",
    accentColor: /^#[0-9a-f]{6}$/i.test(String(x.accentColor || "")) ? x.accentColor : "#f4b942",
    source: String(x.source || "").slice(0, 300),
    sourceUrl: null,
    category,
    reasons: ["AI editorial selection"],
    imageUrl: null,
    imageAttribution: null
  };
}
async function fetchJson(url, options = {}) { return (await fetchWithTimeout(url, options, options.timeout || 30000)).json(); }
async function fetchText(url, options = {}) { return fetchWithTimeout(url, options, options.timeout || 30000).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }); }
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { "User-Agent": "MMM-TodayIs/1.0 MagicMirror", ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally { clearTimeout(timer); }
}
function extractResponseText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response.output || []) for (const c of item.content || []) if (typeof c.text === "string") chunks.push(c.text);
  return chunks.join("\n");
}
function parseJsonObject(text) {
  const cleaned = String(text).replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`OpenAI did not return JSON: ${cleaned.slice(0, 300)}`);
    return JSON.parse(match[0]);
  }
}
function localDate(timezone) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function addDays(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }
function cleanMeta(value) { return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 180); }
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function mergeConfig(base, override) { const out = clone(base); for (const [k, v] of Object.entries(override || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(out[k] || {}), ...v } : v; return out; }
function uniqueByTitle(items) {
  const unique = new Map();
  for (const item of items) {
    if (!item?.title || typeof item.title !== "string") continue;
    const key = item.title.trim().toLowerCase();
    if (!key) continue;
    const existing = unique.get(key);
    if (!existing || Number(item.score || 0) > Number(existing.score || 0)) unique.set(key, item);
  }
  return [...unique.values()];
}
function htmlToText(html) { return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>|<\/li>|<\/h[1-6]>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim(); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
