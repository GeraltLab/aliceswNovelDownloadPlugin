export const CATALOG_URL_RE =
  /^https:\/\/www\.alicesw\.com\/other\/chapters\/id\/(\d+)\.html(?:\?.*)?$/;

export const BASE_URL = "https://www.alicesw.com/";

export const DEFAULT_SETTINGS = {
  intervalSec: 0.5,
  batchSize: 10,
  batchPauseSec: 5,
};

export const MIN_INTERVAL_SEC = 0.5;
export const MAX_RETRIES = 2;

const CHAPTER_SUFFIX_MAX_NUMBERS = 10;

export function tabStorageKey(tabId) {
  return `novel_tab_${tabId}`;
}

export function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

/** @param {number[]} selectedIndices 0-based indices in chapter list */
export function buildChapterRangeSuffix(selectedIndices, _totalChapterCount) {
  if (!selectedIndices?.length) return "";

  const sorted = [...selectedIndices].sort((a, b) => a - b);
  const nums = sorted.map((i) => i + 1);

  if (nums.length === 1) {
    return `${nums[0]}章`;
  }

  const isContiguous = nums.every(
    (n, idx) => idx === 0 || n === nums[idx - 1] + 1
  );

  if (isContiguous) {
    return `${nums[0]}-${nums[nums.length - 1]}章`;
  }

  if (nums.length > CHAPTER_SUFFIX_MAX_NUMBERS) {
    return `${nums.slice(0, CHAPTER_SUFFIX_MAX_NUMBERS).join("，")}...章`;
  }

  return `${nums.join("，")}章`;
}

export function buildFilename(novelName, author, chapterRangeSuffix = "") {
  const base = `《${novelName}》作者：${author}`;
  const full = chapterRangeSuffix ? `${base} ${chapterRangeSuffix}` : base;
  return `${sanitizeFilename(full)}.txt`;
}
