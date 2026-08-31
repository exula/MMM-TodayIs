const Module = require("module");

const originalLoad = Module._load;
Module._load = function mockNodeHelper(request, parent, isMain) {
  if (request === "node_helper") return { create: definition => definition };
  return originalLoad.call(this, request, parent, isMain);
};
const helper = require("./node_helper");
Module._load = originalLoad;

const date = process.argv[2] || new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

helper.path = __dirname;
helper.name = "MMM-TodayIs";
helper.sendSocketNotification = () => {};
helper.start();
helper.socketNotificationReceived("CONFIG", {
  timezone: "America/New_York",
  ai: { enabled: false },
  debug: false
});

helper.collectCandidates(date).then(result => {
  console.log(`\nSource health for ${date}`);
  console.table(result.diagnostics);
  console.log("Top candidates");
  console.table(result.candidates.slice(0, 12).map(item => ({
    score: item.finalScore,
    category: item.category,
    source: item.source,
    title: item.title
  })));
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
