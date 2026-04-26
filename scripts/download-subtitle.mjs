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
  if (options.help || !options.url) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const cookie = await readCookie(options);
  const result = await downloadSubtitle(options.url, {
    cookie,
    page: options.page,
    subtitleIndex: options.subtitleIndex
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
  if (rawUrl.startsWith("/")) return `https://www.bilibili.com${rawUrl}`;
  return rawUrl;
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
      ? "B站返回的字幕轨几乎没有有效文字，画面里的硬字幕需要 OCR 或语音识别提取。"
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

function printSubtitleList(result) {
  console.log(`视频：${result.video.title}`);
  console.log(`bvid：${result.video.bvid}`);
  console.log(`cid：${result.video.cid}`);
  console.log("字幕列表：");
  for (const subtitle of result.subtitles) {
    console.log(`- [${subtitle.index}] ${subtitle.languageName} · ${subtitle.isAi ? "AI" : "字幕"}`);
  }
}

function printHelp() {
  console.log(`
用法：
  node scripts/download-subtitle.mjs "<B站视频URL>" [选项]

选项：
  -o, --out <目录>             输出目录，默认 downloads
  -f, --format <格式>          txt、srt、json 或 all，默认 all
  -p, --page <页码>            多 P 视频页码
  -i, --subtitle-index <序号>  指定字幕序号，默认自动选择中文/AI
      --list                   只列出字幕，不写文件
      --cookie <Cookie>        传入 B 站登录 Cookie
      --cookie-file <文件>     从文件读取 B 站登录 Cookie
  -h, --help                   显示帮助

示例：
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --format txt --out ./downloads
  node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --cookie-file ./bili.cookie.txt

也可以用环境变量传 Cookie：
  BILI_COOKIE="SESSDATA=..." node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
`.trim());
}
