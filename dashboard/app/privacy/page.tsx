'use client'

import { motion } from 'framer-motion'
import { Shield, Lock, Eye, FileText, ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { DASHBOARD_URL } from '@/../shared/dashboard-config'

const C = {
  bg0:    'rgba(14,14,20,1)',
  bg1:    'rgba(18,18,26,1)',
  glass:  'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.08)',
  violet: '#7c3aed',
  violetL: '#a78bfa',
  cyan:   '#06b6d4',
  text:   '#e2e8f0',
  muted:  '#6b7280',
}

export default function PrivacyPage() {
  return (
    <div className="lp">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        .lp {
          font-family: 'DM Sans', system-ui, sans-serif;
          background: ${C.bg0};
          color: ${C.text};
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
          overflow-x: hidden;
          position: relative;
        }

        .lp::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
          pointer-events: none;
          z-index: 0;
          opacity: 0.5;
        }

        .container {
          max-width: 800px;
          margin: 0 auto;
          padding: 80px 24px;
          position: relative;
          z-index: 1;
        }

        .nav-back {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: ${C.muted};
          text-decoration: none;
          font-size: 14px;
          margin-bottom: 48px;
          transition: color 0.2s;
        }
        .nav-back:hover { color: ${C.violetL}; }

        .hero-title {
          font-family: 'Syne', sans-serif;
          font-size: clamp(32px, 5vw, 54px);
          font-weight: 800;
          letter-spacing: -1.5px;
          margin-bottom: 16px;
          background: linear-gradient(135deg, ${C.text} 0%, ${C.muted} 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .last-updated {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: ${C.cyan};
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 64px;
        }

        .glass-card {
          background: ${C.glass};
          border: 1px solid ${C.border};
          border-radius: 24px;
          padding: 48px;
          backdrop-filter: blur(12px);
          margin-bottom: 32px;
        }

        .section {
          margin-bottom: 48px;
        }
        .section-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .section-icon {
          color: ${C.violetL};
        }
        .section-title {
          font-family: 'Syne', sans-serif;
          font-size: 20px;
          font-weight: 700;
          color: ${C.text};
        }
        .section-content {
          font-size: 16px;
          line-height: 1.7;
          color: ${C.muted};
        }
        .section-content strong {
          color: ${C.text};
        }
        .section-content ul {
          margin-top: 16px;
          list-style: none;
          padding-left: 0;
        }
        .section-content li {
          position: relative;
          padding-left: 24px;
          margin-bottom: 12px;
        }
        .section-content li::before {
          content: '→';
          position: absolute;
          left: 0;
          color: ${C.cyan};
          font-family: 'JetBrains Mono', monospace;
        }

        .cta-box {
          margin-top: 64px;
          padding: 32px;
          border-radius: 20px;
          background: linear-gradient(135deg, rgba(124,58,237,0.1), rgba(6,182,212,0.1));
          border: 1px solid ${C.border};
          text-align: center;
        }
        .cta-text {
          font-size: 15px;
          color: ${C.text};
          margin-bottom: 20px;
        }
        .btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          background: ${C.violet};
          color: white;
          text-decoration: none;
          border-radius: 10px;
          font-weight: 600;
          transition: transform 0.2s, background 0.2s;
        }
        .btn-primary:hover {
          transform: translateY(-2px);
          background: ${C.violetL};
        }

        .glow {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          width: 800px;
          height: 600px;
          background: radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%);
          pointer-events: none;
          z-index: 0;
        }

        @media (max-width: 600px) {
          .container { padding: 40px 16px; }
          .hero-title { font-size: clamp(28px, 8vw, 42px); margin-bottom: 8px; }
          .glass-card { padding: 24px; border-radius: 16px; }
          .section-title { font-size: 18px; }
          .section-content { font-size: 14px; }
        }
      `}</style>

      <div className="glow" />

      <div className="container">
        <Link href="/" className="nav-back">
          <ChevronLeft size={16} />
          Back to Home
        </Link>

        <motion.h1 
          className="hero-title"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          Privacy Policy
        </motion.h1>
        
        <motion.div 
          className="last-updated"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          Last updated: May 2024
        </motion.div>

        <motion.div 
          className="glass-card"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.8 }}
        >
          <div className="section">
            <div className="section-header">
              <Shield className="section-icon" size={24} />
              <h2 className="section-title">Overview</h2>
            </div>
            <div className="section-content">
              At <strong>Workflow Automator</strong>, reachable via <Link href={DASHBOARD_URL} style={{ color: C.cyan, textDecoration: 'none' }}>{DASHBOARD_URL}</Link>, one of our main priorities is the privacy of our visitors. This Privacy Policy document contains types of information that is collected and recorded by Workflow Automator and how we use it.
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <Lock className="section-icon" size={24} />
              <h2 className="section-title">Privacy-First Architecture</h2>
            </div>
            <div className="section-content">
              We employ strict <strong>data minimization</strong> and <strong>automated redaction</strong> strategies to ensure your sensitive information never leaves your browser:
              <ul>
                <li><strong>Sensitive Field Redaction:</strong> Our recorder automatically detects and redacts input from sensitive fields (passwords, OTPs, CVVs, API keys, and SSNs) based on heuristics and metadata. This data is never captured, stored, or transmitted.</li>
                <li><strong>Automated Binary Disposal:</strong> Non-essential binary payloads (videos, high-res images, PDFs) are identified and disposed of at the browser level. We only sync critical workflow metadata and debugging screenshots.</li>
                <li><strong>Network Payload Capping:</strong> To prevent data bloat and accidental exposure, network response captures are capped at 64KB. Transient background data is discarded unless critical to the workflow.</li>
                <li><strong>Edge-Level Protection:</strong> We enforce strict 10MB limits on all incoming payloads at the edge, preventing unintended "data dumping" and ensuring system stability.</li>
                <li><strong>Encrypted Synchronization:</strong> Your workflow data is encrypted at rest and tied strictly to your authenticated session. We use origin-validated security for all cross-context communication.</li>
              </ul>
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <Eye className="section-icon" size={24} />
              <h2 className="section-title">Information We Collect</h2>
            </div>
            <div className="section-content">
              We collect minimal information to provide the automation service:
              <ul>
                <li><strong>Account Information:</strong> Email address for authentication and synchronization.</li>
                <li><strong>Workflow Metadata:</strong> Names, timestamps, and execution status of your automations.</li>
                <li><strong>Execution Evidence:</strong> Screenshots and logs captured during your recording sessions to facilitate debugging and auditing.</li>
              </ul>
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <FileText className="section-icon" size={24} />
              <h2 className="section-title">How We Use Your Information</h2>
            </div>
            <div className="section-content">
              We use the information we collect in various ways, including to:
              <ul>
                <li>Provide, operate, and maintain our dashboard</li>
                <li>Improve, personalize, and expand our features</li>
                <li>Understand and analyze how you use Workflow Automator</li>
                <li>Develop new products, services, features, and functionality</li>
                <li>Communicate with you for customer service or updates</li>
              </ul>
            </div>
          </div>

          <div className="cta-box">
            <div className="cta-text">Have questions about our privacy practices?</div>
            <Link href="/contact" className="btn-primary">
              Contact Support
            </Link>
          </div>
        </motion.div>
      </div>

      <footer style={{ textAlign: 'center', padding: '48px 24px', color: C.muted, fontSize: '13px' }}>
        © 2024 Workflow Automator. Built for secure web automation.
      </footer>
    </div>
  )
}
