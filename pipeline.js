#!/usr/bin/env node
/**
 * OpEx LinkedIn Pipeline
 * Researches recent articles → Generates high-level post → Publishes to LinkedIn
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // script runs from repo root

// ─── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "true"; // true = generate only, do not publish

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
if (!DRY_RUN && !LINKEDIN_ACCESS_TOKEN) throw new Error("LINKEDIN_ACCESS_TOKEN is not set");

// ─── Auto-discover LinkedIn Person URN ───────────────────────────────────────
async function getPersonURN() {
  // Try cached URN first
  const cacheFile = join(ROOT, "urn.cache");
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, "utf8").trim();
    if (cached.startsWith("urn:li:person:")) {
      console.log(`   ✓ Using cached URN: ${cached}`);
      return cached;
    }
  }

  console.log("   🔍 Auto-discovering LinkedIn Person URN...");

  // Try /v2/userinfo (OpenID)
  const endpoints = [
    { url: "https://api.linkedin.com/v2/userinfo", idField: "sub" },
    { url: "https://api.linkedin.com/v2/me", idField: "id" },
    { url: "https://api.linkedin.com/v2/me?projection=(id)", idField: "id" },
  ];

  for (const { url, idField } of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      });
      if (res.ok) {
        const data = await res.json();
        const id = data[idField];
        if (id) {
          const urn = `urn:li:person:${id}`;
          writeFileSync(cacheFile, urn);
          console.log(`   ✓ URN discovered: ${urn}`);
          return urn;
        }
      }
    } catch {}
  }

  throw new Error(
    "Could not auto-discover LinkedIn Person URN. " +
    "Please set LINKEDIN_PERSON_URN secret manually (e.g. urn:li:person:XXXXXX). " +
    "You can find your ID by calling: curl -H 'Authorization: Bearer TOKEN' https://api.linkedin.com/v2/userinfo"
  );
}

// ─── Topics rotation ─────────────────────────────────────────────────────────
const TOPICS_FILE = join(ROOT, "rotation.json");

const DEFAULT_TOPICS = [
  { topic: "Lean Manufacturing & Toyota Production System", tone: "thought_leader" },
  { topic: "Six Sigma & DMAIC — Advanced Applications", tone: "data_driven" },
  { topic: "Theory of Constraints (TOC) in Industrial Operations", tone: "provocateur" },
  { topic: "Digital Lean / Industry 4.0 Integration", tone: "thought_leader" },
  { topic: "AI-Driven Process Optimization", tone: "data_driven" },
  { topic: "Hoshin Kanri & Strategy Deployment", tone: "thought_leader" },
  { topic: "Total Productive Maintenance (TPM)", tone: "practitioner" },
  { topic: "Value Stream Mapping & Flow Efficiency", tone: "practitioner" },
  { topic: "Operational Excellence in Healthcare", tone: "data_driven" },
  { topic: "Kaizen & Continuous Improvement Culture", tone: "provocateur" },
  { topic: "OpEx Metrics — OEE, TEEP and Beyond", tone: "data_driven" },
  { topic: "Design for Six Sigma (DFSS)", tone: "thought_leader" },
];

function getNextTopic() {
  let state = { index: 0 };
  if (existsSync(TOPICS_FILE)) {
    try { state = JSON.parse(readFileSync(TOPICS_FILE, "utf8")); } catch {}
  }
  const topic = DEFAULT_TOPICS[state.index % DEFAULT_TOPICS.length];
  state.index = (state.index + 1) % DEFAULT_TOPICS.length;
  writeFileSync(TOPICS_FILE, JSON.stringify(state, null, 2));
  return topic;
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function callClaude({ messages, tools, system, max_tokens = 1500 }, retries = 3) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens,
    messages,
    ...(system && { system }),
    ...(tools && { tools }),
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return res.json();

      const err = await res.text();
      // Retry on 5xx server errors
      if (res.status >= 500 && attempt < retries) {
        const wait = attempt * 5000;
        console.warn(`   ⚠ Claude API ${res.status} — retrying in ${wait/1000}s (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error(`Claude API error ${res.status}: ${err}`);
    } catch (err) {
      if (attempt < retries && err.message.includes("fetch")) {
        console.warn(`   ⚠ Network error — retrying (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, attempt * 3000));
        continue;
      }
      throw err;
    }
  }
}

function extractText(data) {
  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

// ─── Source & angle rotation ─────────────────────────────────────────────────
const SOURCE_GROUPS = [
  "Harvard Business Review and MIT Sloan Management Review",
  "McKinsey Quarterly and BCG Henderson Institute",
  "Journal of Operations Management and International Journal of Production Economics",
  "ASQ Quality Progress and iSixSigma research",
  "Deloitte Insights and Accenture research",
  "peer-reviewed academic journals published in 2024-2025 (Scopus or Web of Science indexed)",
  "Industry reports from Gartner, IDC, or Forrester on operations and manufacturing",
  "World Economic Forum and OECD industrial competitiveness reports",
];

const SEARCH_ANGLES = [
  "Focus on a surprising or counterintuitive finding that challenges mainstream thinking.",
  "Focus on quantified ROI or financial impact data from real implementations.",
  "Focus on a recent case study from a Fortune 500 or DAX-listed company.",
  "Focus on an emerging trend or methodology that is gaining traction in 2025.",
  "Focus on a failure or cautionary tale — what went wrong and why.",
  "Focus on cross-industry application — lessons from healthcare, aerospace, or tech applied to manufacturing.",
  "Focus on the human/culture side — leadership, change management, resistance.",
  "Focus on technology integration — AI, IoT, digital twin, or automation angles.",
];

function pickRandom(arr, seed) {
  // Deterministic pick based on date so each day gets different combo
  const idx = Math.floor(seed % arr.length);
  return arr[idx];
}

// ─── Step 1: Research ─────────────────────────────────────────────────────────
async function researchTopic(topic) {
  console.log(`\n🔍 Researching: "${topic}"`);

  // Use date + topic hash for deterministic but varied selection
  const seed = Date.now() + topic.length * 137 + new Date().getDate() * 31;
  const sourceGroup = pickRandom(SOURCE_GROUPS, seed);
  const angle = pickRandom(SEARCH_ANGLES, seed + 7);
  const year = new Date().getFullYear();

  console.log(`   Source group: ${sourceGroup.slice(0, 50)}...`);
  console.log(`   Angle: ${angle.slice(0, 60)}...`);

  const data = await callClaude({
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: `You are an expert researcher in Operational Excellence (OpEx).

Search for the MOST RECENT (${year - 1}-${year}) articles and studies on: "${topic}"

SOURCE CONSTRAINT: Search specifically in ${sourceGroup}. Do NOT default to the same popular articles — actively seek out lesser-known but high-quality research.

ANGLE: ${angle}

IMPORTANT: Every run of this pipeline must surface DIFFERENT content. If you find a well-known article, skip it and dig deeper for something fresher or more niche.

Return ONLY valid JSON (no markdown) with this structure:
{
  "headline_finding": "The most important or surprising finding in 1 sentence",
  "key_stats": [
    "Statistic 1 with source and year",
    "Statistic 2 with source and year",
    "Statistic 3 with source and year"
  ],
  "deep_insight": "High-level insight in 2-3 sentences — what does this mean for operational leaders?",
  "source_title": "Title of the most relevant article or study found",
  "source_name": "Name of the publication or journal",
  "year": "${year - 1} or ${year}",
  "conventional_wisdom_challenged": "What common belief does this data or study challenge?"
}`
    }],
    max_tokens: 1200,
  });

  const text = extractText(data);
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  // Fallback: return raw text if JSON parsing fails
  return { raw: text, headline_finding: topic };
}

// ─── Step 2: Generate Post ────────────────────────────────────────────────────
async function generatePost(topic, tone, research) {
  console.log(`\n✍️  Generating post (tone: ${tone})...`);

  const toneInstructions = {
    thought_leader: "Strategic forward-looking vision. Connect macro trends to real operational impact. Position the reader as someone who needs to act now.",
    data_driven: "Precise data and scientific evidence at the center. Be rigorous, cite specific sources. Turn numbers into actionable insights.",
    provocateur: "Openly challenge established beliefs. Use strong rhetoric. Push the reader to question what has 'always worked'.",
    practitioner: "Direct, practical application. Use real shop-floor or operations examples. Concrete steps a manager can implement tomorrow.",
  };

  const researchContext = research.raw
    ? research.raw.slice(0, 600)
    : JSON.stringify(research, null, 2);

  const data = await callClaude({
    messages: [{
      role: "user",
      content: `You are a world-class Operational Excellence expert and premium LinkedIn content creator with 200k+ followers.

RESEARCH CONTEXT:
${researchContext}

TOPIC: ${topic}
TONE: ${toneInstructions[tone] || toneInstructions.thought_leader}

Write an EXCEPTIONAL LinkedIn post following these rules:

MANDATORY STRUCTURE:
1. First line: irresistible scroll-stopping hook (max 12 words, no period, can be a question or bold statement)
2. [blank line]
3. Development in short blocks (2-3 lines per block, separated by blank lines)
4. Specific data with real sources — NEVER vague claims
5. Counterintuitive insight or provocation in the middle
6. Closing that positions the reader to take action
7. [blank line]
8. Engagement question for the comments
9. [blank line]
10. 4-5 strategic OpEx hashtags

QUALITY RULES:
- English with precise technical terminology
- Between 1,300 and 1,800 characters total
- Maximum 3 emojis, only where they add real value
- NEVER generic phrases like "in today's world" or "it is essential"
- NEVER bullet points with hyphens or asterisks — use paragraphs
- Tone of someone who knows more than anyone in the room but genuinely wants to share

Return ONLY the post text, ready to publish. No additional commentary.`
    }],
    max_tokens: 1000,
  });

  return extractText(data);
}

// ─── Step 3: Generate card image with Puppeteer ──────────────────────────────
async function generateImage(topic, research) {
  console.log("\n🎨 Generating branded card...");

  try {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 627, deviceScaleFactor: 2 });

    const headlineRaw = (research.headline_finding || topic);
    // Cut at word boundary around 72 chars so title never truncates mid-word
    const headline = headlineRaw.length > 72
      ? headlineRaw.slice(0, headlineRaw.lastIndexOf(' ', 72)) 
      : headlineRaw;
    const stat = (research.key_stats?.[0] || "").slice(0, 120);
    const topicLabel = topic.split("&")[0].trim().toUpperCase();

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1200px; height:627px; overflow:hidden;
  background:#0c1828;
  font-family:'Inter',sans-serif;
  color:#fff;
  position:relative;
}

/* ── Hex grid background ── */
.hex-bg {
  position:absolute; inset:0;
  background-image:
    radial-gradient(circle at 75% 50%, rgba(58,114,200,0.18) 0%, transparent 55%),
    radial-gradient(circle at 20% 80%, rgba(184,232,255,0.06) 0%, transparent 40%);
}
.hex-bg::before {
  content:'';
  position:absolute; inset:0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='52'%3E%3Cpolygon points='30,2 58,16 58,44 30,58 2,44 2,16' fill='none' stroke='%234a78a8' stroke-width='0.4' opacity='0.25'/%3E%3C/svg%3E");
  background-size:60px 52px;
}

