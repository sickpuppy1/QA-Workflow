'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, useScroll, useTransform, AnimatePresence } from 'framer-motion'
import {
  Circle, Play, Pause, BarChart3, CheckCircle2, Zap, Users, Shield,
  Terminal, Wifi, GitBranch, ChevronRight, ArrowRight,
  Database, Layers, Code2, Globe, Monitor, FileJson,
} from 'lucide-react'
import Link from 'next/link'

// ─── Design tokens ───────────────────────────────────────────────────────────
const C = {
  bg0:    'rgba(14,14,20,1)',
  bg1:    'rgba(18,18,26,1)',
  glass:  'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.08)',
  violet: '#7c3aed',
  violetL:'#a78bfa',
  cyan:   '#06b6d4',
  cyanL:  '#67e8f9',
  red:    '#ef4444',
  green:  '#22c55e',
  yellow: '#eab308',
  muted:  '#6b7280',
  text:   '#e2e8f0',
} as const

// ─── Checkpoint data ──────────────────────────────────────────────────────────
const CHECKPOINTS = [
  {
    id: 1, label: 'Cart Add',
    consoleLogs: ['[INFO] addToCart() → SKU-8821', '[DEBUG] state.cart = {items:1, total:49.99}'],
    network: { method: 'POST', url: '/api/cart/add', status: 200, payload: '{"sku":"SKU-8821","qty":1}' },
    color: C.cyan,
    accent: 'rgba(6,182,212,0.12)',
    preview: { bg: '#0f1922', dots: ['#06b6d4','#0e7490','#164e63'] },
  },
  {
    id: 2, label: 'Address Form',
    consoleLogs: ['[INFO] validateAddress() passed', '[WARN] postcode format: US-5-digit'],
    network: { method: 'GET', url: '/api/address/validate', status: 200, payload: '{"valid":true,"region":"CA"}' },
    color: C.violetL,
    accent: 'rgba(124,58,237,0.12)',
    preview: { bg: '#130f1f', dots: ['#7c3aed','#5b21b6','#4c1d95'] },
  },
  {
    id: 3, label: 'Payment',
    consoleLogs: ['[INFO] Stripe.confirmPayment() called', '[DEBUG] intent.status = "succeeded"'],
    network: { method: 'POST', url: '/api/checkout/confirm', status: 200, payload: '{"status":"succeeded","id":"pi_3Ox"}' },
    color: C.green,
    accent: 'rgba(34,197,94,0.12)',
    preview: { bg: '#0a1a11', dots: ['#22c55e','#16a34a','#166534'] },
  },
  {
    id: 4, label: 'Confirmation',
    consoleLogs: ['[INFO] orderCreated: ORD-9920', '[INFO] emailSent → user@acme.com'],
    network: { method: 'POST', url: '/api/orders', status: 201, payload: '{"orderId":"ORD-9920","eta":"2 days"}' },
    color: C.yellow,
    accent: 'rgba(234,179,8,0.12)',
    preview: { bg: '#1a1709', dots: ['#eab308','#ca8a04','#a16207'] },
  },
]

const PERSONAS = [
  {
    icon: Shield,
    role: 'The QA Engineer',
    headline: 'Record once. Replay everywhere.',
    body: 'Capture a bug reproduction path in 30 seconds. Replay it across staging, UAT, and production with one click.',
    accent: C.cyan,
    glow: 'rgba(6,182,212,0.06)',
  },
  {
    icon: GitBranch,
    role: 'The DevOps Architect',
    headline: 'Deployment gates that never sleep.',
    body: 'Queue 10 critical-path workflows into a smoke-test suite. Run them after every deploy to catch regressions instantly.',
    accent: C.violetL,
    glow: 'rgba(124,58,237,0.06)',
  },
  {
    icon: Users,
    role: 'The SaaS Founder',
    headline: 'Onboarding that never breaks.',
    body: 'Record your perfect product tour once. The extension replays it for every demo—pixel-perfect, every time.',
    accent: '#f472b6',
    glow: 'rgba(244,114,182,0.06)',
  },
  {
    icon: Zap,
    role: 'The Data Entry Pro',
    headline: 'Zero typos. Zero fatigue.',
    body: 'Auto-fill complex 50-field forms with dynamic date ranges and variable substitution. Works on any web app.',
    accent: C.yellow,
    glow: 'rgba(234,179,8,0.06)',
  },
]

const NAV_STEPS = [
  { id: 'hero',     label: 'Record',     icon: Circle },
  { id: 'evidence', label: 'Checkpoint', icon: CheckCircle2 },
  { id: 'sync',     label: 'Replay',     icon: Play },
  { id: 'playbook', label: 'Analyze',    icon: BarChart3 },
]

