chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "EXTRACT_TEXT") {
    try {
      const text = document.body?.innerText || "";
      sendResponse({ text: text.slice(0, 8000) });
    } catch {
      sendResponse({ text: "" });
    }
  }
});