/* ── Accent bar ── */
.bar-left {
  position:absolute; left:0; top:0; width:5px; height:100%;
  background:linear-gradient(180deg,#3a72c8 0%,#b8e8ff 100%);
}

/* ── Spark glow top-right ── */
.spark {
  position:absolute; right:80px; top:60px;
  width:180px; height:180px; border-radius:50%;
  background:radial-gradient(circle,rgba(184,232,255,0.22) 0%,transparent 70%);
}

/* ── Layout ── */
.container {
  position:relative; z-index:2;
  padding:52px 72px 48px 64px;
  height:100%;
  display:flex; flex-direction:column; justify-content:space-between;
}

/* ── Top row ── */
.top {
  display:flex; align-items:center; justify-content:space-between;
}
.topic-badge {
  background:rgba(58,114,200,0.25);
  border:1px solid rgba(58,114,200,0.5);
  border-radius:6px;
  padding:10px 22px;
  font-size:16px; font-weight:700;
  letter-spacing:0.14em; color:#b8e8ff;
  text-transform:uppercase;
}
.logo {
  font-size:16px; font-weight:700;
  letter-spacing:0.18em; color:#4a78a8;
  text-transform:uppercase;
}

/* ── Headline ── */
.headline {
  font-size:clamp(44px, 5.5vw, 68px); font-weight:900; line-height:1.1;
  color:#ffffff;
  max-width:960px;
  letter-spacing:-0.02em;
  flex:1; display:flex; align-items:center;
  overflow:hidden;
}
.headline em {
  font-style:normal;
  background:linear-gradient(90deg,#3a72c8,#b8e8ff);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
}

/* ── Stat card ── */
.stat-row {
  display:flex; align-items:stretch; gap:16px;
}
.stat-card {
  flex:1;
  background:rgba(58,114,200,0.12);
  border:1px solid rgba(74,120,168,0.35);
  border-left:4px solid #3a72c8;
  border-radius:6px;
  padding:18px 24px;
}
.stat-label {
  font-size:13px; font-weight:700; color:#3a72c8;
  letter-spacing:0.18em; text-transform:uppercase; margin-bottom:10px;
}
.stat-value {
  font-size:18px; color:#c8dcf0; line-height:1.5; font-weight:400;
}

/* ── Bottom ── */
.bottom {
  display:flex; align-items:center; justify-content:space-between;
  border-top:1px solid rgba(74,120,168,0.2);
  padding-top:16px;
}
.tagline {
  font-size:18px; color:#7a9ab8; font-style:italic; font-weight:400;
}
.hashtags {
  font-size:18px; color:#3a72c8; font-weight:700; letter-spacing:0.03em;
}
</style>
</head>
<body>
<div class="hex-bg"></div>
<div class="bar-left"></div>
<div class="spark"></div>
<div class="container">

  <div class="top">
    <span class="topic-badge">${topicLabel}</span>
    <span class="logo">ROSSITER CONSULTING</span>
  </div>

  <div class="headline">${headline}</div>

  <div>
    ${stat ? `
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-label">Key Finding</div>
        <div class="stat-value">${stat}</div>
      </div>
    </div>` : ""}

    <div class="bottom" style="margin-top:${stat ? '14px' : '0'}">
      <span class="tagline">A perda que te custa caro está onde você não consegue enxergar.</span>
      <span class="hashtags">#OpEx &nbsp;#LeanManufacturing &nbsp;#Margem</span>
    </div>
  </div>

</div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: "networkidle0" });
    const imgPath = join(ROOT, "post-image.png");
    await page.screenshot({ path: imgPath, type: "png" });
    await browser.close();

    const { statSync } = await import("fs");
    const size = statSync(imgPath).size;
    console.log(`   ✓ Branded card saved (${Math.round(size / 1024)}KB)`);
    return imgPath;

  } catch (err) {
    console.warn(`   ⚠ Image generation failed: ${err.message} — posting without image`);
    return null;
  }
}


