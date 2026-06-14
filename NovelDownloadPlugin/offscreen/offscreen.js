chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_CREATE_BLOB_URL") {
    try {
      const blob = new Blob([message.text], {
        type: "text/plain;charset=utf-8",
      });
      const objectUrl = URL.createObjectURL(blob);
      sendResponse({ ok: true, objectUrl });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
    return false;
  }

  if (message.type === "OFFSCREEN_REVOKE_BLOB_URL" && message.objectUrl) {
    try {
      URL.revokeObjectURL(message.objectUrl);
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: true });
    }
    return false;
  }

  return false;
});
