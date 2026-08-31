const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULTS = {
  countryCode: "US",
  timezone: "America/New_York",
  updateHour: 5,
  updateMinute: 30,
  cacheDays: 14,
  prefetchTomorrow: true,
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
    images: true
  },
  fallback: {
    enabled: true,
    useEmoji: true
  },
  debug: false
};

module.exports = NodeHelper.create({
  start() {
    this.config = clone(DEFAULTS);
    this.busy = false;
    this.cacheDir = path.join(this.path, "cache");
    this.publicCacheDir = path.join(this.path, "public", "cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.publicCacheDir, { recursive: true });
    this.log("started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "CONFIG") {
      this.config = mergeConfig(DEFAULTS, payload || {});
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

  async buildDay(date, force, { notify = true } = {}) {
    if (this.busy) return null;
    this.busy = true;
    let placard = null;
    try {
      const cached = !force ? readJson(this.cacheFile(date)) : null;
      if (cached?.title) {
        if (notify) this.sendSocketNotification("PLACARD", cached);
        placard = cached;
      } else {
        const candidates = await this.collectCandidates(date);
        let mode = "fallback";

        if (this.config.ai?.enabled && process.env.OPENAI_API_KEY) {
          try {
            placard = await this.createAIPlacard(date, candidates);
            mode = "ai";
          } catch (err) {
            this.log(`AI unavailable; using fallback: ${err.message}`);
          }
        } else if (this.config.ai?.enabled) {
          this.log("OPENAI_API_KEY is not set; using fallback");
        }

        if (!placard && this.config.fallback?.enabled !== false) {
          placard = this.createFallbackPlacard(date, candidates);
        }
        if (!placard) throw new Error("No placard could be created");

        if (this.config.sources?.images && placard.imageQuery) {
          try {
            const image = await this.findCommonsImage(placard.imageQuery);
            if (image) {
              const cachedImage = await this.cacheImage(image, date);
              placard.imageUrl = cachedImage.url;
              placard.imageAttribution = cachedImage.attribution;
            }
          } catch (err) {
            this.log(`image unavailable: ${err.message}`);
          }
        }

        placard.date = date;
        placard.mode = mode;
        placard.generatedAt = new Date().toISOString();
        writeJson(this.cacheFile(date), placard);
        this.pruneCache();
        if (notify) this.sendSocketNotification("PLACARD", placard);
      }
      return placard;
    } finally {
      this.busy = false;
    }
  },

  async prefetchTomorrow(today) {
    const tomorrow = addDays(today, 1);
    if (readJson(this.cacheFile(tomorrow))?.title || this.busy) return;
    await this.buildDay(tomorrow, false, { notify: false });
  },

  async collectCandidates(date) {
    const jobs = [];
    this.log(`Collecting candidates for ${date}`);
    if (this.config.sources?.publicHolidays) jobs.push(this.fetchNager(date));
    if (this.config.sources?.wikipedia) jobs.push(this.fetchWikipedia(date));
    if (this.config.sources?.nationalDaysPage) jobs.push(this.fetchNationalDaysPage(date));
    if (this.config.sources?.funHolidays) jobs.push(this.fetchFunHolidays(date));
    if (this.config.sources?.localList) jobs.push(this.fetchLocalList(date));
    const results = await Promise.all(jobs.map(p => p.catch(err => {
      this.log(`source unavailable: ${err.message}`);
      return [];
    })));
    return uniqueByTitle(results.flat().filter(Boolean))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 60);
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
          source: "local",
          date: dateKey,
          type: "observance",
          score: 88
        });
      }

    } catch (err) {
      this.log(`Error reading local list: ${err.message}`);
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
      result.push({ type: "history", title: e.text, description: `On this day in ${e.year}.`, source: "Wikipedia", score: 55, year: e.year });
    }
    for (const e of (data.births || []).slice(0, 5)) {
      result.push({ type: "birth", title: `Birthday: ${e.text}`, description: `Born on this day in ${e.year}.`, source: "Wikipedia", score: 38, year: e.year });
    }
    return result;
  },

  async fetchNationalDaysPage(date) {
    // Public, human-readable holiday index. This is a supplemental source, not a required dependency.
    const url = "https://www.listofnationaldays.com/what-national-day-is-today/";
    const html = await fetchText(url, { timeout: 20000 });
    const month = new Intl.DateTimeFormat("en-US", { timeZone: this.config.timezone, month: "long" }).format(new Date(`${date}T12:00:00`));
    const day = String(Number(date.slice(8, 10)));
    const needle = new RegExp(`${escapeRegExp(month)}\\s+${day}(?:st|nd|rd|th)?[\\s\\S]{0,12000}`, "i");
    const match = html.match(needle);
    if (!match) return [];
    const section = match[0].replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const text = htmlToText(section);
    const candidates = [];
    for (const line of text.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      if (/^(National|International|World|Global|Day|Awareness|Appreciation|History|Month|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i.test(line) && line.length >= 8 && line.length <= 100) {
        candidates.push({ type: "observance", title: line, description: "Daily observance", source: "List of National Days", score: 82 });
      }
    }
    return uniqueByTitle(candidates).slice(0, 20);
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
    const prompt = `You are the creative director for a family MagicMirror display. Today is ${date} in ${this.config.timezone}.\n\nCANDIDATES:\n${candidateText}\n\n${webInstruction}\nChoose ONE genuinely interesting thing about today. Strongly prefer fun national/international observances when available. Otherwise use an interesting historical, science, arts, or culture event. Avoid politics, tragedy, violence, adult topics, and death-focused content.\n\nReturn ONLY JSON matching this shape:\n{"title":"SHORT TITLE","eyebrow":"TODAY IS","caption":"witty sentence under 110 chars","emoji":"🍿","imageQuery":"2-6 word image search","style":"food|animal|history|science|celebration|retro|minimal|modern","accentColor":"#RRGGBB","source":"source name"}`;

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
      eyebrow: candidate?.type === "history" ? "ON THIS DAY" : "TODAY IS",
      caption,
      emoji: this.config.fallback?.useEmoji === false ? "" : meta.emoji,
      imageQuery: buildImageQuery(title),
      style: meta.style,
      accentColor: meta.accent,
      source: candidate?.source || "Local fallback",
      imageUrl: null,
      imageAttribution: null
    };
  },

  async findCommonsImage(query) {
    const params = new URLSearchParams({ action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "20", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1400", format: "json", origin: "*" });
    const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    const pages = Object.values(data.query?.pages || {});
    const usable = pages.map(p => {
      const info = p.imageinfo?.[0];
      if (!info?.thumburl && !info?.url) return null;
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(info.mime)) return null;
      if (Number(info.width) < 800 || Number(info.height) < 400) return null;
      if (/\b(flag|logo|map|diagram|coat of arms|icon)\b/i.test(p.title)) return null;
      const meta = info.extmetadata || {};
      const license = cleanMeta(meta.LicenseShortName?.value);
      const artist = cleanMeta(meta.Artist?.value);
      const title = cleanMeta(meta.ObjectName?.value) || p.title.replace(/^File:/, "");
      return { url: info.thumburl || info.url, contentType: info.mime, width: info.width, height: info.height, index: Number(p.index || 9999), attribution: `Image: ${title}${artist ? ` — ${artist}` : ""}${license ? ` (${license})` : ""}` };
    }).filter(Boolean);
    usable.sort((a, b) => {
      const aWide = a.width / a.height >= 1.25 ? 0 : 1;
      const bWide = b.width / b.height >= 1.25 ? 0 : 1;
      return aWide - bWide || a.index - b.index;
    });
    return usable[0] || null;
  },

  async cacheImage(image, date) {
    const ext = image.contentType === "image/png" ? "png" : image.contentType === "image/webp" ? "webp" : "jpg";
    const fingerprint = crypto.createHash("sha256").update(image.url).digest("hex").slice(0, 12);
    const filename = `${date}-${fingerprint}.${ext}`;
    const file = path.join(this.publicCacheDir, filename);
    if (!fs.existsSync(file)) {
      const response = await fetchWithTimeout(image.url, { headers: { "User-Agent": "MMM-TodayIs/1.0 MagicMirror" } }, 30000);
      if (!response.ok) throw new Error(`image HTTP ${response.status}`);
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
  if (/pizza|popcorn|food|coffee|donut|doughnut|cookie|cake|chocolate|ice cream|burger|bacon|taco|sandwich|pancake|avocado|apple|cheese|peanut|jelly|candy|drink|beverage|pizza/i.test(s)) return "food";
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
  return {
    date,
    title: String(x.title || "Something Interesting About Today").slice(0, 100),
    eyebrow: String(x.eyebrow || "TODAY IS").slice(0, 40),
    caption: String(x.caption || "A little something worth knowing.").slice(0, 140),
    emoji: String(x.emoji || "✨").slice(0, 8),
    imageQuery: String(x.imageQuery || "interesting object").slice(0, 100),
    style: styles.has(x.style) ? x.style : "modern",
    accentColor: /^#[0-9a-f]{6}$/i.test(String(x.accentColor || "")) ? x.accentColor : "#f4b942",
    source: String(x.source || "").slice(0, 300),
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
function uniqueByTitle(items) { const seen = new Set(); return items.filter(x => { if (!x?.title || typeof x.title !== "string") return false; const k = x.title.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
function htmlToText(html) { return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>|<\/li>|<\/h[1-6]>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim(); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
