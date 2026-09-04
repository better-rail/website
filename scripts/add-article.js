#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ARTICLES_FILE = path.join(__dirname, "..", "media", "articles.js");
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function decodeHtmlEntities(text = "") {
  return text
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

function extractMeta(html, ...keys) {
  for (const key of keys) {
    const m =
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:og:)?${key}["'][^>]+content=["']([^"']+)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:)?${key}["']`, "i"));
    if (m?.[1]) return decodeHtmlEntities(m[1]);
  }
  return "";
}

function extractTitle(html) {
  const og = extractMeta(html, "title");
  if (og) return og;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function extractBaseDomain(hostname = "") {
  return hostname.toLowerCase().replace(/^www\./, "").split(".")[0];
}

function cleanTitle(title, outlet) {
  if (!title) return "";
  let cleaned = decodeHtmlEntities(title);
  if (outlet) {
    const escaped = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s*[|\\-–—•]\\s*${escaped}(?:\\.[a-z0-9.-]+)?$`, "i"), "").trim();
  }
  return cleaned;
}

function extractPublishedDate(url, html) {
  const raw =
    extractMeta(html, "article:published_time", "publishdate", "pubdate", "datepublished", "dc.date", "article:modified_time") ||
    html.match(/"datePublished":\s*["']([^"']+)["']/i)?.[1] ||
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];

  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }

  const urlMatch = url.match(/\/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (urlMatch) {
    const d = new Date(urlMatch[1], urlMatch[2] - 1, urlMatch[3]);
    if (!isNaN(d.getTime())) return d;
  }

  return new Date();
}

function findLinkHref(html, relPattern) {
  const m =
    html.match(new RegExp(`<link[^>]+rel=["']${relPattern}["'][^>]+href=["']([^"']+)["']`, "i")) ||
    html.match(new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${relPattern}["']`, "i"));
  return m?.[1] || "";
}

function resolveUrl(href, base) {
  try {
    return href ? new URL(href, base).toString() : "";
  } catch {
    return "";
  }
}

function extractWebsiteLogo(parsedUrl, html) {
  const origin = parsedUrl.origin;

  // 1. Touch icon or standard favicon
  const iconHref =
    findLinkHref(html, "apple-touch-icon(?:-precomposed)?") ||
    findLinkHref(html, "(?:shortcut )?icon");
  const icon = resolveUrl(iconHref, origin);
  if (icon) return icon;

  // 2. High-res icon with explicit sizes
  const largeIconHref =
    html.match(/<link[^>]+rel=["']icon["'][^>]+sizes=["']\d+x\d+["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+sizes=["']\d+x\d+["']/i)?.[1];
  const largeIcon = resolveUrl(largeIconHref, origin);
  if (largeIcon) return largeIcon;

  // 3. Structured data / OpenGraph logo (ignore white/dark-mode assets)
  const jsonLd = html.match(/"logo":\s*(?:\{\s*"@type":\s*"ImageObject",\s*"url":\s*"([^"]+)"|"([^"]+)")/i);
  const logoCandidate = jsonLd?.[1] || jsonLd?.[2] || extractMeta(html, "logo");
  if (logoCandidate && !/(?:white|negative|dark[-_]mode)/i.test(logoCandidate)) {
    const logo = resolveUrl(logoCandidate.replace(/\\/g, ""), origin);
    if (logo) return logo;
  }

  // 4. Google favicon service fallback
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${parsedUrl.hostname}&size=256`;
}

async function fetchPageHtml(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "he,en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText})`);
  }

  return res.text();
}

function loadArticles(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const context = { window: {} };
  vm.runInNewContext(code, context);

  if (!Array.isArray(context.window?.MEDIA_ARTICLES)) {
    throw new Error(`window.MEDIA_ARTICLES is not an array in ${filePath}`);
  }

  return context.window.MEDIA_ARTICLES;
}

function saveArticles(filePath, articles) {
  fs.writeFileSync(filePath, `window.MEDIA_ARTICLES = ${JSON.stringify(articles, null, 2)};\n`, "utf8");
}

async function main() {
  const [, , inputUrl, arg3, arg4] = process.argv;

  if (!inputUrl) {
    console.error("Error: Please provide an article URL.\n\nUsage:\n  node scripts/add-article.js <url> [site_name/outlet] [image_url]");
    process.exit(1);
  }

  const isArg3Url = arg3 && /^https?:\/\//i.test(arg3);
  const manualOutlet = isArg3Url ? undefined : arg3?.trim();
  const manualImage = isArg3Url ? arg3 : arg4;

  let parsedUrl;
  try {
    parsedUrl = new URL(inputUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Protocol must be http: or https:");
    }
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }

  const outlet = manualOutlet || extractBaseDomain(parsedUrl.hostname);
  const normalizedUrl = parsedUrl.toString();

  console.log(`Fetching data from: ${normalizedUrl}...`);
  const html = await fetchPageHtml(normalizedUrl);

  const title = cleanTitle(extractTitle(html), outlet);
  const excerpt = extractMeta(html, "description");
  const image = manualImage || extractWebsiteLogo(parsedUrl, html);
  const dateObj = extractPublishedDate(normalizedUrl, html);
  const date = dateObj.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });

  console.log(`\nArticle details found:`);
  console.log(`  Title: ${title}`);
  console.log(`  Outlet: ${outlet}`);
  console.log(`  Date: ${date}`);
  console.log(`  Excerpt: ${excerpt.slice(0, 90)}${excerpt.length > 90 ? "..." : ""}`);
  console.log(`  Image: ${image || "None"}`);

  const articles = loadArticles(ARTICLES_FILE);
  if (articles.some((a) => a.url === normalizedUrl || a.url === inputUrl)) {
    console.log("\nWarning: Article already exists in media/articles.js.");
    return;
  }

  articles.push({
    title,
    outlet,
    date,
    datetime: dateObj.toISOString(),
    url: normalizedUrl,
    image,
    excerpt,
  });

  articles.sort((a, b) => new Date(b.datetime || b.date || 0) - new Date(a.datetime || a.date || 0));
  saveArticles(ARTICLES_FILE, articles);
  console.log("\nArticle successfully added to media/articles.js (sorted by date).");
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
