#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const BILI_API = "https://api.bilibili.com";

main().catch((error) => {
  console.error(`下载失败：${error.message || error}`);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.url && !options.subtitleUrl)) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const cookie = await readCookie(options);
  const result = options.subtitleUrl
    ? await downloadSubtitleUrl(options.subtitleUrl, {
        cookie,
        pageUrl: options.url,
        page: options.page
      })
    : options.allowApi
      ? isYouTubeUrl(options.url)
        ? await downloadYouTubeSubtitle(options.url, {
            cookie,
            subtitleIndex: options.subtitleIndex
          })
        : await downloadSubtitle(options.url, {
            cookie,
            page: options.page,
            subtitleIndex: options.subtitleIndex
          })
      : await downloadSubtitleWithBrowser(options.url, {
          cookie,
          page: options.page,
          subtitleIndex: options.subtitleIndex,
          browserTimeout: options.browserTimeout,
          browserChannel: options.browserChannel,
          headed: options.headed
        });

  if (options.list) {
    printSubtitleList(result);
    return;
  }

  const outputDir = resolve(options.outDir || "downloads");
  await mkdir(outputDir, { recursive: true });

  const baseName = safeFileName([result.video.title, result.video.partTitle].filter(Boolean).join(" - "));
  const formats = options.format === "all" ? ["txt", "srt", "json"] : [options.format];
  const written = [];

  for (const format of formats) {
    const path = join(outputDir, `${baseName}.${format}`);
    const content = formatContent(format, result);
    await writeFile(path, content, "utf8");
    written.push(path);
  }

  console.log(`视频：${result.video.title}`);
  console.log(`字幕：${result.selectedSubtitle.languageName} · ${result.selectedSubtitle.isAi ? "AI" : "字幕"}`);
  console.log(`分段：${result.segments.length} 段整理稿 / ${result.rawSegments.length} 条原始字幕`);
  if (result.quality.warning) {
    console.log(`提示：${result.quality.warning}`);
  }
  console.log("已写入：");
  for (const path of written) {
    console.log(`- ${path}`);
  }
}

