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
async function callClaude({ messages, tools, system, max_tokens = 1500 }) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens,
    messages,
    ...(system && { system }),
    ...(tools && { tools }),
  };

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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }
  return res.json();
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

// ─── Step 3: Generate image with fal.ai (FLUX.1 schnell) ────────────────────
async function generateImage(topic, research) {
  console.log("\n🎨 Generating image with fal.ai Flux...");

  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) {
    console.warn("   ⚠ FAL_KEY not set — skipping image");
    return null;
  }

  try {
    const headline = (research.headline_finding || topic).slice(0, 100);
    const prompt = `Professional industrial photography: ${headline}. Modern factory floor, advanced manufacturing machinery, blue ambient lighting, cinematic composition, photorealistic, 4k quality, no text, no words, no labels, no people`;

    const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
      method: "POST",
      headers: {
        "Authorization": `Key ${FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_size: "landscape_16_9",
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`fal.ai error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL returned from fal.ai");

    // Download the image
    const imgRes = await fetch(imageUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const imgPath = join(ROOT, "post-image.png");
    writeFileSync(imgPath, buffer);
    console.log(`   ✓ Image generated and saved (${Math.round(buffer.length / 1024)}KB)`);
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