// ─── Component ────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [activeCP, setActiveCP] = useState(0)
  const [activeNav, setActiveNav] = useState('hero')
  const [jsonPos, setJsonPos] = useState(0)
  const [recPulse, setRecPulse] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const { scrollY } = useScroll()
  const heroBgY = useTransform(scrollY, [0, 600], [0, 80])

  // JSON flow animation
  useEffect(() => {
    const interval = setInterval(() => {
      setJsonPos(p => (p >= 100 ? 0 : p + 0.6))
    }, 16)
    return () => clearInterval(interval)
  }, [])

  // Intersection observer for active nav
  useEffect(() => {
    const sections = NAV_STEPS.map(s => document.getElementById(s.id))
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(e => {
          if (e.isIntersecting) setActiveNav(e.target.id)
        })
      },
      { threshold: 0.4 }
    )
    sections.forEach(s => s && observer.observe(s))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; scroll-behavior: smooth; }

        .lp {
          font-family: 'DM Sans', system-ui, sans-serif;
          background: ${C.bg0};
          color: ${C.text};
          min-height: 100vh;
          overflow-x: hidden;
          -webkit-font-smoothing: antialiased;
        }

        /* ── Noise grain overlay ── */
        .lp::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
          pointer-events: none;
          z-index: 0;
          opacity: 0.5;
        }

        .lp > * { position: relative; z-index: 1; }

        /* ── Sticky nav ── */
        .maestro-nav {
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 100;
          display: flex;
          align-items: center;
          gap: 2px;
          background: rgba(14,14,20,0.85);
          backdrop-filter: blur(16px);
          border: 1px solid ${C.border};
          border-radius: 999px;
          padding: 5px 6px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .mnav-logo {
          font-family: 'Syne', sans-serif;
          font-size: 13px;
          font-weight: 700;
          color: ${C.violetL};
          padding: 0 14px 0 10px;
          border-right: 1px solid ${C.border};
          margin-right: 4px;
          white-space: nowrap;
        }
        .mnav-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 500;
          color: ${C.muted};
          cursor: pointer;
          transition: all 0.2s;
          border: none;
          background: none;
          white-space: nowrap;
          text-decoration: none;
        }
        .mnav-btn:hover { color: ${C.text}; }
        .mnav-btn.active {
          background: rgba(124,58,237,0.18);
          color: ${C.violetL};
        }
        .mnav-cta {
          margin-left: 4px;
          padding: 7px 16px;
          background: ${C.violet};
          color: white;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: none;
          text-decoration: none;
          transition: background 0.2s;
        }
        .mnav-cta:hover { background: ${C.violetL}; }

        /* ── Section base ── */
        .section {
          max-width: 1160px;
          margin: 0 auto;
          padding: 120px 24px;
        }
        .section-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: ${C.cyan};
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .section-label::before {
          content: '';
          display: inline-block;
          width: 20px;
          height: 1px;
          background: ${C.cyan};
        }
        .section-title {
          font-family: 'Syne', sans-serif;
          font-size: clamp(32px, 5vw, 54px);
          font-weight: 800;
          letter-spacing: -1.5px;
          line-height: 1.05;
          color: ${C.text};
        }
        .section-title .hl-v { color: ${C.violetL}; }
        .section-title .hl-c { color: ${C.cyanL}; }

        /* ── Glass card ── */
        .glass-card {
          background: ${C.glass};
          border: 1px solid ${C.border};
          border-radius: 16px;
          backdrop-filter: blur(8px);
        }

        /* ── Hero ── */
        .hero-wrap {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 140px 24px 80px;
          position: relative;
          overflow: hidden;
        }
        .hero-glow-v {
          position: absolute;
          top: -20%;
          left: 50%;
          transform: translateX(-50%);
          width: 900px;
          height: 500px;
          background: radial-gradient(ellipse, rgba(124,58,237,0.18) 0%, transparent 70%);
          pointer-events: none;
        }
        .hero-glow-c {
          position: absolute;
          bottom: 10%;
          right: -15%;
          width: 500px;
          height: 400px;
          background: radial-gradient(ellipse, rgba(6,182,212,0.10) 0%, transparent 70%);
          pointer-events: none;
        }
        .hero-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: ${C.cyan};
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .hero-badge {
          background: rgba(6,182,212,0.12);
          border: 1px solid rgba(6,182,212,0.3);
          border-radius: 999px;
          padding: 4px 12px;
          font-size: 11px;
          color: ${C.cyanL};
        }
        .hero-title {
          font-family: 'Syne', sans-serif;
          font-size: clamp(42px, 7vw, 80px);
          font-weight: 800;
          letter-spacing: -2.5px;
          line-height: 1.0;
          margin-bottom: 24px;
        }
        .hero-title .line1 { color: ${C.text}; display: block; }
        .hero-title .line2 {
          display: block;
          background: linear-gradient(135deg, ${C.violetL} 0%, ${C.cyanL} 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .hero-sub {
          font-size: 18px;
          color: ${C.muted};
          max-width: 540px;
          line-height: 1.65;
          margin: 0 auto 48px;
        }
        .hero-sub strong { color: ${C.text}; font-weight: 600; }
        .hero-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          justify-content: center;
          margin-bottom: 80px;
        }
        .btn-primary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 13px 28px;
          background: linear-gradient(135deg, ${C.violet}, #5b21b6);
          color: white;
          border-radius: 10px;
          font-size: 15px; font-weight: 600;
          text-decoration: none;
          box-shadow: 0 8px 32px rgba(124,58,237,0.35);
          transition: all 0.2s;
          border: none; cursor: pointer;
        }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(124,58,237,0.45); }
        .btn-ghost {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 13px 24px;
          background: rgba(255,255,255,0.04);
          color: ${C.text};
          border: 1px solid ${C.border};
          border-radius: 10px;
          font-size: 15px; font-weight: 500;
          text-decoration: none; cursor: pointer;
          transition: all 0.2s;
        }
        .btn-ghost:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }

        /* ── Split HUD container ── */
        .hud-container {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          width: 100%;
          max-width: 900px;
          margin: 0 auto;
        }
        @media (max-width: 700px) { .hud-container { grid-template-columns: 1fr; } }

        .hud-panel {
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid ${C.border};
          background: rgba(14,14,20,0.95);
        }
        .hud-panel-header {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 14px;
          background: rgba(255,255,255,0.03);
          border-bottom: 1px solid ${C.border};
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: ${C.muted};
        }
        .hud-dot { width: 8px; height: 8px; border-radius: 50%; }
        .hud-panel-body { padding: 16px; }

        /* REC indicator */
        .rec-indicator {
          display: flex; align-items: center; gap: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px; font-weight: 500;
          color: ${C.red};
          margin-bottom: 12px;
        }
        .rec-dot-wrap { position: relative; width: 12px; height: 12px; }
        .rec-dot-core { width: 12px; height: 12px; border-radius: 50%; background: ${C.red}; }
        .rec-ring {
          position: absolute; inset: -4px;
          border-radius: 50%;
          border: 2px solid ${C.red};
          animation: recRing 1.2s ease-out infinite;
        }
        @keyframes recRing {
          0%   { transform: scale(0.7); opacity: 0.9; }
          100% { transform: scale(1.8); opacity: 0; }
        }

        .hud-stat-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
        .hud-stat {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 8px;
          text-align: center;
        }
        .hud-stat-val { font-size: 18px; font-weight: 700; }
        .hud-stat-lbl { font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px; color: ${C.muted}; margin-top: 2px; }
        .hud-event-list { display: flex; flex-direction: column; gap: 4px; }
        .hud-event {
          display: flex; align-items: center; gap: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: ${C.muted};
          padding: 4px 6px;
          border-radius: 5px;
          background: rgba(255,255,255,0.02);
        }
        .hud-event-type {
          font-size: 9px; font-weight: 700;
          padding: 1px 5px; border-radius: 3px;
        }

        /* Dashboard mini HUD */
        .dash-run-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.06);
          background: rgba(255,255,255,0.025);
          margin-bottom: 6px;
          font-size: 12px;
        }
        .dash-run-name { color: ${C.text}; font-weight: 500; font-size: 11px; }
        .dash-run-meta { color: ${C.muted}; font-size: 10px; }
        .status-chip {
          font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 20px;
        }
        .status-pass { background: rgba(34,197,94,0.15); color: ${C.green}; border: 1px solid rgba(34,197,94,0.3); }
        .status-fail { background: rgba(239,68,68,0.15); color: ${C.red}; border: 1px solid rgba(239,68,68,0.3); }
        .status-run  { background: rgba(6,182,212,0.15); color: ${C.cyan}; border: 1px solid rgba(6,182,212,0.3); }

        /* ── Evidence / Checkpoint Gallery ── */
        .cp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 48px 0 32px; }
        @media (max-width: 700px) { .cp-grid { grid-template-columns: repeat(2, 1fr); } }

        .cp-card {
          border-radius: 12px;
          border: 1px solid ${C.border};
          background: ${C.glass};
          padding: 12px;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
          overflow: hidden;
        }
        .cp-card.active { border-color: var(--cp-color); box-shadow: 0 0 0 1px var(--cp-color), 0 8px 32px rgba(0,0,0,0.4); }
        .cp-card:hover { transform: translateY(-2px); }
        .cp-thumb {
          height: 72px;
          border-radius: 8px;
          margin-bottom: 10px;
          position: relative;
          overflow: hidden;
          display: flex; align-items: center; justify-content: center;
          gap: 6px;
        }
        .cp-thumb-dot { width: 8px; height: 8px; border-radius: 50%; }
        .cp-num {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; font-weight: 500;
          color: ${C.muted};
          margin-bottom: 4px;
        }
        .cp-label { font-size: 13px; font-weight: 600; color: ${C.text}; }

        .cp-detail {
          border-radius: 14px;
          border: 1px solid ${C.border};
          background: rgba(14,14,20,0.98);
          padding: 28px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          min-height: 240px;
        }
        @media (max-width: 700px) { .cp-detail { grid-template-columns: 1fr; } }
        .cp-detail-title {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: ${C.muted};
          text-transform: uppercase; letter-spacing: 1.5px;
          margin-bottom: 10px;
          display: flex; align-items: center; gap: 6px;
        }
        .cp-log-line {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          padding: 5px 8px;
          border-radius: 5px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.05);
          margin-bottom: 4px;
        }
        .log-info { color: ${C.cyan}; }
        .log-warn { color: ${C.yellow}; }
        .log-debug { color: ${C.muted}; }
        .net-badge {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          padding: 5px 10px;
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .net-method { font-weight: 700; font-size: 10px; }
        .method-post { background: rgba(124,58,237,0.2); color: ${C.violetL}; }
        .method-get  { background: rgba(6,182,212,0.2);  color: ${C.cyanL}; }
        .net-url { color: ${C.text}; font-size: 10px; }
        .net-payload {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; color: '#9ca3af';
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
          border-radius: 7px; padding: 10px; line-height: 1.5;
          color: #9ca3af;
        }

        /* ── Sync section ── */
        .sync-grid { display: grid; grid-template-columns: 1fr 480px; gap: 48px; align-items: center; }
        @media (max-width: 900px) { .sync-grid { grid-template-columns: 1fr; } }

        .flow-vis {
          position: relative;
          height: 280px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .flow-node {
          position: absolute;
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px; color: ${C.muted};
        }
        .flow-node-icon {
          width: 52px; height: 52px;
          border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
        }
        .flow-line {
          position: absolute;
          top: 50%;
          left: 23%;
          width: 54%;
          height: 1px;
          background: linear-gradient(90deg, rgba(124,58,237,0.4), rgba(6,182,212,0.4));
        }
        .flow-dot-track {
          position: absolute;
          top: calc(50% - 6px);
          left: 23%;
          width: 54%;
          height: 12px;
          overflow: visible;
          pointer-events: none;
        }

        .queue-card {
          border-radius: 12px;
          border: 1px solid ${C.border};
          background: rgba(14,14,20,0.9);
          overflow: hidden;
        }
        .queue-header {
          padding: 14px 18px;
          border-bottom: 1px solid ${C.border};
          font-size: 13px; font-weight: 600;
          display: flex; align-items: center; justify-content: space-between;
        }
        .queue-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 18px;
          border-bottom: 1px solid rgba(255,255,255,0.04);
          font-size: 12px;
          transition: background 0.15s;
          cursor: default;
        }
        .queue-item:hover { background: rgba(255,255,255,0.02); }
        .queue-item:last-child { border-bottom: none; }
        .queue-item-left { display: flex; align-items: center; gap: 10px; }
        .queue-order {
          width: 22px; height: 22px;
          border-radius: 50%;
          background: rgba(255,255,255,0.06);
          display: flex; align-items: center; justify-content: center;
          font-size: 10px; font-weight: 700; color: ${C.muted};
        }

        /* ── Persona cards ── */
        .persona-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 56px; }
        @media (max-width: 800px) { .persona-grid { grid-template-columns: 1fr; } }

        .persona-card {
          padding: 28px;
          border-radius: 16px;
          border: 1px solid ${C.border};
          background: ${C.glass};
          transition: all 0.25s;
          cursor: default;
        }
        .persona-card:hover {
          border-color: var(--persona-accent);
          background: var(--persona-glow);
          transform: translateY(-3px);
          box-shadow: 0 16px 48px rgba(0,0,0,0.3);
        }
        .persona-icon-wrap {
          width: 44px; height: 44px;
          border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 16px;
        }
        .persona-role {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px;
          color: var(--persona-accent);
          margin-bottom: 8px;
        }
        .persona-headline {
          font-family: 'Syne', sans-serif;
          font-size: 19px; font-weight: 700; letter-spacing: -0.4px;
          color: ${C.text};
          margin-bottom: 10px;
        }
        .persona-body { font-size: 14px; color: ${C.muted}; line-height: 1.6; }

        /* ── CTA section ── */
        .cta-section {
          text-align: center;
          padding: 120px 24px;
          position: relative;
          overflow: hidden;
        }
        .cta-glow {
          position: absolute;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          width: 600px; height: 400px;
          background: radial-gradient(ellipse, rgba(124,58,237,0.15), transparent 70%);
          pointer-events: none;
        }
        .cta-title {
          font-family: 'Syne', sans-serif;
          font-size: clamp(36px, 5vw, 60px);
          font-weight: 800;
          letter-spacing: -1.5px;
          margin-bottom: 20px;
          position: relative;
        }
        .cta-sub { font-size: 17px; color: ${C.muted}; max-width: 420px; margin: 0 auto 40px; line-height: 1.65; }

        /* ── Footer ── */
        .lp-footer {
          border-top: 1px solid ${C.border};
          padding: 32px 24px;
          text-align: center;
          font-size: 13px;
          color: ${C.muted};
        }

        /* ── Fade-up animation ── */
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .fade-up { animation: fadeUp 0.7s ease both; }
        .delay-1 { animation-delay: 0.1s; }
        .delay-2 { animation-delay: 0.2s; }
        .delay-3 { animation-delay: 0.3s; }
        .delay-4 { animation-delay: 0.4s; }
      `}</style>

      <div className="lp" ref={containerRef}>

        {/* ── Sticky Maestro Nav ── */}
        <nav className="maestro-nav">
          <span className="mnav-logo">⬡ WF</span>
          {NAV_STEPS.map(s => (
            <a key={s.id} href={`#${s.id}`} className={`mnav-btn ${activeNav === s.id ? 'active' : ''}`}>
              <s.icon size={12} />
              {s.label}
            </a>
          ))}
          <Link href="/login" className="mnav-cta">Open Dashboard</Link>
        </nav>

        {/* ══════════════════════════════════════════════════════════════
            SECTION 1 — HERO
        ══════════════════════════════════════════════════════════════ */}
        <section id="hero">
          <motion.div className="hero-wrap" style={{ y: heroBgY }}>
            <div className="hero-glow-v" />
            <div className="hero-glow-c" />

            <motion.div
              className="hero-eyebrow fade-up"
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
            >
              <span className="hero-badge">Chrome Extension + Dashboard</span>
              Field Agent meets Command Center
            </motion.div>

            <motion.h1
              className="hero-title"
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.1 }}
            >
              <span className="line1">Stop Documenting.</span>
              <span className="line2">Start Automating.</span>
            </motion.h1>

            <motion.p
              className="hero-sub"
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.2 }}
            >
              The first no-code recorder that turns web interactions into{' '}
              <strong>replayable, evidence-backed automated workflows</strong> in seconds.
            </motion.p>

            <motion.div
              className="hero-actions"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.35 }}
            >
              <a href="https://chromewebstore.google.com" target="_blank" rel="noopener noreferrer" className="btn-primary">
                <Globe size={16} /> Add to Chrome — Free
              </a>
              <Link href="/login" className="btn-ghost">
                <Monitor size={16} /> Open Dashboard
              </Link>
            </motion.div>

            {/* Split HUD */}
            <motion.div
              className="hud-container"
              initial={{ opacity: 0, y: 32, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.5 }}
            >
              {/* Extension HUD panel */}
              <div className="hud-panel">
                <div className="hud-panel-header">
                  <div className="hud-dot" style={{ background: '#ff5f57' }} />
                  <div className="hud-dot" style={{ background: '#ffbd2e' }} />
                  <div className="hud-dot" style={{ background: '#27c93f' }} />
                  <span style={{ marginLeft: 6 }}>Workflow Automator</span>
                  <span style={{ marginLeft: 'auto', color: C.violetL }}>v1.0</span>
                </div>
                <div className="hud-panel-body">
                  <div className="rec-indicator">
                    <div className="rec-dot-wrap">
                      <div className="rec-dot-core" />
                      <div className="rec-ring" />
                    </div>
                    RECORDING
                    <span style={{ color: C.muted, marginLeft: 'auto', fontFamily: 'JetBrains Mono', fontSize: 11 }}>02:14</span>
                  </div>
                  <div className="hud-stat-row">
                    <div className="hud-stat"><div className="hud-stat-val" style={{ color: C.text }}>47</div><div className="hud-stat-lbl">Events</div></div>
                    <div className="hud-stat"><div className="hud-stat-val" style={{ color: C.cyan }}>4</div><div className="hud-stat-lbl">Checkpoints</div></div>
                    <div className="hud-stat"><div className="hud-stat-val" style={{ color: C.green }}>12</div><div className="hud-stat-lbl">Net Calls</div></div>
                  </div>
                  <div className="hud-event-list">
                    {[
                      { type: 'click',  sel: '#checkout-btn',    color: C.cyan },
                      { type: 'input',  sel: '#card-number',      color: C.violetL },
                      { type: 'nav',    sel: '/checkout/confirm', color: C.yellow },
                      { type: 'click',  sel: '#confirm-payment',  color: C.cyan },
                    ].map((ev, i) => (
                      <div key={i} className="hud-event">
                        <span className="hud-event-type" style={{ background: `${ev.color}22`, color: ev.color }}>{ev.type}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.sel}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Dashboard Live Run panel */}
              <div className="hud-panel">
                <div className="hud-panel-header">
                  <div className="hud-dot" style={{ background: '#ff5f57' }} />
                  <div className="hud-dot" style={{ background: '#ffbd2e' }} />
                  <div className="hud-dot" style={{ background: '#27c93f' }} />
                  <span style={{ marginLeft: 6 }}>Workflow Automator — Live Runs</span>
                </div>
                <div className="hud-panel-body">
                  <div style={{ marginBottom: 10, fontSize: 11, color: C.muted, fontFamily: 'JetBrains Mono' }}>
                    checkout-flow-v3 · 3 runs
                  </div>
                  {[
                    { name: 'Run #3 — Staging',    checkpoints: 4, status: 'run',  diff: '▲ Now' },
                    { name: 'Run #2 — Production', checkpoints: 4, status: 'pass', diff: '0 diffs' },
                    { name: 'Run #1 — Staging',    checkpoints: 3, status: 'fail', diff: '2 diffs' },
                  ].map((r, i) => (
                    <div key={i} className="dash-run-row">
                      <div>
                        <div className="dash-run-name">{r.name}</div>
                        <div className="dash-run-meta">{r.checkpoints} checkpoints · {r.diff}</div>
                      </div>
                      <span className={`status-chip status-${r.status}`}>
                        {r.status === 'run' ? 'LIVE' : r.status === 'pass' ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* ══════════════════════════════════════════════════════════════
            SECTION 2 — EVIDENCE GALLERY
        ══════════════════════════════════════════════════════════════ */}
        <section id="evidence" style={{ background: 'linear-gradient(180deg, rgba(20,21,28,0.98), rgba(16,17,22,1))', padding: '0 0 80px' }}>
          <div className="section">
            <motion.div
              initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.6 }}
            >
              <div className="section-label"><Terminal size={12} /> Checkpoint Gallery</div>
              <h2 className="section-title" style={{ marginBottom: 12 }}>
                Every interaction is<br/>
                <span className="hl-c">Evidence of Done.</span>
              </h2>
              <p style={{ color: C.muted, fontSize: 16, maxWidth: 520, lineHeight: 1.65, marginTop: 16 }}>
                Checkpoints aren&rsquo;t just screenshots — they&rsquo;re timestamped bundles of{' '}
                <strong style={{ color: C.text }}>visual state + console logs + network payloads.</strong>
                {' '}Perfect for bug reports, compliance audits, and regression baselines.
              </p>
            </motion.div>

            {/* Checkpoint selector cards */}
            <div className="cp-grid">
              {CHECKPOINTS.map((cp, i) => (
                <motion.div
                  key={cp.id}
                  className={`cp-card ${activeCP === i ? 'active' : ''}`}
                  style={{ '--cp-color': cp.color } as React.CSSProperties}
                  onClick={() => setActiveCP(i)}
                  initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }} transition={{ duration: 0.5, delay: i * 0.08 }}
                  whileHover={{ scale: 1.02 }}
                >
                  <div className="cp-thumb" style={{ background: cp.preview.bg }}>
                    {cp.preview.dots.map((d, di) => (
                      <div key={di} className="cp-thumb-dot" style={{ background: d, opacity: 0.85 + di * 0.05 }} />
                    ))}
                    {activeCP === i && (
                      <motion.div
                        style={{
                          position: 'absolute', inset: 0, borderRadius: 8,
                          background: `radial-gradient(circle, ${cp.color}22, transparent)`,
                        }}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      />
                    )}
                  </div>
                  <div className="cp-num">CP_{cp.id.toString().padStart(2, '0')}</div>
                  <div className="cp-label">{cp.label}</div>
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: cp.color }} />
                    <span style={{ fontSize: 10, color: C.muted, fontFamily: 'JetBrains Mono' }}>
                      {cp.network.status}
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Detail panel */}
            <AnimatePresence mode="wait">
              <motion.div
                key={activeCP}
                className="cp-detail"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3 }}
                style={{ borderColor: CHECKPOINTS[activeCP].color + '55' }}
              >
                {/* Console logs */}
                <div>
                  <div className="cp-detail-title"><Terminal size={11} /> Console Logs</div>
                  {CHECKPOINTS[activeCP].consoleLogs.map((log, i) => {
                    const cls = log.includes('[INFO]') ? 'log-info' : log.includes('[WARN]') ? 'log-warn' : 'log-debug'
                    return (
                      <div key={i} className={`cp-log-line ${cls}`} style={{ fontFamily: 'JetBrains Mono', fontSize: 11 }}>
                        {log}
                      </div>
                    )
                  })}
                </div>

                {/* Network payload */}
                <div>
                  <div className="cp-detail-title"><Wifi size={11} /> Network Checkpoint</div>
                  <div className="net-badge" style={{
                    background: CHECKPOINTS[activeCP].accent,
                    border: `1px solid ${CHECKPOINTS[activeCP].color}44`,
                    borderRadius: 7,
                  }}>
                    <span
                      className={`net-method ${CHECKPOINTS[activeCP].network.method === 'GET' ? 'method-get' : 'method-post'}`}
                      style={{ fontFamily: 'JetBrains Mono' }}
                    >
                      {CHECKPOINTS[activeCP].network.method}
                    </span>
                    <span className="net-url" style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: C.text }}>
                      {CHECKPOINTS[activeCP].network.url}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: C.green, fontFamily: 'JetBrains Mono' }}>
                      {CHECKPOINTS[activeCP].network.status}
                    </span>
                  </div>
                  <div className="net-payload">{CHECKPOINTS[activeCP].network.payload}</div>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════
            SECTION 3 — SYNC-TO-SCALE
        ══════════════════════════════════════════════════════════════ */}
        <section id="sync">
          <div className="section">
            <div className="sync-grid">
              <motion.div
                initial={{ opacity: 0, x: -24 }} whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }} transition={{ duration: 0.7 }}
              >
                <div className="section-label"><Database size={12} /> Dashboard Integration</div>
                <h2 className="section-title" style={{ marginBottom: 20 }}>
                  Capture in the field.<br/>
                  <span className="hl-v">Orchestrate at scale.</span>
                </h2>
                <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.7, marginBottom: 28 }}>
                  The moment you hit Stop, your workflow JSON syncs to the Dashboard. Queue multiple
                  workflows into a test suite, set loops, and watch them run — with full diff analysis across every run.
                </p>

                {/* Animated JSON flow */}
                <div className="flow-vis">
                  {/* Extension node */}
                  <div className="flow-node" style={{ left: '5%', top: '50%', transform: 'translateY(-50%)' }}>
                    <div className="flow-node-icon" style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)' }}>
                      <Globe size={22} color={C.violetL} />
                    </div>
                    <span>Extension</span>
                  </div>

                  {/* JSON badge + track */}
                  <div className="flow-line" />
                  <div className="flow-dot-track">
                    <motion.div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: `${jsonPos}%`,
                        transform: 'translateX(-50%)',
                        background: C.violetL,
                        borderRadius: 6,
                        padding: '2px 7px',
                        fontSize: 9,
                        fontFamily: 'JetBrains Mono',
                        fontWeight: 700,
                        color: '#fff',
                        whiteSpace: 'nowrap',
                        boxShadow: `0 0 12px ${C.violet}88`,
                      }}
                    >
                      workflow.json
                    </motion.div>
                  </div>

                  {/* Dashboard node */}
                  <div className="flow-node" style={{ right: '5%', top: '50%', transform: 'translateY(-50%)' }}>
                    <div className="flow-node-icon" style={{ background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.3)' }}>
                      <Monitor size={22} color={C.cyanL} />
                    </div>
                    <span>Dashboard</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    { icon: <Zap size={14} />, label: 'Auto-sync on Stop', color: C.violetL },
                    { icon: <Layers size={14} />, label: 'Multi-workflow Queue', color: C.cyanL },
                    { icon: <BarChart3 size={14} />, label: 'Visual Diff Engine', color: C.green },
                  ].map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted }}>
                      <span style={{ color: f.color }}>{f.icon}</span> {f.label}
                    </div>
                  ))}
                </div>
              </motion.div>

              {/* Queue card */}
              <motion.div
                initial={{ opacity: 0, x: 24 }} whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }} transition={{ duration: 0.7, delay: 0.15 }}
              >
                <div className="queue-card">
                  <div className="queue-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Layers size={15} color={C.violetL} />
                      <span style={{ fontFamily: 'Syne', fontWeight: 700, fontSize: 14 }}>Regression Suite</span>
                    </div>
                    <span className="status-chip status-run">3 / 5 Running</span>
                  </div>
                  {[
                    { name: 'Checkout Flow', env: 'Staging', loops: 3,  status: 'pass' },
                    { name: 'Login Flow',    env: 'Prod',    loops: 1,  status: 'pass' },
                    { name: 'Cart Add',      env: 'Staging', loops: 5,  status: 'run'  },
                    { name: 'Search Filter', env: 'UAT',     loops: 2,  status: 'run'  },
                    { name: 'Form Submit',   env: 'Prod',    loops: 1,  status: 'run'  },
                  ].map((item, i) => (
                    <div key={i} className="queue-item">
                      <div className="queue-item-left">
                        <div className="queue-order">{i + 1}</div>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{item.name}</div>
                          <div style={{ fontSize: 10, color: C.muted, fontFamily: 'JetBrains Mono' }}>
                            {item.env} · {item.loops}× loop
                          </div>
                        </div>
                      </div>
                      <span className={`status-chip status-${item.status}`}>
                        {item.status === 'run' ? 'LIVE' : 'PASS'}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════
            SECTION 4 — SCENARIO PLAYBOOK
        ══════════════════════════════════════════════════════════════ */}
        <section id="playbook" style={{ background: 'linear-gradient(180deg, rgba(20,21,28,0.98), rgba(14,14,20,1))' }}>
          <div className="section">
            <motion.div
              initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.6 }}
              style={{ textAlign: 'center', marginBottom: 0 }}
            >
              <div className="section-label" style={{ justifyContent: 'center' }}>
                <Code2 size={12} /> Who it&rsquo;s for
              </div>
              <h2 className="section-title" style={{ textAlign: 'center' }}>
                Built for every team<br/>
                <span className="hl-v">that ships fast.</span>
              </h2>
            </motion.div>

            <div className="persona-grid">
              {PERSONAS.map((p, i) => (
                <motion.div
                  key={i}
                  className="persona-card"
                  style={{
                    '--persona-accent': p.accent,
                    '--persona-glow': p.glow,
                  } as React.CSSProperties}
                  initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }} transition={{ duration: 0.6, delay: i * 0.1 }}
                >
                  <div className="persona-icon-wrap" style={{ background: `${p.accent}18`, border: `1px solid ${p.accent}44` }}>
                    <p.icon size={20} color={p.accent} />
                  </div>
                  <div className="persona-role">{p.role}</div>
                  <div className="persona-headline">{p.headline}</div>
                  <div className="persona-body">{p.body}</div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════
            CTA
        ══════════════════════════════════════════════════════════════ */}
        <section className="cta-section">
          <div className="cta-glow" />
          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.7 }}
          >
            <div className="section-label" style={{ justifyContent: 'center', marginBottom: 24 }}>
              <FileJson size={12} /> Get started free
            </div>
            <h2 className="cta-title">
              Your workflows.<br />
              <span style={{ background: 'linear-gradient(135deg, #a78bfa, #67e8f9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                Your evidence.
              </span>
            </h2>
            <p className="cta-sub">
              Install the extension. Record your first workflow in under a minute.
              No config, no code, no friction.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <a href="https://chromewebstore.google.com" target="_blank" rel="noopener noreferrer" className="btn-primary">
                <Globe size={16} /> Add to Chrome — It&rsquo;s Free
              </a>
              <Link href="/login" className="btn-ghost">
                Open Dashboard <ArrowRight size={15} />
              </Link>
            </div>
          </motion.div>
        </section>

        {/* ── Footer ── */}
        <footer className="lp-footer">
          <span style={{ color: C.violetL, fontWeight: 600 }}>Workflow Automator</span>
          {' '}· Built for teams that ship fast ·{' '}
          <Link href="/login" style={{ color: C.muted, textDecoration: 'underline' }}>Dashboard</Link>
        </footer>

      </div>
    </>
  )
}
