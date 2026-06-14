import { BASE_URL } from "./constants.js";

const CHAPTER_HREF_RE = /\/book\/\d+\/[^/]+\.html/;

/** @returns {{ novelName: string, author: string, chapters: { title: string, url: string }[], novelId: string } | null} */
export function parseCatalogDocument(doc, pageUrl = "") {
  const novelName = doc.querySelector("div.mu_h1 > h1")?.textContent?.trim() ?? "";

  let author =
    doc.querySelector("div.infos > span:first-child a")?.textContent?.trim() ?? "";

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

  const list = doc.querySelector("ul.mulu_list");
  const chapters = [];
  const seen = new Set();

  const addChapter = (/** @type {HTMLAnchorElement} */ a) => {
    const title = a.textContent?.trim() ?? "";
    const href = a.getAttribute("href") ?? "";
    if (!title || !href || !CHAPTER_HREF_RE.test(href)) return;
    const url = href.startsWith("http")
      ? href
      : BASE_URL + (href.startsWith("/") ? href.slice(1) : href);
    if (seen.has(url)) return;
    seen.add(url);
    chapters.push({ title, url });
  };

  if (list) {
    list.querySelectorAll(":scope > li > a[href]").forEach(addChapter);
  }

  if (chapters.length === 0) {
    const scope =
      doc.querySelector(".mulu_list") ||
      doc.querySelector("[class*='mulu']") ||
      doc.body;
    scope.querySelectorAll("a[href]").forEach((a) => {
      if (CHAPTER_HREF_RE.test(a.getAttribute("href") || "")) addChapter(a);
    });
  }

  if (!novelName && !author && chapters.length === 0) {
    return null;
  }

  let novelId = "";
  const href = pageUrl || doc.location?.href || "";
  const match = href.match(/\/id\/(\d+)\.html/);
  if (match) novelId = match[1];

  return {
    novelName,
    author,
    chapters,
    novelId,
  };
}

/** @param {string} chapterUrl */
export function parseChapterBookUrl(chapterUrl) {
  const match = chapterUrl.match(/\/book\/(\d+)\/([^/?#]+)\.html/i);
  if (!match) return null;
  return { sourceId: match[1], key: match[2] };
}

/**
 * 从站点章节 API 返回的 HTML 片段解析段落（多为 "正文</p>" 片段，无开头 <p>）
 * @returns {string[]}
 */
export function parseApiChapterContentHtml(html) {
  if (!html?.trim()) return [];

  const doc = new DOMParser().parseFromString(
    `<div id="ndp-root">${html}</div>`,
    "text/html"
  );
  const root = doc.getElementById("ndp-root");
  if (root) {
    const direct = [...root.children].filter((el) => el.tagName === "P");
    if (direct.length) {
      return direct.map((p) => p.textContent ?? "");
    }
  }

  return html
    .split(/<\/p>/i)
    .map((part) => part.replace(/<[^>]+>/g, ""))
    .filter((text) => /\S/.test(text));
}

/** @returns {string[]} */
export function parseChapterParagraphs(doc) {
  const content =
    doc.querySelector(".read-content.j_readContent") ??
    doc.querySelector(".read-content.j_readContent.user_ad_content");
  if (!content) return [];

  const paragraphs = [];
  for (const child of content.children) {
    if (child.tagName === "P") {
      paragraphs.push(child.textContent ?? "");
    }
  }
  return paragraphs;
}

/** @param {string} chapterTitle @param {string[]} paragraphs */
export function formatChapterBlock(chapterTitle, paragraphs) {
  const body = paragraphs.join("\n");
  return `${chapterTitle}\n\n${body}`;
}

/** @param {{ title: string, paragraphs: string[] }[]} blocks */
export function assembleNovelText(blocks) {
  return blocks.map((b) => formatChapterBlock(b.title, b.paragraphs)).join("\n\n");
}
