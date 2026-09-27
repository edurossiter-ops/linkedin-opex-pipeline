# 🏭 OpEx LinkedIn Pipeline

A fully automated pipeline that researches high-level articles on **Operational Excellence**, generates professional LinkedIn posts, and publishes them 3x/week — entirely via GitHub Actions, no server required.

---

## How it works

```
GitHub Actions (cron)
       ↓
Claude API (web search) → searches recent articles from HBR, McKinsey, MIT Sloan...
       ↓
Claude API (generation) → turns research into a high-level LinkedIn post
       ↓
LinkedIn API → publishes automatically
       ↓
Git commit → saves topic rotation state
```

**Topics in rotation (12 total):**
- Lean Manufacturing & Toyota Production System
- Six Sigma & DMAIC — Advanced Applications
- Theory of Constraints (TOC) in Industrial Operations
- Digital Lean / Industry 4.0 Integration
- AI-Driven Process Optimization
- Hoshin Kanri & Strategy Deployment
- Total Productive Maintenance (TPM)
- Value Stream Mapping & Flow Efficiency
- Operational Excellence in Healthcare
- Kaizen & Continuous Improvement Culture
- OpEx Metrics — OEE, TEEP and Beyond
- Design for Six Sigma (DFSS)

---

## Setup (10 minutes)

### 1. Fork / clone this repository

```bash
git clone https://github.com/YOUR_USERNAME/linkedin-opex-pipeline
cd linkedin-opex-pipeline
npm install
```

### 2. Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-...`)

### 3. Get your LinkedIn Access Token

1. Go to [linkedin.com/developers](https://www.linkedin.com/developers/)
2. Create an App → add the **Share on LinkedIn** product
3. Generate an **Access Token** with the `w_member_social` scope
4. To get your `LINKEDIN_PERSON_URN`:
   - Call: `GET https://api.linkedin.com/v2/me` with your token
   - The returned `id` field → your URN will be `urn:li:person:YOUR_ID`

### 4. Add Secrets to GitHub

In your repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Value |
|--------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `LINKEDIN_ACCESS_TOKEN` | Your LinkedIn access token |
| `LINKEDIN_PERSON_URN` | `urn:li:person:XXXXXX` |

### 5. Test before going live

Go to GitHub → **Actions** → **OpEx LinkedIn Pipeline** → **Run workflow** → set `dry_run: true`

This generates the post and prints it to the log without publishing anything.

### 6. Go live

The pipeline is pre-configured to run automatically:
- **Monday, Wednesday and Friday** at **09:00 AM BRT**

To change the schedule, edit the `cron` expression in `.github/workflows/opex-pipeline.yml`:
```yaml
- cron: "0 12 * * 1,3,5"  # 12:00 UTC = 09:00 BRT
```

---

## Local development

```bash
# Create your .env file
cp .env.example .env
# Fill in the variables in .env

# Dry run (generate only, do not publish)
npm run dry-run

# Production
npm start
```

---

## Project structure

```
.
├── .github/
│   └── workflows/
│       └── opex-pipeline.yml   # Schedule and execution
├── scripts/
│   └── pipeline.js             # Core pipeline logic
├── topics/
│   └── rotation.json           # Rotation state (auto-updated)
├── logs/                       # Local logs (in .gitignore)
├── package.json
└── README.md
```

---

## Estimated costs

| Item | Cost |
|------|-------|
| GitHub Actions | **Free** (well below the 2,000 min/month limit) |
| Claude API (3x/week) | ~$1–3/month (input + output tokens) |
| LinkedIn API | **Free** |
| **Total** | **~$1–3/month** |

---

## Customization

**Add topics:** edit the `DEFAULT_TOPICS` array in `scripts/pipeline.js`

**Change frequency:** edit the cron expression in `.github/workflows/opex-pipeline.yml`

**Change language or tone:** edit the prompt instructions inside `generatePost()` in `pipeline.js`

---

## Operations notes — Rossiter setup (added 2026-09-27)

These notes describe how this repository actually runs today. Where they differ from the setup sections above, these notes are current.

**Schedule (UTC):** `15 07 * * 1,3,5` (Mon/Wed/Fri 07:15) and `0 15 * * 2,4` (Tue/Thu 15:00), plus `workflow_dispatch` with input `dry_run`. Code lives at the repo root (`pipeline.js`, `rotation.json`), not under `scripts/` and `topics/`.

**Flow per run:** topic rotation (`rotation.json`) → research via Claude + web search → English LinkedIn post → card image rendered with Puppeteer → publish to LinkedIn → `publishToBlog()` rewrites the post in pt-BR and commits it to the site repo `edurossiter-ops/rossiter.de` (`blog/posts/<slug>.md` + `blog/posts.json`). The site serves it through GitHub Pages at `rossiter.de/blog/`.

**Secrets:** `ANTHROPIC_API_KEY`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN`, `FAL_KEY` (passed by the workflow), `SITE_REPO_TOKEN` (fine-grained token, Contents read/write only on `rossiter.de`; created 2026-06-09, validated end to end in run 27223848223).
- `ANTHROPIC_API_KEY` belongs to a separate Anthropic API account (console.anthropic.com → Plans & Billing), not to the Claude Code subscription. If that account runs out of credit, the pipeline fails at the first step with `Claude API error 400: Your credit balance is too low` and publishes nothing (incident: run 27223562754, 2026-06-09).

**Blog behaviour:**
- The blog only runs with `dry_run=false` (DRY_RUN skips it), and `dry_run=false` also posts to LinkedIn for real: the blog cannot be tested alone.
- The blog block runs inside a `try/catch` that swallows errors so LinkedIn never breaks. "LinkedIn published, blog did not" shows as a successful run; diagnose with `gh run view <id> --log`, searching for `Blog pt-BR pulado`.
- After publishing, GitHub Pages takes ~1–2 min to build (`gh api repos/edurossiter-ops/rossiter.de/pages/builds/latest --jq .status` → `built`).
- Fixed on 2026-06-17 (commit `0c1af26`): `generateBlogPtBr` now uses a delimited format `TITULO/RESUMO/---CORPO---` instead of JSON with embedded markdown.

**Manual run:** `gh workflow run opex-pipeline.yml --repo edurossiter-ops/linkedin-opex-pipeline`. A production run (`dry_run=false`) is a public action (real LinkedIn post + blog): only with Eduardo's explicit OK.

**Deploy trap on the site:** the pipeline writes `blog/posts.json` and `blog/posts/*.md` straight into the `rossiter.de` repo, bypassing the local working folder `Rossiter Consulting/website-v2/`, so local and repo diverge on blog content. In a manual site deploy, copy only the files you changed (never `posts.json` or `posts/`), then sync the blog back from the repo to the local folder.

**Local copies:** the canonical source is this GitHub repo. The OneDrive clone at `Dokumente/linkedin-opex-pipeline` is an old copy: keep it in sync with `origin/main` or ignore it.
