const sample = {
  date: "2026-08-31",
  placards: [
    { title: "NATIONAL TRAIL MIX DAY", eyebrow: "TODAY IS", caption: "A snack bag that's mostly an excuse to eat the chocolate chips first.", emoji: "🍿", style: "food", accentColor: "#F4B942", source: "Local observances", imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/Planters-Trail-Mix.jpg/1280px-Planters-Trail-Mix.jpg" },
    { title: "A TELESCOPE DISCOVERED A COMET HIDING IN PLAIN SIGHT", eyebrow: "ON THIS DAY", caption: "Today is a good day to be curious.", emoji: "🔬", style: "science", accentColor: "#63C5DA", source: "Wikipedia", imageUrl: "" },
    { title: "A VERY LONG HISTORICAL TITLE THAT DEMONSTRATES HOW THE RESPONSIVE TYPOGRAPHY HANDLES DENSE CONTENT", eyebrow: "ON THIS DAY", caption: "A little bit of history hiding in your calendar.", emoji: "📜", style: "history", accentColor: "#D9A441", source: "Wikipedia", imageUrl: "" }
  ]
};

let day = structuredClone(sample);
let index = 0;
const preview = document.querySelector("#preview");
const json = document.querySelector("#json");
json.value = JSON.stringify(day, null, 2);

function render() {
  const data = day.placards[index] || day.placards[0];
  const theme = document.querySelector("#theme").value;
  const showImage = document.querySelector("#image").checked;
  preview.style.width = `${document.querySelector("#width").value}px`;
  preview.style.height = `${document.querySelector("#height").value}px`;
  const length = data.title.length > 72 ? "long" : data.title.length > 42 ? "medium" : "short";
  const card = document.createElement("div");
  card.className = `today-is today-is-in style-${theme === "auto" ? data.style : theme} title-${length}${showImage && data.imageUrl ? "" : " no-image"}`;
  card.style.setProperty("--accent", data.accentColor);
  card.style.setProperty("--text-scale", document.querySelector("#textScale").value);
  if (showImage && data.imageUrl) card.style.setProperty("--background-image", `url("${data.imageUrl}")`);
  card.innerHTML = `<div class="today-is-veil"></div><div class="today-is-content"><div class="today-is-eyebrow"></div><div class="today-is-emoji"></div><div class="today-is-title"></div><div class="today-is-caption"></div><div class="today-is-date"></div><div class="today-is-source"></div><div class="today-is-position"></div></div>`;
  card.querySelector(".today-is-eyebrow").textContent = data.eyebrow;
  card.querySelector(".today-is-emoji").textContent = data.emoji;
  card.querySelector(".today-is-title").textContent = data.title;
  card.querySelector(".today-is-caption").textContent = data.caption;
  card.querySelector(".today-is-date").textContent = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "long" }).format(new Date(`${day.date}T12:00:00Z`));
  card.querySelector(".today-is-source").textContent = data.source;
  card.querySelector(".today-is-position").textContent = `${index + 1} / ${day.placards.length}`;
  preview.replaceChildren(card);
}

for (const selector of ["#theme", "#width", "#height", "#textScale", "#image"]) document.querySelector(selector).addEventListener("input", render);
document.querySelector("#next").addEventListener("click", () => { index = (index + 1) % day.placards.length; render(); });
document.querySelector("#previous").addEventListener("click", () => { index = (index - 1 + day.placards.length) % day.placards.length; render(); });
document.querySelector("#apply").addEventListener("click", () => {
  try {
    const parsed = JSON.parse(json.value);
    if (!Array.isArray(parsed.placards) || !parsed.placards.length) throw new Error("placards must be a non-empty array");
    day = parsed; index = 0; document.querySelector("#error").textContent = ""; render();
  } catch (error) { document.querySelector("#error").textContent = error.message; }
});
render();
