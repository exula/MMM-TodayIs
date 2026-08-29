const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const required = ["MMM-TodayIs.js", "MMM-TodayIs.css", "node_helper.js", "package.json", "README.md"];
let failed = false;
function ok(name, condition, detail = "") {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failed = true; }
}
for (const file of required) ok(`file ${file}`, fs.existsSync(path.join(root, file)));
for (const file of ["MMM-TodayIs.js", "node_helper.js"]) {
  try { new vm.Script(fs.readFileSync(path.join(root, file), "utf8"), { filename: file }); ok(`syntax ${file}`, true); }
  catch (e) { ok(`syntax ${file}`, false, e.message); }
}
const client = fs.readFileSync(path.join(root, "MMM-TodayIs.js"), "utf8");
const helper = fs.readFileSync(path.join(root, "node_helper.js"), "utf8");
const css = fs.readFileSync(path.join(root, "MMM-TodayIs.css"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

ok("module renamed", client.includes('Module.register("MMM-TodayIs"') && !client.includes("MMM-DailyPlacard"));
ok("CSS renamed", css.includes(".MMM-TodayIs") && !css.includes("MMM-DailyPlacard"));
ok("no npm runtime dependencies", !pkg.dependencies && !pkg.devDependencies);
ok("OpenAI Responses API", helper.includes("https://api.openai.com/v1/responses"));
ok("OpenAI web search", helper.includes('type: "web_search"'));
ok("environment-only API key", helper.includes("process.env.OPENAI_API_KEY") && !client.includes("openaiApiKey"));
ok("Nager holidays", helper.includes("date.nager.at/api/v4/Holidays"));
ok("Wikipedia On This Day", helper.includes("wikipedia.org/api/rest_v1/feed/onthisday/all"));
ok("dynamic national-days source", helper.includes("listofnationaldays.com/what-national-day-is-today"));
ok("Wikimedia Commons image search", helper.includes("commons.wikimedia.org/w/api.php"));
ok("AI fallback", helper.includes("createFallbackPlacard") && helper.includes("AI unavailable; using fallback"));
ok("AI can be disabled", helper.includes("this.config.ai?.enabled"));
ok("fallback can be disabled", helper.includes("this.config.fallback?.enabled"));
ok("fallback keyword categorization", helper.includes("inferCategory") && helper.includes("CATEGORY_META"));
ok("fallback caption templates", helper.includes("fallbackCaption") && helper.includes("Apparently, this is a thing"));
ok("tomorrow prefetch", helper.includes("prefetchTomorrow") && helper.includes("addDays"));
ok("daily JSON cache", helper.includes("cacheFile(date)") && helper.includes("cacheDays"));
ok("image cache", helper.includes("publicCacheDir") && helper.includes("cacheImage"));
ok("cache pruning", helper.includes("pruneCache") && helper.includes("publicCacheDir"));
ok("safe cache permissions", helper.includes("mode: 0o600"));
ok("MagicMirror node helper", helper.includes('require("node_helper")') && helper.includes("sendSocketNotification"));
ok("config hierarchy", client.includes('ai: { enabled: true, model: "gpt-5.6-luna", webSearch: true }') && client.includes("fallback: { enabled: true"));
ok("README renamed", !fs.readFileSync(path.join(root, "README.md"), "utf8").includes("MMM-DailyPlacard"));

if (failed) process.exit(1);
console.log("\nValidation complete: all checks passed.");
