// server.js (ESM)
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { load } from "cheerio";
import { URL } from "url";
import lighthouse from "lighthouse";
import { launch as chromeLauncher } from "chrome-launcher";
import { GoogleSearch } from "google-search-results-nodejs";

dotenv.config();
const app = express();
app.use(express.json());

const DEBUG = process.env.DEBUG === "true";
const fetch = global.fetch;

// --- quick env check ---
const required = ["GEMINI_API_KEY"];
const present = required.filter((k) => !!process.env[k]);
const missing = required.filter((k) => !present.includes(k));
if (missing.length) {
  console.warn("WARNING: missing required env vars:", missing.join(", "));
}

// AI client
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

// SERP client (optional)
let serpClient = null;
if (process.env.SERP_API_KEY) {
  serpClient = new GoogleSearch(process.env.SERP_API_KEY);
} else {
  console.warn(
    "No SERP_API_KEY provided — SERP-derived metrics will be N/A or best-effort."
  );
}

// Helpers
function getGrade(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function timeoutPromise(p, ms, fallback) {
  return Promise.race([
    p,
    new Promise((resolve) =>
      setTimeout(() => resolve({ __timed_out: true, ...fallback }), ms)
    ),
  ]);
}

// ---------- External helpers ----------
async function getOpenPageRank(domain) {
  const url = `https://openpagerank.com/api/v1.0/getPageRank?domains[]=${domain}`;
  try {
    const res = await timeoutPromise(
      fetch(url, {
        headers: { "API-OPR": process.env.OPR_API_KEY || "" },
      }),
      8000,
      { ok: false }
    );

    if (!res || res.__timed_out) {
      return {
        domainRating: "N/A",
        referringDomains: "N/A",
        reason: "timeout",
      };
    }
    const data = await res.json();
    if (DEBUG) console.debug("OpenPageRank raw:", data);
    if (data && data.response && data.response[0]) {
      return {
        domainRating: data.response[0].page_rank_decimal ?? "N/A",
        referringDomains: data.response[0].rank ?? "N/A",
      };
    } else {
      return {
        domainRating: "N/A",
        referringDomains: "N/A",
        reason: "no-data",
      };
    }
  } catch (err) {
    console.warn("OpenPageRank error:", err.message);
    return {
      domainRating: "N/A",
      referringDomains: "N/A",
      reason: err.message,
    };
  }
}

async function getLighthouseScore(urlToAudit) {
  try {
    const chrome = await chromeLauncher({
      chromeFlags: ["--headless", "--no-sandbox"],
    });
    const options = {
      port: chrome.port,
      onlyCategories: ["performance", "seo"],
    };
    const result = await timeoutPromise(
      lighthouse(urlToAudit, options),
      30000,
      null
    );

    await chrome.kill();

    if (!result || result.__timed_out) {
      return { score: null, performance: null, seo: null, reason: "timeout" };
    }

    const perfScore = Math.round(
      (result.lhr.categories.performance.score || 0) * 100
    );
    const seoScore = Math.round((result.lhr.categories.seo.score || 0) * 100);
    const avg = Math.round((perfScore + seoScore) / 2 || perfScore || seoScore);

    const out = { score: avg, performance: perfScore, seo: seoScore };
    if (DEBUG)
      out._lighthouse = {
        requestedUrl: result.lhr.finalUrl,
        categories: result.lhr.categories,
      };
    return out;
  } catch (err) {
    console.warn("Lighthouse error:", err.message);
    return { score: null, performance: null, seo: null, reason: err.message };
  }
}

async function getKeywordDataViaSerp(keywordOrDomain) {
  if (!serpClient)
    return {
      topResult: "N/A",
      position: "N/A",
      totalResults: "N/A",
      reason: "no-serp-key",
    };

  const params = { q: keywordOrDomain, location: "United States", hl: "en" };
  return new Promise((resolve) => {
    const t = setTimeout(
      () =>
        resolve({
          topResult: "N/A",
          position: "N/A",
          totalResults: "N/A",
          reason: "timeout",
        }),
      10000
    );
    try {
      serpClient.json(params, (data) => {
        clearTimeout(t);
        if (DEBUG) console.debug("SerpApi raw:", data);
        try {
          const top = data?.organic_results?.[0];
          return resolve({
            topResult: top?.title ?? "N/A",
            position: top?.position ?? "N/A",
            totalResults: data?.search_information?.total_results ?? "N/A",
            raw: DEBUG ? data : undefined,
          });
        } catch (e) {
          return resolve({
            topResult: "N/A",
            position: "N/A",
            totalResults: "N/A",
            reason: e.message,
          });
        }
      });
    } catch (err) {
      clearTimeout(t);
      console.warn("SERP client error:", err.message);
      resolve({
        topResult: "N/A",
        position: "N/A",
        totalResults: "N/A",
        reason: err.message,
      });
    }
  });
}

function extractTopKeywordFromHtml(html, domain, suppliedKeyword) {
  try {
    const $ = load(html);
    if (suppliedKeyword)
      return {
        topResult: suppliedKeyword,
        position: "N/A",
        totalResults: "N/A",
        source: "user-supplied",
      };

    const metaKw = $('meta[name="keywords"]').attr("content");
    if (metaKw)
      return {
        topResult: metaKw.split(",")[0].trim(),
        position: "N/A",
        totalResults: "N/A",
        source: "meta-keywords",
      };

    const title = $("title").text().trim();
    if (title)
      return {
        topResult: title,
        position: "N/A",
        totalResults: "N/A",
        source: "title",
      };

    return {
      topResult: domain,
      position: "N/A",
      totalResults: "N/A",
      source: "domain-fallback",
    };
  } catch (e) {
    return {
      topResult: "N/A",
      position: "N/A",
      totalResults: "N/A",
      reason: e.message,
    };
  }
}

// --- New checks ---
async function checkRobotsTxt(hostname) {
  try {
    const res = await timeoutPromise(
      fetch(`https://${hostname}/robots.txt`),
      5000,
      null
    );
    if (res && res.ok) return "Present";
    return "Missing";
  } catch {
    return "Missing";
  }
}

async function checkSitemap(hostname, $) {
  try {
    const fromLink = $("link[rel='sitemap']").attr("href");
    if (fromLink) return fromLink;

    const res = await timeoutPromise(
      fetch(`https://${hostname}/sitemap.xml`),
      5000,
      null
    );
    if (res && res.ok) return `https://${hostname}/sitemap.xml`;
    return "Not found";
  } catch {
    return "Not found";
  }
}

async function checkBrokenLinks($, hostname) {
  const links = $("a[href^='http']")
    .map((i, el) => $(el).attr("href"))
    .get();
  const broken = [];
  const limited = links.slice(0, 20); // limit for performance

  await Promise.all(
    limited.map(async (href) => {
      try {
        const res = await timeoutPromise(
          fetch(href, { method: "HEAD" }),
          5000,
          null
        );
        if (!res || res.__timed_out || !res.ok) broken.push(href);
      } catch {
        broken.push(href);
      }
    })
  );
  return broken;
}

app.get("/", (req, res) => {
  res.send("SEO Checker API is running. Use the /api/seo-checker endpoint.");
});

// ------------------- endpoint -------------------
app.post("/api/seo-checker", async (req, res) => {
  const debugPayload = {};
  try {
    const { url, keyword = "" } = req.body || {};
    if (!url) return res.status(400).json({ error: "URL is required" });

    const hostname = new URL(url).hostname;

    // fetch HTML
    let html = "";
    let pageResponse = null;
    try {
      pageResponse = await timeoutPromise(
        fetch(url, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (seo-checker)" },
        }),
        15000,
        null
      );
      if (pageResponse?.ok) {
        html = await pageResponse.text();
      }
    } catch {}

    // parallel metrics
    const [oprMetrics, lighthouseResult, serpResultOrPlaceholder] =
      await Promise.all([
        getOpenPageRank(hostname),
        getLighthouseScore(url),
        process.env.SERP_API_KEY
          ? getKeywordDataViaSerp(keyword || hostname)
          : extractTopKeywordFromHtml(html, hostname, keyword),
      ]);

    const $ = load(html || "<html></html>");
    const text = $("body").text().replace(/\s+/g, " ").trim();
    const wordCount = text ? text.split(" ").filter(Boolean).length : 0;

    // keyword density
    let keywordDensity = "Not checked";
    if (keyword && wordCount > 0) {
      const matches = (text.match(new RegExp(`\\b${keyword}\\b`, "gi")) || [])
        .length;
      keywordDensity = ((matches / wordCount) * 100).toFixed(2) + "%";
    }

    // title/meta
    const title = $("title").text() || "";
    const metaDesc = $('meta[name="description"]').attr("content") || "";

    // headings
    const h1s = $("h1").length;
    const allHeadings = $("h1,h2,h3,h4,h5,h6").length;

    // images
    const images = $("img").toArray();
    let missingAlts = 0;
    let largeImages = 0;
    for (const img of images) {
      const alt = $(img).attr("alt");
      if (!alt) missingAlts++;
      const src = $(img).attr("src");
      if (src && /^https?:/.test(src)) {
        try {
          const headRes = await timeoutPromise(
            fetch(src, { method: "HEAD" }),
            8000,
            null
          );
          if (headRes?.ok) {
            const size = parseInt(headRes.headers.get("content-length") || "0");
            if (size > 200 * 1024) largeImages++;
          }
        } catch {}
      }
    }

    // links
    const internalLinks = $(`a[href*='${hostname}'], a[href^='/']`).length;
    const externalLinks = $("a[href^='http']").filter(
      (i, el) => !$(el).attr("href").includes(hostname)
    ).length;

    const isHttps = url.startsWith("https://");

    // --- new checks ---
    const [robotsTxt, sitemap, brokenLinks] = await Promise.all([
      checkRobotsTxt(hostname),
      checkSitemap(hostname, $),
      checkBrokenLinks($, hostname),
    ]);

    const metrics = {
      domainRating: oprMetrics.domainRating ?? "N/A",
      referringDomains: oprMetrics.referringDomains ?? "N/A",
      organicTraffic: serpResultOrPlaceholder.totalResults ?? "N/A",
      topKeyword: serpResultOrPlaceholder.topResult ?? "N/A",
      healthScore: lighthouseResult.score ?? "N/A",
    };

    const categories = {
      metrics,
      content: {
        titleTag: {
          passed: !!title && title.length >= 30 && title.length <= 65,
          details: title || "Missing",
        },
        metaDescription: {
          passed: !!metaDesc && metaDesc.length >= 50 && metaDesc.length <= 160,
          details: metaDesc || "Missing",
        },
        wordCount: { passed: wordCount >= 300, details: `${wordCount} words` },
        keywordDensity,
        headings: {
          passed: h1s === 1 && allHeadings >= 3,
          details: `H1s: ${h1s}, Total: ${allHeadings}`,
        },
      },
      indexability: {
        robotsTxt,
        metaRobots: $('meta[name="robots"]').attr("content") || "Not found",
        canonical: $('link[rel="canonical"]').attr("href") || "Not found",
        sitemap,
      },
      structuredData: {
        jsonLD: $('script[type="application/ld+json"]').length > 0,
      },
      socialTags: {
        openGraph: $("meta[property^='og:']").length > 0,
        twitterCard: $("meta[name^='twitter:']").length > 0,
      },
      images: { missingAlts, largeImages, total: images.length },
      httpHeaders: {
        https: isHttps,
        status: pageResponse?.status ?? "N/A",
        contentType: pageResponse?.headers?.get("content-type") ?? "N/A",
        cacheControl: pageResponse?.headers?.get("cache-control") ?? "N/A",
      },
      outgoingLinks: {
        internal: internalLinks,
        external: externalLinks,
        broken: brokenLinks,
      },
    };

    // scoring
    const allChecks = [];
    for (const cat in categories) {
      for (const key in categories[cat]) {
        const check = categories[cat][key];
        if (check && typeof check === "object" && "passed" in check)
          allChecks.push(check);
      }
    }
    const scorePerCheck = allChecks.length ? 100 / allChecks.length : 0;
    const totalScore = Math.round(
      allChecks.reduce((acc, c) => acc + (c.passed ? scorePerCheck : 0), 0)
    );
    const grade = getGrade(totalScore);
    categories.metrics.healthScore = totalScore;

    // AI suggestions
    let suggestions = "No suggestions available";
    if (process.env.GEMINI_API_KEY) {
      try {
        const aiPrompt = `
This is a categorized website SEO audit.
Score: ${totalScore} (${grade})
Categories: ${JSON.stringify(categories, null, 2)}
Suggest fixes only for FAILED checks.
Keep recommendations actionable and concise.
        `;
        const aiResponse = await client.chat.completions.create({
          model: "gemini-1.5-flash",
          messages: [{ role: "user", content: aiPrompt }],
        });
        suggestions = aiResponse.choices?.[0]?.message?.content ?? suggestions;
      } catch (e) {
        console.warn("AI suggestion failed:", e.message);
      }
    }

    const out = {
      url,
      seoScore: totalScore,
      grade,
      categories,
      analysis: {
        wordCount,
        missingAlts,
        largeImages,
        keywordDensity,
        brokenLinks: brokenLinks.length,
      },
      suggestions,
    };

    if (DEBUG) out.debug = debugPayload;
    return res.json(out);
  } catch (err) {
    console.error("Unhandled error:", err);
    return res
      .status(500)
      .json({ error: "SEO analysis failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`SEO Checker API running at http://localhost:${PORT}`)
);
