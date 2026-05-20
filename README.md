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
