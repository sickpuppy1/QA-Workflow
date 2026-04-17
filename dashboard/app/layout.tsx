import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'QA Workflow Dashboard',
  description: 'Record, replay, and compare workflow checkpoints',
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
