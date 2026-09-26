chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_TABS") {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      sendResponse(tabs);
    });
    return true;
  }
});