// ─── Step 4: Upload image to LinkedIn ────────────────────────────────────────
async function uploadImageToLinkedIn(imagePath, personURN) {
  console.log("\n📸 Uploading image to LinkedIn...");

  // 1. Register upload
  const registerRes = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        owner: personURN,
        serviceRelationships: [{
          relationshipType: "OWNER",
          identifier: "urn:li:userGeneratedContent"
        }]
      }
    })
  });

  if (!registerRes.ok) {
    const err = await registerRes.text();
    throw new Error(`LinkedIn register upload error: ${err}`);
  }

  const registerData = await registerRes.json();
  const uploadUrl = registerData.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
  const asset = registerData.value.asset;

  // 2. Upload the image bytes
  const imageBuffer = readFileSync(imagePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      "Content-Type": "image/png",
    },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`LinkedIn image upload error: ${err}`);
  }

  console.log(`   ✓ Image uploaded: ${asset}`);
  return asset;
}

// ─── Step 5: Publish to LinkedIn ──────────────────────────────────────────────
async function publishToLinkedIn(postText, imageAsset, personURN) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Post that would be published:\n");
    console.log("─".repeat(60));
    console.log(postText);
    console.log("─".repeat(60));
    console.log(imageAsset ? "[With image]" : "[No image]");
    return { id: "dry-run-" + Date.now() };
  }

  console.log("\n📤 Publishing to LinkedIn...");

  const mediaCategory = imageAsset ? "IMAGE" : "NONE";
  const media = imageAsset ? [{
    status: "READY",
    description: { text: "OpEx Infographic" },
    media: imageAsset,
    title: { text: postText.split("\n")[0].slice(0, 70) }
  }] : [];

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: personURN,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: postText },
          shareMediaCategory: mediaCategory,
          ...(media.length > 0 && { media }),
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data;
}