function parseArgs(args) {
  const options = {
    url: "",
    outDir: "downloads",
    format: "all",
    page: null,
    subtitleIndex: null,
    subtitleUrl: "",
    allowApi: false,
    browserTimeout: 20000,
    browserChannel: "chrome",
    headed: false,
    cookie: "",
    cookieFile: "",
    list: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--out" || arg === "-o") {
      options.outDir = readValue(args, ++index, arg);
    } else if (arg === "--format" || arg === "-f") {
      options.format = readValue(args, ++index, arg);
    } else if (arg === "--page" || arg === "-p") {
      options.page = Number(readValue(args, ++index, arg));
    } else if (arg === "--subtitle-index" || arg === "-i") {
      options.subtitleIndex = Number(readValue(args, ++index, arg));
    } else if (arg === "--subtitle-url") {
      options.subtitleUrl = readValue(args, ++index, arg);
    } else if (arg === "--allow-api") {
      options.allowApi = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--browser-timeout") {
      options.browserTimeout = Number(readValue(args, ++index, arg));
    } else if (arg === "--browser-channel") {
      options.browserChannel = readValue(args, ++index, arg);
    } else if (arg === "--cookie") {
      options.cookie = readValue(args, ++index, arg);
    } else if (arg === "--cookie-file") {
      options.cookieFile = readValue(args, ++index, arg);
    } else if (arg === "--list") {
      options.list = true;
    } else if (!options.url) {
      options.url = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (!["txt", "srt", "json", "all"].includes(options.format)) {
    throw new Error("--format 只能是 txt、srt、json 或 all");
  }

  if (options.page !== null && (!Number.isInteger(options.page) || options.page <= 0)) {
    throw new Error("--page 必须是正整数");
  }

  if (
    options.subtitleIndex !== null &&
    (!Number.isInteger(options.subtitleIndex) || options.subtitleIndex < 0)
  ) {
    throw new Error("--subtitle-index 必须是从 0 开始的整数");
  }

  if (!Number.isFinite(options.browserTimeout) || options.browserTimeout < 3000) {
    throw new Error("--browser-timeout 必须是不小于 3000 的毫秒数");
  }

  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} 缺少参数值`);
  }
  return value;
}

async function readCookie(options) {
  if (options.cookie) return normalizeCookie(options.cookie);
  if (process.env.BILI_COOKIE) return normalizeCookie(process.env.BILI_COOKIE);
  if (options.cookieFile) {
    return normalizeCookie(await readFile(resolve(options.cookieFile), "utf8"));
  }
  return "";
}

function normalizeCookie(cookie) {
  return String(cookie || "")
    .trim()
    .replace(/^cookie:\s*/i, "")
    .trim();
}

async function importPlaywright() {
  try {
    return await import("playwright-core");
  } catch (error) {
    throw new Error("浏览器模式需要依赖 playwright-core。请先在项目目录运行 npm install。");
  }
}

function cookieHeaderToPlaywrightCookies(cookieHeader, domain = ".bilibili.com") {
  return normalizeCookie(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return null;

      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        domain,
        path: "/",
        secure: true,
        sameSite: "Lax"
      };
    })
    .filter(Boolean);
}

async function activateSubtitleInPage(page) {
  await page.mouse.move(720, 820).catch(() => null);
  await page.evaluate(() => {
    const video = document.querySelector("video");
    video?.play?.().catch?.(() => {});
  }).catch(() => null);
  await page.waitForTimeout(800);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.move(720, 900).catch(() => null);
    await page.waitForTimeout(400);
    await page.evaluate(clickSubtitleControlInBrowser).catch(() => null);
    await page.waitForTimeout(600);
    await page.evaluate(clickSubtitleMenuItemInBrowser).catch(() => null);
    await page.waitForTimeout(1200);
  }
}

function clickSubtitleControlInBrowser() {
  const candidates = Array.from(document.querySelectorAll([
    "[aria-label*='字幕']",
    "[title*='字幕']",
    "[data-title*='字幕']",
    "[class*='subtitle']",
    "[class*='Subtitle']",
    "[class*='caption']",
    ".bpx-player-ctrl-subtitle",
    ".bilibili-player-video-btn-subtitle"
  ].join(",")));

  const controls = candidates
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-title"),
        element.getAttribute("class"),
        element.textContent
      ].filter(Boolean).join(" ");

      if (!/字幕|subtitle|caption|cc/i.test(label)) return false;
      if (/panel|text|item|container|wrap|list|menu/i.test(label) && !/button|btn|ctrl|control|switch|toggle|icon/i.test(label)) return false;

      return true;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.bottom - leftRect.bottom;
    });

  controls[0]?.click?.();
  return controls.length;
}

function clickSubtitleMenuItemInBrowser() {
  const elements = Array.from(document.querySelectorAll("li, button, div, span"));
  const item = elements.find((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.width > 400 || rect.height > 120) return false;

    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    return /中文|简体|繁体|AI|自动生成|字幕/.test(text) && !/关闭|设置|没有字幕|无法开启/.test(text);
  });

  item?.click?.();
  return Boolean(item);
}

async function readBrowserSubtitleSnapshot(page) {
  return page.evaluate(() => {
    function cleanText(text) {
      return String(text || "")
        .replace(/\s+/g, " ")
        .replace(/字幕已切换至.+$/, "")
        .trim();
    }

    function isSubtitleResourceUrl(url) {
      return /subtitle|caption|aisub|asr/i.test(url) && (/\.json(?:\?|$)/i.test(url) || /aisubtitle|subtitle/i.test(url));
    }

    function readVisibleSubtitleText() {
      const selectors = [
        ".bpx-player-subtitle-panel-text",
        ".bpx-player-subtitle-panel",
        ".bilibili-player-video-subtitle",
        ".squirtle-subtitle-item",
        "[class*='subtitle'][class*='text']",
        "[class*='subtitle'][class*='panel']",
        "[class*='caption']"
      ];

      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          const text = cleanText(element.textContent || "");
          if (text && text.length <= 120) return text;
        }
      }

      return "";
    }

    const bodyText = cleanText(document.body?.innerText || "");
    return {
      title: document.title
        .replace(/_哔哩哔哩_bilibili$/, "")
        .replace(/-哔哩哔哩$/, "")
        .trim(),
      visibleSubtitle: readVisibleSubtitleText(),
      noSubtitleText: /该视频没有字幕|没有字幕，无法|无法开启.*字幕|字幕不可用/.test(bodyText),
      subtitleResources: Array.from(new Set(
        performance
          .getEntriesByType("resource")
          .map((entry) => String(entry.name || ""))
          .filter(isSubtitleResourceUrl)
      )).slice(-20).reverse()
    };
  });
}

async function buildBrowserSubtitleCandidates({ captured, resourceUrls, visibleSubtitle, cookie }) {
  const visible = normalizeForMatch(visibleSubtitle);
  const candidates = [];
  const seen = new Set();

  for (const item of captured) {
    const normalizedUrl = normalizeSubtitleUrl(item.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    const candidate = createBrowserSubtitleCandidate(normalizedUrl, item.rawSegments, visible);
    if (candidate) candidates.push(candidate);
  }

  for (const url of resourceUrls.slice(0, 12)) {
    const normalizedUrl = normalizeSubtitleUrl(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    try {
      const rawSegments = await fetchSubtitleSegments(normalizedUrl, cookie);
      const candidate = createBrowserSubtitleCandidate(normalizedUrl, rawSegments, visible);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      // Stale or unrelated JSON resource.
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate, index) => ({
      ...candidate,
      index
    }));
}

function createBrowserSubtitleCandidate(url, rawSegments, visible) {
  if (!rawSegments.length) return null;

  const segments = buildTranscriptSegments(rawSegments);
  const quality = analyzeTranscriptQuality(rawSegments, segments);
  const text = normalizeForMatch(segments.map((segment) => segment.text).join(""));
  const matchVisible = Boolean(visible && text.includes(visible.slice(0, Math.min(visible.length, 24))));

  if (visible && !matchVisible) return null;
  if (!quality.usable && !matchVisible) return null;

  return {
    index: 0,
    id: null,
    language: "",
    languageName: matchVisible ? "播放器当前字幕" : "播放器字幕",
    isAi: /ai|asr|subtitle/i.test(url),
    sourceType: "浏览器",
    url,
    rawSegments,
    quality,
    matchVisible,
    score: (matchVisible ? 1000 : 0) + quality.meaningfulChars
  };
}

async function downloadSubtitle(url, options = {}) {
  const identity = parseVideoIdentity(url, options);
  if (!identity.bvid && !identity.aid) {
    throw new Error("没有从 URL 识别到 bvid 或 aid");
  }

  const view = await fetchView(identity, options.cookie);
  const page = selectPage(identity, view);
  const bvid = view.bvid || identity.bvid;
  const aid = view.aid || identity.aid;
  const cid = page?.cid || identity.cid;

  if (!cid) {
    throw new Error("没有找到当前分 P 的 cid");
  }

  const playerInfo = await fetchPlayerInfo({ bvid, aid, cid, cookie: options.cookie });
  const subtitles = normalizeSubtitles(playerInfo?.subtitle?.subtitles || []);
  if (!subtitles.length) {
    throw new Error(
      "这个视频没有通过接口返回可下载字幕。若网页里能看到 AI 字幕，请用 --cookie-file 或 BILI_COOKIE 传入登录 Cookie；若是画面硬字幕，需要 OCR/语音识别。"
    );
  }

  const selectedIndex = chooseSubtitleIndex(subtitles, options.subtitleIndex);
  const selectedSubtitle = subtitles[selectedIndex];
  const rawSegments = await fetchSubtitleSegments(selectedSubtitle.url, options.cookie);
  if (!rawSegments.length) {
    throw new Error("字幕文件里没有正文内容");
  }

  const segments = buildTranscriptSegments(rawSegments);
  const quality = analyzeTranscriptQuality(rawSegments, segments);

  return {
    video: {
      title: view.title || "bilibili-transcript",
      partTitle: page?.part || "",
      bvid,
      aid,
      cid,
      page: page?.page || identity.page || 1
    },
    subtitles,
    selectedIndex,
    selectedSubtitle,
    rawSegments,
    segments,
    quality,
    plainText: formatPlainText(segments),
    timestampText: formatTimestampText(segments),
    srtText: formatSrtText(rawSegments)
  };
}

async function downloadYouTubeSubtitle(url, options = {}) {
  const pageInfo = await fetchYouTubePageInfo(url, options.cookie);
  return buildYouTubeSubtitleResult(url, pageInfo, options);
}

async function downloadYouTubeSubtitleWithBrowser(url, options = {}) {
  const playwright = await importPlaywright();
  const browser = await playwright.chromium.launch({
    channel: options.browserChannel || "chrome",
    headless: !options.headed,
    args: ["--autoplay-policy=no-user-gesture-required"]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    locale: "zh-CN",
    viewport: { width: 1440, height: 960 }
  });

  if (options.cookie) {
    await context.addCookies(cookieHeaderToPlaywrightCookies(options.cookie, ".youtube.com"));
  }

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.browserTimeout
    });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
    await page.waitForTimeout(1500);

    const pageInfo = await page.evaluate(() => {
      function extractJsonObject(text, markerIndex) {
        const start = text.indexOf("{", markerIndex);
        if (start < 0) return "";

        let depth = 0;
        let inString = false;
        let quote = "";
        let escaped = false;

        for (let index = start; index < text.length; index += 1) {
          const char = text[index];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) inString = false;
            continue;
          }

          if (char === "\"" || char === "'") {
            inString = true;
            quote = char;
            continue;
          }

          if (char === "{") depth += 1;
          if (char === "}") depth -= 1;
          if (depth === 0) return text.slice(start, index + 1);
        }

        return "";
      }

      function readPlayerResponse() {
        if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
        for (const script of document.scripts) {
          const text = script.textContent || "";
          const markerIndex = text.indexOf("ytInitialPlayerResponse");
          if (markerIndex < 0) continue;
          const json = extractJsonObject(text, markerIndex);
          if (!json) continue;
          try {
            return JSON.parse(json);
          } catch (error) {
            return null;
          }
        }
        return null;
      }

      const playerResponse = readPlayerResponse();
      return {
        title: playerResponse?.videoDetails?.title || document.title.replace(/ - YouTube$/, "").trim(),
        videoId: playerResponse?.videoDetails?.videoId || new URL(location.href).searchParams.get("v") || "",
        subtitleTracks: playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
      };
    });

    if (!pageInfo.subtitleTracks?.length) {
      const fallback = await fetchYouTubePageInfo(url, options.cookie).catch(() => ({}));
      if (fallback.subtitleTracks?.length) {
        pageInfo.subtitleTracks = fallback.subtitleTracks;
        pageInfo.title ||= fallback.title;
        pageInfo.videoId ||= fallback.videoId;
      }
    }

    return buildYouTubeSubtitleResult(url, pageInfo, options);
  } finally {
    await browser.close().catch(() => null);
  }
}

async function buildYouTubeSubtitleResult(url, pageInfo, options = {}) {
  const identity = parseYouTubeIdentity(url);
  const subtitles = normalizeYouTubeSubtitles(pageInfo.subtitleTracks || []);
  if (!subtitles.length) {
    throw new Error("当前 YouTube 视频没有检测到可下载字幕。请确认播放器里有字幕轨。");
  }

  const selectedIndex = chooseSubtitleIndex(subtitles, options.subtitleIndex);
  const selectedSubtitle = subtitles[selectedIndex];
  const rawSegments = await fetchYouTubeSubtitleSegments(selectedSubtitle.url, options.cookie);
  if (!rawSegments.length) {
    throw new Error("YouTube 字幕文件里没有正文内容");
  }

  const segments = buildTranscriptSegments(rawSegments);
  const quality = analyzeTranscriptQuality(rawSegments, segments);
  const title = pageInfo.title || "youtube-transcript";

  return {
    video: {
      platform: "youtube",
      title,
      partTitle: "",
      videoId: pageInfo.videoId || identity.videoId
    },
    subtitles,
    selectedIndex,
    selectedSubtitle,
    rawSegments,
    segments,
    quality,
    plainText: formatPlainText(segments),
    timestampText: formatTimestampText(segments),
    srtText: formatSrtText(rawSegments)
  };
}

async function downloadSubtitleWithBrowser(url, options = {}) {
  if (isYouTubeUrl(url)) {
    return downloadYouTubeSubtitleWithBrowser(url, options);
  }

  const playwright = await importPlaywright();
  const browser = await playwright.chromium.launch({
    channel: options.browserChannel || "chrome",
    headless: !options.headed,
    args: ["--autoplay-policy=no-user-gesture-required"]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    locale: "zh-CN",
    viewport: { width: 1440, height: 960 }
  });

  if (options.cookie) {
    await context.addCookies(cookieHeaderToPlaywrightCookies(options.cookie));
  }

  const page = await context.newPage();
  const captured = [];
  const resourceUrls = new Set();

  page.on("response", async (response) => {
    const responseUrl = response.url();
    if (!isSubtitleResourceUrl(responseUrl)) return;
    resourceUrls.add(responseUrl);

    try {
      const json = await response.json();
      const rawSegments = normalizeSegments(json.body || json.data?.body || []);
      if (rawSegments.length) {
        captured.push({
          url: responseUrl,
          rawSegments,
          source: "response"
        });
      }
    } catch (error) {
      // Some matched resources are not subtitle JSON or are no longer readable.
    }
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.browserTimeout
    });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
    await activateSubtitleInPage(page);
    await page.waitForTimeout(3500);

    const snapshot = await readBrowserSubtitleSnapshot(page);
    for (const subtitleUrl of snapshot.subtitleResources) {
      resourceUrls.add(subtitleUrl);
    }

    const video = await readVideoFromPageUrl(url, options.cookie, options.page);
    if (snapshot.title) {
      video.title = snapshot.title;
    }

    const candidates = await buildBrowserSubtitleCandidates({
      captured,
      resourceUrls: Array.from(resourceUrls),
      visibleSubtitle: snapshot.visibleSubtitle,
      cookie: options.cookie
    });

    if (!candidates.length) {
      if (snapshot.noSubtitleText) {
        throw new Error("播放器提示该视频没有字幕，未下载任何接口字幕。");
      }

      throw new Error("浏览器模式没有捕获到播放器字幕资源。请确认网页播放器里能打开字幕；若只有画面硬字幕，需要 OCR/语音识别。");
    }

    const selectedIndex = chooseSubtitleIndex(candidates, options.subtitleIndex);
    const selectedSubtitle = candidates[selectedIndex];
    const rawSegments = selectedSubtitle.rawSegments;
    const segments = buildTranscriptSegments(rawSegments);
    const quality = analyzeTranscriptQuality(rawSegments, segments);

    return {
      video,
      subtitles: candidates.map(({ rawSegments: _rawSegments, quality: _quality, ...subtitle }) => subtitle),
      selectedIndex,
      selectedSubtitle: {
        index: selectedSubtitle.index,
        id: selectedSubtitle.id,
        language: selectedSubtitle.language,
        languageName: selectedSubtitle.languageName,
        isAi: selectedSubtitle.isAi,
        sourceType: selectedSubtitle.sourceType,
        url: selectedSubtitle.url
      },
      rawSegments,
      segments,
      quality,
      plainText: formatPlainText(segments),
      timestampText: formatTimestampText(segments),
      srtText: formatSrtText(rawSegments)
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

async function downloadSubtitleUrl(subtitleUrl, options = {}) {
  const video = await readVideoFromPageUrl(options.pageUrl, options.cookie, options.page);
  const normalizedUrl = normalizeSubtitleUrl(subtitleUrl);
  const rawSegments = await fetchAnySubtitleSegments(normalizedUrl, options.cookie);
  if (!rawSegments.length) {
    throw new Error("字幕源 URL 里没有正文内容");
  }

  const segments = buildTranscriptSegments(rawSegments);
  const quality = analyzeTranscriptQuality(rawSegments, segments);

  return {
    video,
    subtitles: [
      {
        index: 0,
        id: null,
        language: "",
        languageName: "指定字幕源",
        isAi: /ai|asr|subtitle|timedtext/i.test(normalizedUrl),
        sourceType: "字幕源",
        url: normalizedUrl
      }
    ],
    selectedIndex: 0,
    selectedSubtitle: {
      index: 0,
      id: null,
      language: "",
      languageName: "指定字幕源",
      isAi: /ai|asr|subtitle|timedtext/i.test(normalizedUrl),
      sourceType: "字幕源",
      url: normalizedUrl
    },
    rawSegments,
    segments,
    quality,
    plainText: formatPlainText(segments),
    timestampText: formatTimestampText(segments),
    srtText: formatSrtText(rawSegments)
  };
}

async function readVideoFromPageUrl(pageUrl, cookie, pageOverride) {
  if (!pageUrl) {
    return {
      title: "bilibili-subtitle",
      partTitle: "",
      bvid: "",
      aid: "",
      cid: "",
      page: 1
    };
  }

  try {
    if (isYouTubeUrl(pageUrl)) {
      const pageInfo = await fetchYouTubePageInfo(pageUrl, cookie).catch(() => ({}));
      return {
        platform: "youtube",
        title: pageInfo.title || "youtube-transcript",
        partTitle: "",
        videoId: pageInfo.videoId || parseYouTubeIdentity(pageUrl).videoId
      };
    }

    const identity = parseVideoIdentity(pageUrl, { page: pageOverride });
    const view = await fetchView(identity, cookie);
    const page = selectPage(identity, view);

    return {
      title: view.title || "bilibili-subtitle",
      partTitle: page?.part || "",
      bvid: view.bvid || identity.bvid || "",
      aid: view.aid || identity.aid || "",
      cid: page?.cid || identity.cid || "",
      page: page?.page || identity.page || 1
    };
  } catch (error) {
    return {
      title: "bilibili-subtitle",
      partTitle: "",
      bvid: "",
      aid: "",
      cid: "",
      page: 1
    };
  }
}

function isYouTubeUrl(urlText = "") {
  try {
    const url = new URL(urlText);
    const host = url.hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch (error) {
    return false;
  }
}

function parseYouTubeIdentity(urlText = "") {
  const identity = { videoId: "" };

  try {
    const url = new URL(urlText);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      identity.videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (host === "youtube.com" || host === "m.youtube.com") {
      identity.videoId = url.searchParams.get("v") || "";
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shortsMatch) identity.videoId = shortsMatch[1];
    }
  } catch (error) {
    // Let the caller surface a clearer no-subtitle error.
  }

  return identity;
}

async function fetchYouTubePageInfo(url, cookie = "") {
  const html = await requestText(url, cookie, {
    referer: "https://www.youtube.com/"
  });
  const playerResponse = extractYouTubePlayerResponse(html);

  return {
    title: playerResponse?.videoDetails?.title || "youtube-transcript",
    videoId: playerResponse?.videoDetails?.videoId || parseYouTubeIdentity(url).videoId,
    subtitleTracks: playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  };
}

function extractYouTubePlayerResponse(text) {
  const markerIndex = String(text || "").indexOf("ytInitialPlayerResponse");
  if (markerIndex < 0) return null;

  const json = extractJsonObject(text, markerIndex);
  if (!json) return null;

  try {
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function normalizeYouTubeSubtitles(items) {
  return items
    .map((item, index) => {
      const url = normalizeSubtitleUrl(item.baseUrl || item.url || "");
      const label = readYouTubeLabel(item.name) || item.languageName || item.languageCode || `字幕 ${index + 1}`;
      const language = item.languageCode || item.language || "";
      const isAi = item.kind === "asr" || /自动|auto-generated|asr/i.test(`${label} ${item.kind || ""}`);

      return {
        index,
        id: item.vssId || item.id || null,
        language,
        languageName: label,
        isAi,
        sourceType: isAi ? "自动字幕" : "字幕",
        url
      };
    })
    .filter((item) => item.url);
}

function readYouTubeLabel(name) {
  if (!name) return "";
  if (typeof name === "string") return name;
  if (name.simpleText) return name.simpleText;
  if (Array.isArray(name.runs)) {
    return name.runs.map((run) => run.text || "").join("");
  }
  return "";
}

function parseVideoIdentity(urlText, options = {}) {
  const identity = {
    bvid: null,
    aid: null,
    cid: null,
    page: options.page || null
  };

  const url = new URL(urlText);
  const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  const aidMatch = url.pathname.match(/\/video\/av(\d+)/i);

  if (bvidMatch) identity.bvid = bvidMatch[1];
  if (aidMatch) identity.aid = aidMatch[1];

  const page = Number(url.searchParams.get("p"));
  if (!identity.page && Number.isFinite(page) && page > 0) {
    identity.page = page;
  }

  const cid = Number(url.searchParams.get("cid"));
  if (Number.isFinite(cid) && cid > 0) {
    identity.cid = cid;
  }

  return identity;
}

async function fetchView(identity, cookie) {
  const params = new URLSearchParams();
  if (identity.bvid) params.set("bvid", identity.bvid);
  if (!identity.bvid && identity.aid) params.set("aid", String(identity.aid));

  const json = await requestJson(`${BILI_API}/x/web-interface/view?${params}`, cookie);
  if (!json.data) throw new Error("没有读取到视频信息");
  return json.data;
}

function selectPage(identity, view) {
  const pages = view?.pages || [];
  const wantedPage = Number(identity.page || 1);
  const cid = Number(identity.cid);

  if (cid) {
    const current = pages.find((item) => Number(item.cid) === cid);
    if (current) return current;
  }

  return pages[Math.max(0, Math.min(pages.length - 1, wantedPage - 1))] || null;
}

async function fetchPlayerInfo({ bvid, aid, cid, cookie }) {
  const params = new URLSearchParams({ cid: String(cid) });
  if (bvid) params.set("bvid", bvid);
  if (!bvid && aid) params.set("aid", String(aid));

  const urls = [
    `${BILI_API}/x/player/v2?${params}`,
    `${BILI_API}/x/player/wbi/v2?${params}`
  ];
  const errors = [];

  for (const url of urls) {
    try {
      const json = await requestJson(url, cookie);
      if (json.data) return json.data;
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`读取字幕列表失败：${errors.join("；")}`);
}

function normalizeSubtitles(items) {
  return items
    .map((item, index) => {
      const url = normalizeSubtitleUrl(item.subtitle_url || item.url || "");
      const marker = `${item.lan || ""} ${item.lan_doc || ""} ${item.ai_type || ""}`;
      const isAi = /ai|自动|智能|ASR/i.test(marker);

      return {
        index,
        id: item.id || null,
        language: item.lan || "",
        languageName: item.lan_doc || item.lan || `字幕 ${index + 1}`,
        isAi,
        sourceType: isAi ? "AI" : "字幕",
        url
      };
    })
    .filter((item) => item.url);
}

function normalizeSubtitleUrl(rawUrl) {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("//")) return `https:${rawUrl}`;
  if (rawUrl.startsWith("http://")) return rawUrl.replace(/^http:\/\//, "https://");
  if (rawUrl.startsWith("/api/timedtext") || rawUrl.startsWith("/timedtext")) return `https://www.youtube.com${rawUrl}`;
  if (rawUrl.startsWith("/")) return `https://www.bilibili.com${rawUrl}`;
  return rawUrl;
}

