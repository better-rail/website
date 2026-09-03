#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARTICLES_FILE = path.join(__dirname, "..", "media", "articles.js");
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const HEBREW_MONTHS = [
  "בינואר",
  "בפברואר",
  "במרץ",
  "באפריל",
  "במאי",
  "ביוני",
  "ביולי",
  "באוגוסט",
  "בספטמבר",
  "באוקטובר",
  "בנובמבר",
  "בדצמבר",
];

function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatHebrewDate(date) {
  const d = date.getDate();
  const m = HEBREW_MONTHS[date.getMonth()];
  const y = date.getFullYear();
  return `${d} ${m} ${y}`;
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']og:${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, "i"),
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

function extractTitle(html) {
  const ogTitle = extractMeta(html, "title");
  if (ogTitle) return ogTitle;

  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]) : "";
}

function cleanTitle(title, outlet) {
  if (!title) return "";
  let cleaned = decodeHtmlEntities(title);

  if (outlet) {
    const regex = new RegExp(`\\s*[\\|\\-–—•]\\s*${escapeRegExp(outlet)}$`, "i");
    cleaned = cleaned.replace(regex, "").trim();
  }

  return cleaned;
}

function extractPublishedDate(url, html) {
  const datePatterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:)?article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:)?article:published_time["']/i,
    /<meta[^>]+(?:property|name)=["'](?:publishdate|pubdate|datepublished|dc\.date|article:modified_time)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:publishdate|pubdate|datepublished|dc\.date|article:modified_time)["']/i,
    /"datePublished":\s*["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];

  for (const regex of datePatterns) {
    const match = html.match(regex);
    if (match?.[1]) {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }

  const urlMatch = url.match(/\/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (urlMatch) {
    const year = parseInt(urlMatch[1], 10);
    const month = parseInt(urlMatch[2], 10) - 1;
    const day = parseInt(urlMatch[3], 10);
    const parsed = new Date(year, month, day);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function extractWebsiteLogo(parsedUrl, html) {
  // 1. Apple touch icon / high-resolution touch icon (standardized for both light & dark)
  const appleTouchMatch = html.match(/<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)["']/i);
  if (appleTouchMatch?.[1]) {
    try {
      return new URL(appleTouchMatch[1], parsedUrl.origin).toString();
    } catch {}
  }

  // 2. High-res icon (192x192, 180x180, etc.)
  const largeIconMatch =
    html.match(
      /<link[^>]+rel=["']icon["'][^>]+sizes=["'](?:192x192|180x180|144x144|128x128|96x96)["'][^>]+href=["']([^"']+)["']/i,
    ) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+sizes=["'](?:192x192|180x180|144x144|128x128|96x96)["']/i);
  if (largeIconMatch?.[1]) {
    try {
      return new URL(largeIconMatch[1], parsedUrl.origin).toString();
    } catch {}
  }

  // 3. JSON-LD publisher logo
  const jsonLdMatch =
    html.match(/"publisher"[^}]*"logo"[^}]*"url":\s*"([^"]+)"/i) ||
    html.match(/"logo":\s*\{\s*"@type":\s*"ImageObject",\s*"url":\s*"([^"]+)"/i) ||
    html.match(/"publisher"[^}]*"logo":\s*"([^"]+)"/i);
  if (jsonLdMatch?.[1]) {
    try {
      return new URL(jsonLdMatch[1].replace(/\\/g, ""), parsedUrl.origin).toString();
    } catch {}
  }

  // 4. In-page logo img tag (header/nav logo)
  const headerSection = html.match(/<header[\s\S]*?<\/header>/i)?.[0] || html.slice(0, 25000);
  const logoImgMatch =
    headerSection.match(/<img[^>]+src=["']([^"']*logo[^"']*\.(?:svg|png|webp|avif)(?:\?[^"']*)?)["']/i) ||
    html.match(/<img[^>]+src=["']([^"']*logo[^"']*\.(?:svg|png|webp|avif)(?:\?[^"']*)?)["']/i);
  if (logoImgMatch?.[1]) {
    try {
      const cleanLogo = logoImgMatch[1].replace(/-sm(\.[a-z]+)/i, "$1");
      return new URL(cleanLogo, parsedUrl.origin).toString();
    } catch {}
  }

  // 4. OpenGraph logo tag
  const ogLogoMatch = html.match(/<meta[^>]+property=["'](?:og:logo|logo)["'][^>]+content=["']([^"']+)["']/i);
  if (ogLogoMatch?.[1]) {
    try {
      return new URL(ogLogoMatch[1], parsedUrl.origin).toString();
    } catch {}
  }

  // 5. Universal Google high-res 256px favicon fallback
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${parsedUrl.hostname}&size=256`;
}

async function fetchPageHtml(targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he,en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP status ${res.status} (${res.statusText})`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function loadArticles(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const code = fs.readFileSync(filePath, "utf8");
  const context = { window: {} };
  vm.createContext(context);

  try {
    vm.runInContext(code, context);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }

  if (!Array.isArray(context.window?.MEDIA_ARTICLES)) {
    throw new Error(`window.MEDIA_ARTICLES is not an array in ${filePath}`);
  }

  return context.window.MEDIA_ARTICLES;
}

function saveArticles(filePath, articles) {
  const serialized = JSON.stringify(articles, null, 2);
  const content = `window.MEDIA_ARTICLES = ${serialized};\n`;
  fs.writeFileSync(filePath, content, "utf8");
}

async function addArticle(inputUrl, outlet) {
  let parsedUrl;
  try {
    parsedUrl = new URL(inputUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Protocol must be http: or https:");
    }
  } catch (err) {
    console.error(`Error: Invalid URL: ${err.message}`);
    process.exit(1);
  }

  const normalizedUrl = parsedUrl.toString();
  console.log(`Fetching data from: ${normalizedUrl}...`);

  let html;
  try {
    html = await fetchPageHtml(normalizedUrl);
  } catch (err) {
    console.error(`Error fetching URL: ${err.message}`);
    process.exit(1);
  }

  const rawTitle = extractTitle(html);
  const title = cleanTitle(rawTitle, outlet);
  const excerpt = extractMeta(html, "description") || "";
  const image = manualImage || extractWebsiteLogo(parsedUrl, html);
  const dateObj = extractPublishedDate(normalizedUrl, html);
  const formattedDate = formatHebrewDate(dateObj);

  console.log("\nArticle details found:");
  console.log(`  Title: ${title}`);
  console.log(`  Outlet: ${outlet}`);
  console.log(`  Date: ${formattedDate}`);
  console.log(`  Excerpt: ${excerpt.slice(0, 90)}${excerpt.length > 90 ? "..." : ""}`);
  console.log(`  Image: ${image || "None"}`);

  let articles;
  try {
    articles = loadArticles(ARTICLES_FILE);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (articles.some((a) => a.url === normalizedUrl || a.url === inputUrl)) {
    console.log("\nWarning: Article already exists in media/articles.js.");
    return;
  }

  articles.push({
    title,
    outlet,
    date: formattedDate,
    datetime: dateObj.toISOString(),
    url: normalizedUrl,
    image,
    excerpt,
  });

  articles.sort((a, b) => {
    const timeA = new Date(a.datetime || a.date || 0).getTime();
    const timeB = new Date(b.datetime || b.date || 0).getTime();
    return timeB - timeA;
  });

  try {
    saveArticles(ARTICLES_FILE, articles);
    console.log("\nArticle successfully added to media/articles.js (sorted by date).");
  } catch (err) {
    console.error(`Error saving articles: ${err.message}`);
    process.exit(1);
  }
}

const inputUrl = process.argv[2];
const outlet = process.argv[3];
const manualImage = process.argv[4];

if (!inputUrl || !outlet) {
  console.error("Error: Please provide both an article URL and an outlet name.");
  console.log("Usage example:");
  console.log('  node scripts/add-article.js "https://example.com/article" "שם המקור" [תמונה]');
  process.exit(1);
}

addArticle(inputUrl, outlet.trim());
