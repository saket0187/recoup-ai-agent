import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Recoup AI Agent',
  description:
    'Bounded revenue recovery for subscription and invoice businesses. Recovers what is recoverable, stops when it is not, and measures the difference against a randomised control.',
}

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