function isSubtitleResourceUrl(url) {
  return /subtitle|caption|aisub|asr|timedtext/i.test(url) && (/\.json(?:\?|$)/i.test(url) || /aisubtitle|subtitle|caption|timedtext/i.test(url));
}

function chooseSubtitleIndex(subtitles, requestedIndex) {
  const requested = Number(requestedIndex);
  if (Number.isInteger(requested) && requested >= 0 && requested < subtitles.length) {
    return requested;
  }

  const chinese = (item) => /zh|中文|简体|繁体|Chinese/i.test(`${item.language} ${item.languageName}`);
  const aiChinese = subtitles.findIndex((item) => item.isAi && chinese(item));
  if (aiChinese >= 0) return aiChinese;

  const anyChinese = subtitles.findIndex(chinese);
  if (anyChinese >= 0) return anyChinese;

  const anyAi = subtitles.findIndex((item) => item.isAi);
  if (anyAi >= 0) return anyAi;

  return 0;
}

async function fetchSubtitleSegments(url, cookie) {
  const subtitleJson = await requestJson(url, cookie, { skipBiliCodeCheck: true });
  return normalizeSegments(subtitleJson.body || subtitleJson.data?.body || []);
}

async function fetchAnySubtitleSegments(url, cookie) {
  return isYouTubeSubtitleUrl(url)
    ? fetchYouTubeSubtitleSegments(url, cookie)
    : fetchSubtitleSegments(url, cookie);
}

