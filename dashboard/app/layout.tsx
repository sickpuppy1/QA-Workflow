import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Workflow Automator: Macro Recorder, Record & Replay',
  description: 'Automate repetitive tasks, auto-fill forms, and record web workflows with a no-code macro recorder.',
}

/** Root HTML shell; loads global styles only. */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
