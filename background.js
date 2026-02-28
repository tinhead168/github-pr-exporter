// background.js — MV3 service worker
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith("https://github.com/")) return;

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["collector.js"],
      world: "MAIN",
    });

    if (!result) {
      console.error("Collector returned nothing.");
      return;
    }

    // Build filename: owner-repo-pr123-[sha]-timestamp
    const m = tab.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const slug = m ? `${m[1]}-${m[2]}-pr${m[3]}` : "github-pr";

    // Try to extract a head commit SHA from the payload for uniqueness
    let headSha = "";
    const events = result.timeline || [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].commitSha) {
        headSha = `-${events[i].commitSha.slice(0, 7)}`;
        break;
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${slug}${headSha}-${ts}.json`;

    const json = JSON.stringify(result, null, 2);

    // Download via Blob URL injection — single file, works for large payloads
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (jsonStr, name) => {
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      args: [json, filename],
    });
  } catch (err) {
    console.error("PR Exporter error:", err);
  }
});