async function fetchYouTubeSubtitleSegments(url, cookie = "") {
  const jsonUrl = withYouTubeCaptionFormat(url, "json3");
  const text = await requestText(jsonUrl, cookie, {
    referer: "https://www.youtube.com/"
  });

  try {
    return normalizeYouTubeJson3Segments(JSON.parse(text));
  } catch (error) {
    return normalizeYouTubeXmlSegments(await requestText(url, cookie, {
      referer: "https://www.youtube.com/"
    }));
  }
}

function isYouTubeSubtitleUrl(url) {
  return /(^|\/\/)(www\.)?youtube\.com\/api\/timedtext|[?&]fmt=json3|timedtext/i.test(url);
}

function withYouTubeCaptionFormat(rawUrl, format) {
  const url = normalizeSubtitleUrl(rawUrl);
  if (/[?&]fmt=/.test(url)) {
    return url.replace(/([?&])fmt=[^&]*/i, `$1fmt=${encodeURIComponent(format)}`);
  }

  return `${url}${url.includes("?") ? "&" : "?"}fmt=${encodeURIComponent(format)}`;
}

function normalizeYouTubeJson3Segments(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const segments = events
    .map((event, index) => {
      const text = cleanText((event.segs || []).map((seg) => seg.utf8 || "").join(""));
      const from = Number(event.tStartMs || 0) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;

      return {
        index: index + 1,
        from,
        to: from + Math.max(duration, 0.8),
        text
      };
    })
    .filter((item) => item.text);

  return removeDuplicateSegments(segments);
}

