'use client'

import { motion } from 'framer-motion'
import { Mail, MessageSquare, Send, Globe, ChevronLeft, MapPin } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { SUPPORT_EMAIL, DISCORD_URL } from '@/lib/site-config'

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

export default function ContactPage() {
  const [formState, setFormState] = useState<'idle' | 'sending' | 'success'>('idle')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFormState('sending')
    setTimeout(() => setFormState('success'), 1500)
  }

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
          max-width: 1000px;
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
        }
        .hero-title span {
          background: linear-gradient(135deg, ${C.violetL} 0%, ${C.cyan} 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .hero-sub {
          font-size: 18px;
          color: ${C.muted};
          max-width: 500px;
          margin-bottom: 64px;
          line-height: 1.6;
        }

        .grid {
          display: grid;
          grid-template-columns: 1fr 1.2fr;
          gap: 32px;
        }
        @media (max-width: 850px) { .grid { grid-template-columns: 1fr; } }

        .contact-info {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .info-card {
          background: ${C.glass};
          border: 1px solid ${C.border};
          border-radius: 20px;
          padding: 24px;
          backdrop-filter: blur(8px);
          display: flex;
          gap: 20px;
        }

        .icon-wrap {
          width: 48px;
          height: 48px;
          border-radius: 12px;
          background: rgba(124,58,237,0.1);
          border: 1px solid rgba(124,58,237,0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          color: ${C.violetL};
          flex-shrink: 0;
        }

        .info-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: ${C.cyan};
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 4px;
        }
        .info-value {
          font-size: 16px;
          font-weight: 600;
          color: ${C.text};
        }

        .form-card {
          background: ${C.glass};
          border: 1px solid ${C.border};
          border-radius: 24px;
          padding: 40px;
          backdrop-filter: blur(12px);
          box-shadow: 0 20px 50px rgba(0,0,0,0.3);
        }

        .form-group {
          margin-bottom: 24px;
        }
        .label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: ${C.muted};
          margin-bottom: 8px;
        }
        .input, .textarea {
          width: 100%;
          background: rgba(0,0,0,0.2);
          border: 1px solid ${C.border};
          border-radius: 12px;
          padding: 14px 18px;
          color: ${C.text};
          font-family: inherit;
          font-size: 15px;
          transition: all 0.2s;
          outline: none;
        }
        .input:focus, .textarea:focus {
          border-color: ${C.violetL};
          background: rgba(0,0,0,0.3);
          box-shadow: 0 0 0 4px rgba(124,58,237,0.1);
        }

        .btn-submit {
          width: 100%;
          padding: 16px;
          background: linear-gradient(135deg, ${C.violet}, #5b21b6);
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          box-shadow: 0 8px 24px rgba(124,58,237,0.3);
          transition: all 0.2s;
        }
        .btn-submit:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 12px 30px rgba(124,58,237,0.4);
        }
        .btn-submit:disabled { opacity: 0.7; cursor: not-allowed; }

        .success-msg {
          text-align: center;
          color: ${C.cyan};
          font-weight: 600;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }

        .glow-v {
          position: absolute;
          top: 10%;
          right: -10%;
          width: 500px;
          height: 500px;
          background: radial-gradient(circle, rgba(124,58,237,0.1) 0%, transparent 70%);
          pointer-events: none;
        }
        .glow-c {
          position: absolute;
          bottom: 10%;
          left: -10%;
          width: 400px;
          height: 400px;
          background: radial-gradient(circle, rgba(6,182,212,0.06) 0%, transparent 70%);
          pointer-events: none;
        }

        @media (max-width: 600px) {
          .container { padding: 40px 16px; }
          .hero-title { font-size: clamp(28px, 8vw, 42px); }
          .hero-sub { font-size: 15px; margin-bottom: 32px; }
          .form-card { padding: 24px; border-radius: 20px; }
          .info-card { padding: 16px; gap: 12px; }
          .icon-wrap { width: 40px; height: 40px; }
          .info-value { font-size: 14px; }
        }
      `}</style>

      <div className="glow-v" />
      <div className="glow-c" />

      <div className="container">
        <Link href="/" className="nav-back">
          <ChevronLeft size={16} />
          Back to Home
        </Link>

        <div className="grid">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h1 className="hero-title">Get in <span>Touch</span>.</h1>
            <p className="hero-sub">
              Have a question about Workflow Automator? We&apos;re here to help you automate your web workflows seamlessly.
            </p>

            <div className="contact-info">
              <div className="info-card">
                <div className="icon-wrap"><Mail size={20} /></div>
                <div>
                  <div className="info-label">Email Support</div>
                  <div className="info-value">{SUPPORT_EMAIL}</div>
                </div>
              </div>
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="info-card" style={{ textDecoration: 'none' }}>
                <div className="icon-wrap"><MessageSquare size={20} /></div>
                <div>
                  <div className="info-label">Community</div>
                  <div className="info-value">Discord Server</div>
                </div>
              </a>
              <div className="info-card">
                <div className="icon-wrap"><Globe size={20} /></div>
                <div>
                  <div className="info-label">Status</div>
                  <div className="info-value">All systems operational</div>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="form-card">
              {formState === 'success' ? (
                <div className="success-msg">
                  <div className="icon-wrap" style={{ width: 64, height: 64 }}>
                    <Send size={32} />
                  </div>
                  <h2 style={{ fontFamily: 'Syne', fontSize: 24, color: '#fff' }}>Message Sent!</h2>
                  <p style={{ color: C.muted }}>Thanks for reaching out. We&apos;ll get back to you within 24 hours.</p>
                  <button 
                    className="btn-submit" 
                    style={{ marginTop: 20, width: 'auto' }}
                    onClick={() => setFormState('idle')}
                  >
                    Send another message
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit}>
                  <div className="form-group">
                    <label className="label">Your Name</label>
                    <input className="input" placeholder="Developer One" required />
                  </div>
                  <div className="form-group">
                    <label className="label">Work Email</label>
                    <input className="input" type="email" placeholder="dev@company.com" required />
                  </div>
                  <div className="form-group">
                    <label className="label">How can we help?</label>
                    <textarea className="textarea" rows={4} placeholder="Tell us about your automation goals..." required />
                  </div>
                  <button className="btn-submit" type="submit" disabled={formState === 'sending'}>
                    {formState === 'sending' ? 'Sending...' : (
                      <>
                        <Send size={18} />
                        Send Message
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        </div>
      </div>

      <footer style={{ textAlign: 'center', padding: '48px 24px', color: C.muted, fontSize: '13px' }}>
        © 2024 Workflow Automator. Built for secure web automation.
      </footer>
    </div>
  )
}
