#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const MEDIA_PAGE = path.join(__dirname, "..", "media", "index.html");
const ICONS_DIR = path.join(__dirname, "..", "assets", "media");
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
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length >= 3 && parts[parts.length - 1] === "il") {
    return parts[parts.length - 3];
  }
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

function cleanTitle(title, outlet) {
  if (!title) return "";
  let cleaned = decodeHtmlEntities(title);
  if (outlet) {
    const escaped = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s*[|\\-–—•]\\s*${escaped}(?:\\.[a-z0-9.-]+)?$`, "i"), "").trim();
  }
  return cleaned
    .replace(/\s*[|\-–—•]\s*(?:גיקטיים|כלכליסט|כיפה|בבלי|היום|ישראל היום|וואלה(?: רכב)?|רכב ותחבורה|חדשות|גלובס|מאקו)\s*$/, "")
    .trim();
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

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function extensionFor(contentType = "", url = "") {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const byType = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  };
  if (byType[type]) return byType[type];
  const m = new URL(url).pathname.match(/\.(png|jpe?g|svg|webp|gif|ico)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

async function downloadIcon(imageUrl, outlet) {
  const existing = fs.readdirSync(ICONS_DIR).find((f) => f.replace(/\.[^.]+$/, "") === outlet);
  if (existing) return `/assets/media/${existing}`;

  const res = await fetch(imageUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Icon download failed: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString("hex");
  const ext = magic === "89504e47" ? "png" : extensionFor(res.headers.get("content-type") || "", imageUrl);
  const fileName = `${outlet}.${ext}`;
  fs.writeFileSync(path.join(ICONS_DIR, fileName), buf);
  return `/assets/media/${fileName}`;
}

const OUTLET_NAMES = {
  mako: "מאקו",
  walla: "וואלה",
  israelhayom: "ישראל היום",
  calcalist: "כלכליסט",
  themarker: "TheMarker",
  globes: "גלובס",
  inn: "ערוץ 7",
  kikar: "כיכר השבת",
  geektime: "גיקטיים",
  kipa: "כיפה",
  ice: "ICE",
  babli: "בבלי",
  ynet: "ynet",
  haaretz: "הארץ",
  maariv: "מעריב",
  n12: "N12",
};

function renderListItem({ outlet, url, title, icon, date, dateObj }) {
  const isoDate = dateObj.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  return [
    "        <li>",
    `          <a class="media-card" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`,
    `            <img class="media-card-icon" src="${icon}" alt="" width="36" height="36" loading="lazy" decoding="async" />`,
    '            <span class="media-card-body">',
    `              <span class="media-card-title">${escapeHtml(title)}</span>`,
    '              <span class="media-card-meta">',
    `                <span class="media-card-outlet">${escapeHtml(OUTLET_NAMES[outlet] || outlet)}</span>`,
    '                <span class="media-card-sep" aria-hidden="true">·</span>',
    `                <time datetime="${isoDate}">${escapeHtml(date)}</time>`,
    "              </span>",
    "            </span>",
    "          </a>",
    "        </li>",
  ].join("\n");
}

function insertIntoMediaPage(article) {
  const html = fs.readFileSync(MEDIA_PAGE, "utf8");
  const marker = '<ul class="media-list">';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${marker} in ${MEDIA_PAGE}`);
  const insertAt = start + marker.length;
  fs.writeFileSync(MEDIA_PAGE, `${html.slice(0, insertAt)}\n${renderListItem(article)}${html.slice(insertAt)}`, "utf8");
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
  const image = manualImage || extractWebsiteLogo(parsedUrl, html);
  const dateObj = extractPublishedDate(normalizedUrl, html);
  const date = dateObj.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });

  console.log(`\nArticle details found:`);
  console.log(`  Title: ${title}`);
  console.log(`  Outlet: ${outlet}`);
  console.log(`  Date: ${date}`);
  console.log(`  Image: ${image || "None"}`);

  if (fs.readFileSync(MEDIA_PAGE, "utf8").includes(`href="${escapeHtml(normalizedUrl)}"`)) {
    console.log("\nWarning: Article already exists in media/index.html.");
    return;
  }

  const icon = await downloadIcon(image, outlet);
  insertIntoMediaPage({ outlet, url: normalizedUrl, title, icon, date, dateObj });
  console.log(`\nArticle added to the top of media/index.html (icon: ${icon}).`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