function normalizeYouTubeXmlSegments(xml) {
  const items = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;

  while ((match = pattern.exec(xml))) {
    const attrs = match[1] || "";
    const from = Number(readXmlAttribute(attrs, "start") || 0);
    const duration = Number(readXmlAttribute(attrs, "dur") || 0);
    const text = cleanText(decodeHtmlEntities(match[2] || ""));

    if (!text) continue;
    items.push({
      index: items.length + 1,
      from: Number.isFinite(from) ? from : 0,
      to: (Number.isFinite(from) ? from : 0) + (Number.isFinite(duration) ? duration : 2),
      text
    });
  }

  return removeDuplicateSegments(items);
}

function readXmlAttribute(attrs, name) {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1] || "";
}

function normalizeSegments(items) {
  const segments = items
    .map((item, index) => {
      const from = Number(item.from || item.start || 0);
      const to = Number(item.to || item.end || from);
      const text = cleanText(item.content || item.text || "");

      return {
        index: index + 1,
        from: Number.isFinite(from) ? from : 0,
        to: Number.isFinite(to) ? to : 0,
        text
      };
    })
    .filter((item) => item.text)
    .sort((left, right) => left.from - right.from || left.index - right.index);

  return removeDuplicateSegments(segments);
}

function removeDuplicateSegments(segments) {
  const result = [];

  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(segment);
      continue;
    }

    const closeInTime = Math.abs(segment.from - previous.from) < 3;
    if (closeInTime && segment.text === previous.text) continue;

    if (closeInTime && previous.text.endsWith(segment.text)) {
      previous.to = Math.max(previous.to, segment.to);
      continue;
    }

    result.push(segment);
  }

  return result.map((segment, index) => ({
    ...segment,
    index: index + 1
  }));
}