// ─── Step 4: Save log ─────────────────────────────────────────────────────────
function saveLog(entry) {
  const logFile = join(ROOT, "logs", "posts.jsonl");
  const dir = join(ROOT, "logs");
  if (!existsSync(dir)) {
    import("fs").then(fs => fs.mkdirSync(dir, { recursive: true }));
  }
  try {
    writeFileSync(logFile, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch {}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 OpEx LinkedIn Pipeline started");
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no publishing)" : "PRODUCTION"}`);
  console.log(`   Date: ${new Date().toISOString()}`);

  const { topic, tone } = getNextTopic();
  console.log(`\n📌 Topic: ${topic}`);
  console.log(`   Tone: ${tone}`);

  const research = await researchTopic(topic);
  console.log(`   ✓ Research complete`);
  if (research.headline_finding) {
    console.log(`   → ${research.headline_finding}`);
  }

  const post = await generatePost(topic, tone, research);
  console.log(`\n   ✓ Post generated (${post.length} characters)`);

  const personURN = DRY_RUN ? "dry-run" : (process.env.LINKEDIN_PERSON_URN || await getPersonURN());
  const imagePath = await generateImage(topic, research);
  const imageAsset = (imagePath && !DRY_RUN) ? await uploadImageToLinkedIn(imagePath, personURN) : null;

  const result = await publishToLinkedIn(post, imageAsset, personURN);
  console.log(`\n   ✓ ${DRY_RUN ? "Dry run complete" : "Published! ID: " + result.id}`);

  saveLog({
    date: new Date().toISOString(),
    topic,
    tone,
    post,
    linkedin_id: result.id,
    dry_run: DRY_RUN,
    chars: post.length,
    with_image: !!imageAsset,
  });

  console.log("\n✅ Pipeline completed successfully!\n");
}

main().catch(err => {
  console.error("\n❌ Pipeline error:", err.message);
  process.exit(1);
});
