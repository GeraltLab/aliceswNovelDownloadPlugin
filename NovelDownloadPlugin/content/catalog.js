(function () {
  "use strict";

  if (window.__novelDownloadCatalogLoaded) return;
  window.__novelDownloadCatalogLoaded = true;

  const CATALOG_URL_RE =
    /^https:\/\/www\.alicesw\.com\/other\/chapters\/id\/(\d+)\.html(?:\?.*)?$/;
  const BASE_URL = "https://www.alicesw.com/";
  const CHAPTER_HREF_RE = /\/book\/\d+\/[^/]+\.html/;

  function parseCatalogDocument(doc, pageUrl) {
    const novelName =
      doc.querySelector("div.mu_h1 > h1")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim() ||
      "";

    let author =
      doc.querySelector("div.infos > span:first-child a")?.textContent?.trim() || "";

    if (!author) {
      for (const span of doc.querySelectorAll("span")) {
        if (!/作者/.test(span.textContent || "")) continue;
        const a = span.querySelector("a[href]");
        if (a?.textContent?.trim()) {
          author = a.textContent.trim();
          break;
        }
      }
    }

    const chapters = [];
    const seen = new Set();
    const list = doc.querySelector("ul.mulu_list");

    const addChapter = (a) => {
      const title = (a.textContent || "").trim();
      const href = a.getAttribute("href") || "";
      if (!title || !href || !CHAPTER_HREF_RE.test(href)) return;
      const path = href.startsWith("http")
        ? href
        : BASE_URL + (href.startsWith("/") ? href.slice(1) : href);
      if (seen.has(path)) return;
      seen.add(path);
      chapters.push({ title, url: path });
    };

    if (list) {
      list.querySelectorAll(":scope > li > a[href]").forEach(addChapter);
    }

    if (chapters.length === 0) {
      const scope =
        doc.querySelector(".mulu_list") ||
        doc.querySelector("[class*='mulu']") ||
        doc.querySelector(".chapter-list") ||
        doc.body;
      scope.querySelectorAll("a[href]").forEach((a) => {
        if (CHAPTER_HREF_RE.test(a.getAttribute("href") || "")) addChapter(a);
      });
    }

    let novelId = "";
    const href = pageUrl || doc.location?.href || "";
    const match = href.match(/\/id\/(\d+)\.html/);
    if (match) novelId = match[1];

    if (!novelName && !author && chapters.length === 0) {
      return null;
    }

    return { novelName, author, chapters, novelId };
  }

  function parseAndSend() {
    const pageUrl = location.href.split("#")[0];
    if (!CATALOG_URL_RE.test(pageUrl)) {
      return null;
    }

    const data = parseCatalogDocument(document, pageUrl);
    if (!data) {
      return null;
    }

    chrome.runtime.sendMessage({
      type: "CATALOG_PARSED",
      payload: {
        ...data,
        catalogUrl: location.href,
        parsedAt: Date.now(),
      },
    });

    return data;
  }

  function tryParseWithRetries() {
    const first = parseAndSend();
    if (first?.chapters?.length) return;

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const data = parseAndSend();
      if (data?.chapters?.length || attempts >= 12) {
        clearInterval(timer);
      }
    }, 500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RELOAD_CATALOG" || message.type === "PARSE_CATALOG") {
      const data = parseAndSend();
      sendResponse({
        ok: true,
        chapterCount: data?.chapters?.length ?? 0,
      });
      return false;
    }

    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryParseWithRetries, { once: true });
  } else {
    tryParseWithRetries();
  }
})();
