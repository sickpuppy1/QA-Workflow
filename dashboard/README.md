# Workflow Automator — Dashboard

The companion Next.js dashboard for the **Workflow Automator** Chrome extension. Automate repetitive tasks, auto-fill forms, and record web workflows with a no-code macro recorder — and manage everything from this central dashboard.

## What This Dashboard Does

- **Browse & manage** all recorded workflows synced from the extension
- **Replay runs** and inspect per-step results, screenshots, and network/console checkpoints
- **Authenticate** users so workflows are securely tied to an account
- **Export** workflow run data for reporting and auditing

## Getting Started

Install dependencies (requires Node 21):

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org) (App Router)
- **Database**: MongoDB
- **Auth**: JWT-based middleware (bcryptjs)
- **Language**: TypeScript
