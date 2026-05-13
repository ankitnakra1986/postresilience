# PostResilience

> **Voice-first AI agent that activates India Post's 156,000 postmen as a real-time disaster sensing network.**

Built at the **UPU 4th Innovation Challenge** · RAKNPA Ghaziabad · May 7–8, 2026  
Partnership: **India Post + AWS + Ankit Nakra (AI Product)**

🌐 **[Live Demo →](https://postresilience.vercel.app)**

---

## The Problem

When Kerala flooded in 2018:
- **5.4 million people** affected · **433 lives lost** · **USD 4.4 billion** recovery need *(UNDP PDNA)*
- The official Post-Disaster Needs Assessment took **20 days**, required **76 experts**, and reached **120 of 1,664 affected villages**

India Post had postmen in **all 1,664 villages**. Nobody activated them.

Relief was supply-driven, not demand-driven. Help went where it was *accessible*, not where it was most *needed*.

---

## What PostResilience Does

PostResilience turns every postman into a field sensor and every post office into a data node — creating a real-time district-level ground truth map in **under 6 hours**.

```
Postman speaks into phone (voice-first, Hindi/English/Malayalam)
→ AI extracts: need type + severity + location
→ DigiPin geocode (4m × 4m precision, India Post-owned)
→ SDMA live dashboard: RED / ORANGE / GREEN / LIME priority map
→ AI agent: demand sensing → capacity mapping → dispatch plan → SDMA brief
→ India Post dispatches: IPPB cash + medicine + food + evacuation flag
```

| | Without PostResilience | With PostResilience |
|---|---|---|
| Time to district ground truth | 20 days | 6 hours |
| Experts required | 76 | 500 postmen (already deployed) |
| Villages reachable | 120 | 1,664 |

---

## Why This Works — The Moat

| What's needed | Who has it |
|---|---|
| Last-mile reach when roads fail | Only India Post (bicycle + beat knowledge) |
| Cash disbursement without a bank branch | Only IPPB (40 crore+ accounts) |
| Geocoded household addressing | Only DigiPin (India Post-owned, launched 2024) |
| Institutional trust in communities | India Post — 150+ years, not a private player |

**COVID 2020 proved it**: India Post delivered medicines, food rations, and IPPB cash (MGNREGA, PM Kisan, DBT) to households across India during national lockdown. PostResilience codifies this into a permanent, activatable service.

---

## Architecture

```
┌─────────────────────┐     POST /api/voice-extract      ┌──────────────────────┐
│  Postman Mobile UI  │ ────────────────────────────────► │  AI Extraction Layer │
│  (Screen 1)         │                                   │  AWS Bedrock Claude  │
│  Voice / Type input │ ◄────────────────────────────────  │  + Heuristic fallback│
└─────────────────────┘     {needs, severity, location}   └──────────────────────┘
          │
          │ POST /api/reports
          ▼
┌─────────────────────┐
│   Reports Store     │
│   (JSON / DB)       │
└─────────────────────┘
          │
          │ GET /api/reports
          ▼
┌─────────────────────┐     AWS Bedrock Agent            ┌──────────────────────┐
│  SDMA Dashboard     │ ────────────────────────────────► │  4-Step AI Agent     │
│  (Screen 2)         │                                   │  1. Demand Sensing   │
│  Leaflet map        │ ◄────────────────────────────────  │  2. Capacity Mapping │
│  Live polling 5s    │     Dispatch plan + SDMA brief    │  3. Service Packaging│
└─────────────────────┘                                   │  4. SDMA Brief       │
                                                          └──────────────────────┘
```

**Tech stack:**
- **Framework:** Next.js 14 (App Router)
- **Map:** Leaflet.js + react-leaflet
- **AI:** AWS Bedrock (Claude Sonnet 3.5) · graceful heuristic fallback
- **Geocoding:** DigiPin (India Post open standard — 4m × 4m precision)
- **Voice:** Web Speech API (en-IN / hi-IN / en-US with auto-fallback)
- **Styling:** Tailwind CSS
- **Deploy:** Vercel

---

## Key Features

### Voice-First Field Reporting (Screen 1)
- Postman taps mic, speaks in Hindi / Hinglish / English / Malayalam
- AI extracts needs (`food`, `medicine`, `cash`, `evacuation`) + severity + location
- Falls back to heuristic keyword matching if Bedrock is unavailable — **demo never dead-ends**
- GPS → DigiPin auto-encoding (4m precision)
- Offline-resilient: type-input fallback if mic unavailable

### Live SDMA Dashboard (Screen 2)
- Leaflet map with DigiPin-decoded dots, colour-coded by severity
- 🔴 Critical · 🟠 Medium · 🟢 Food only · 🟡 Route blocked · 🟢 Safe pocket
- Post office status overlay (operational vs flooded)
- Coverage completeness bar: "18% of district reached in first 2 hours"
- Live polling every 5 seconds — no page refresh needed

### AI Agent Panel (Screen 2)
- 4 streamed tool calls: Demand Sensing → Capacity Mapping → Service Packaging → SDMA Brief
- Before/After impact counter
- Structured 5-line SDMA situation report output

---

## Getting Started

### Prerequisites
- Node.js 20+ (use `nvm use` — `.nvmrc` included)
- AWS account with Bedrock access (optional — heuristic fallback works without it)

### Run locally

```bash
git clone https://github.com/ankitnakra1986/postresilience.git
cd postresilience
nvm use          # switches to Node 20
npm install
cp .env.local.example .env.local   # add your keys (optional)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Environment variables (all optional — app works without them)

```bash
# AWS Bedrock — enables Claude-powered voice extraction
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0

# Mappls (MapmyIndia) — enables Indian map tiles
# Without this, falls back to OpenStreetMap (still works)
NEXT_PUBLIC_MAPPLS_KEY=

# Set to true for demo mode (pre-loads mock data)
NEXT_PUBLIC_DEMO_MODE=false
```

---

## Where to Contribute

This was built in one night at a hackathon. There's a lot of room to build on top of it. Open issues welcome.

**High-value areas:**

| Area | What's needed | Skill |
|---|---|---|
| **Offline-first** | Service worker + IndexedDB sync — reports saved locally when no signal | JS / PWA |
| **WhatsApp channel** | Twilio / Meta API — flood-affected person self-reports via WhatsApp | Node.js |
| **Real database** | Replace `reports.json` with Postgres/Supabase | Backend |
| **Photo processing** | Bedrock Vision — extract flood severity from geotagged photos | AI/ML |
| **Multi-language NLP** | Malayalam, Tamil, Bengali voice extraction | NLP |
| **Aadhaar-linked ID** | Beneficiary verification at post office for displaced persons | Govt API |
| **Pre-disaster mode** | Same stack, different trigger — pre-positioning before the flood | Product |
| **Other countries** | Replace DigiPin with What3Words or local address grid | Infra |

**The global version of this works anywhere with a postal network.** UPU has 192 member countries. If your postal service has last-mile reach and a smartphone-enabled field force, this architecture ports directly.

---

## Data Sources

All mock data uses real Kerala 2018 geography. Sources:

- [UNDP Post-Disaster Needs Assessment — Kerala 2018](https://www.undp.org/publications/post-disaster-needs-assessment-kerala)
- [SDMA Kerala Floods 2018](https://sdma.kerala.gov.in/floods_2018/)
- [DigiPin — India Post open geocoding standard](https://github.com/INDIAPOST-gov/digipin)

---

## SDG Alignment

**SDG 9** — Resilient infrastructure · **SDG 11** — Sustainable cities & disaster resilience  
**SDG 13** — Climate action · **SDG 17** — Partnerships for the goals

---

## Built By

**Ankit Nakra** — AI Product Leader  
[LinkedIn](https://linkedin.com/in/ankitnakra) · [GitHub](https://github.com/ankitnakra1986)

Built with: India Post · AWS · RAKNPA Ghaziabad · UPU 4th Innovation Challenge, May 2026

---

*PostResilience is open source. If your country's postal service wants to pilot this — reach out.*
