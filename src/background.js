"use strict";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith("https://pay.ldxp.cn/order")) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "LDXP_OPEN_ASSISTANT" });
  } catch {
    // The order page may still be loading. The content script will appear when ready.
  }
});