function buildTranscriptSegments(segments) {
  const paragraphs = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = { ...segment };
      continue;
    }

    const gap = segment.from - current.to;
    if (shouldStartNewParagraph(current.text, gap)) {
      paragraphs.push(current);
      current = { ...segment, index: paragraphs.length + 1 };
      continue;
    }

    current.text = appendWithOverlap(current.text, segment.text);
    current.to = Math.max(current.to, segment.to);
  }

  if (current) paragraphs.push(current);

  return paragraphs.map((segment, index) => ({
    ...segment,
    index: index + 1,
    text: normalizeParagraphText(segment.text)
  }));
}

function shouldStartNewParagraph(text, gap) {
  const sentenceEnded = /[。！？!?；;]$/.test(text);
  if (gap > 2.5) return true;
  if (text.length >= 190) return true;
  if (sentenceEnded && text.length >= 90) return true;
  if (sentenceEnded && gap > 0.8) return true;
  return false;
}

function appendWithOverlap(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;

  const maxOverlap = Math.min(24, left.length, right.length);
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return left + right.slice(length);
    }
  }

  return needsSpaceBetween(left, right) ? `${left} ${right}` : left + right;
}

function needsSpaceBetween(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function normalizeParagraphText(text) {
  return cleanText(text)
    .replace(/\s+([，。！？、；：,.!?;:])/g, "$1")
    .replace(/([（【《])\s+/g, "$1")
    .replace(/\s+([）】》])/g, "$1");
}

function analyzeTranscriptQuality(rawSegments, mergedSegments) {
  const texts = rawSegments.map((segment) => segment.text).filter(Boolean);
  const mergedText = mergedSegments.map((segment) => segment.text).join("");
  const musicLikeCount = texts.filter(isMusicLikeText).length;
  const meaningfulText = stripNonMeaningfulChars(mergedText);
  const musicLikeRatio = texts.length ? musicLikeCount / texts.length : 0;
  const uniqueChars = new Set(meaningfulText).size;

  const unusable = texts.length > 0 && (
    musicLikeRatio >= 0.6 ||
    meaningfulText.length < 20 ||
    (meaningfulText.length < 80 && uniqueChars <= 6)
  );

  return {
    usable: !unusable,
    musicLikeRatio,
    meaningfulChars: meaningfulText.length,
    warning: unusable
      ? "字幕轨几乎没有有效文字，画面里的硬字幕需要 OCR 或语音识别提取。"
      : ""
  };
}

function isMusicLikeText(text) {
  const normalized = stripNonMeaningfulChars(text).toLowerCase();
  if (!normalized) return true;
  return /^(音乐|音樂|music|bgm|配乐|配樂|音效|掌声|掌聲|笑声|笑聲|无声|無聲|噪音|嗯|啊|呃|哦|哈)+$/i.test(normalized);
}

function stripNonMeaningfulChars(text) {
  return String(text || "")
    .replace(/[♪♫♬♩♭♮♯]/g, "")
    .replace(/[\s\d，。,.!?！？、~～…·\-—_（）()【】[\]{}<>《》"'“”‘’:：;；/\\|+*=#@￥$%^&`]/g, "")
    .trim();
}

function normalizeForMatch(text) {
  return String(text || "")
    .replace(/[\s\d，。,.!?！？、~～…·\-—_（）()【】[\]{}<>《》"'“”‘’:：;；/\\|+*=#@￥$%^&`♪♫♬♩]/g, "")
    .trim();
}

function formatContent(format, result) {
  if (format === "txt") return `${result.plainText}\n`;
  if (format === "srt") return `${result.srtText}\n`;
  if (format === "json") {
    return `${JSON.stringify({
      video: result.video,
      selectedSubtitle: result.selectedSubtitle,
      quality: result.quality,
      segments: result.segments,
      rawSegments: result.rawSegments
    }, null, 2)}\n`;
  }
  throw new Error(`不支持的格式：${format}`);
}

function formatPlainText(segments) {
  return segments.map((segment) => segment.text).join("\n\n");
}

function formatTimestampText(segments) {
  return segments.map((segment) => `[${formatClock(segment.from)}] ${segment.text}`).join("\n");
}

function formatSrtText(segments) {
  return segments
    .map((segment, index) => {
      return [
        String(index + 1),
        `${formatSrtClock(segment.from)} --> ${formatSrtClock(segment.to || segment.from + 2)}`,
        segment.text
      ].join("\n");
    })
    .join("\n\n");
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const parts = hour > 0 ? [hour, minute, second] : [minute, second];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function formatSrtClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hour = Math.floor(value / 3600);
  const minute = Math.floor((value % 3600) / 60);
  const second = Math.floor(value % 60);
  const millisecond = Math.floor((value - Math.floor(value)) * 1000);

  return [
    String(hour).padStart(2, "0"),
    String(minute).padStart(2, "0"),
    String(second).padStart(2, "0")
  ].join(":") + `,${String(millisecond).padStart(3, "0")}`;
}

function cleanText(text) {
  return String(text)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(name) {
  const cleaned = String(name || "bilibili-transcript")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 120) || "bilibili-transcript";
}

async function requestJson(url, cookie = "", options = {}) {
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.bilibili.com/",
    "User-Agent": "Mozilla/5.0"
  };
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    headers,
    cache: "no-store"
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${basename(url)} 返回内容不是 JSON`);
  }

  if (!options.skipBiliCodeCheck && typeof json.code === "number" && json.code !== 0) {
    throw new Error(json.message || `B站接口返回 code=${json.code}`);
  }

  return json;
}

async function requestText(url, cookie = "", options = {}) {
  const headers = {
    "Accept": "application/json, text/xml, text/plain, */*",
    "Referer": options.referer || "https://www.bilibili.com/",
    "User-Agent": "Mozilla/5.0"
  };
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    headers,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function extractJsonObject(text, markerIndex) {
  const start = text.indexOf("{", markerIndex);
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return "";
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    "#39": "'"
  };

  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    const key = body.toLowerCase();
    if (named[key]) return named[key];
    if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return entity;
  });
}

function printSubtitleList(result) {
  console.log(`视频：${result.video.title}`);
  if (result.video.videoId) console.log(`videoId：${result.video.videoId}`);
  if (result.video.bvid) console.log(`bvid：${result.video.bvid}`);
  if (result.video.cid) console.log(`cid：${result.video.cid}`);
  console.log("字幕列表：");
  for (const subtitle of result.subtitles) {
    console.log(`- [${subtitle.index}] ${subtitle.languageName} · ${subtitle.isAi ? "AI" : "字幕"}`);
  }
}

function printHelp() {
  console.log(`
用法：
  node scripts/download-subtitle.mjs "<B站或 YouTube 视频URL>" [选项]

选项：
  -o, --out <目录>             输出目录，默认 downloads
  -f, --format <格式>          txt、srt、json 或 all，默认 all
  -p, --page <页码>            多 P 视频页码
  -i, --subtitle-index <序号>  指定字幕序号，默认自动选择中文/AI
      --list                   只列出字幕，不写文件
      --subtitle-url <URL>     直接下载指定字幕 JSON URL，适合配合页面插件复制的命令
      --allow-api              跳过浏览器抓取，直接使用平台页面/接口字幕；B 站可能和播放器画面字幕不一致
      --headed                 浏览器抓取时显示 Chrome 窗口，方便观察
      --browser-timeout <毫秒> 浏览器页面加载超时，默认 20000
      --browser-channel <名称> Playwright 浏览器 channel，默认 chrome
      --cookie <Cookie>        传入 B 站登录 Cookie
      --cookie-file <文件>     从文件读取 B 站登录 Cookie
  -h, --help                   显示帮助

示例：
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
  node scripts/download-subtitle.mjs "https://www.youtube.com/watch?v=xxxxxxxxxxx"
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --headed
  node scripts/download-subtitle.mjs "https://www.youtube.com/watch?v=xxxxxxxxxxx" --format txt --out ./downloads
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --allow-api
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --cookie-file ./bili.cookie.txt
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --subtitle-url "https://..."

也可以用环境变量传 Cookie：
  BILI_COOKIE="SESSDATA=..." node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
`.trim());
}
