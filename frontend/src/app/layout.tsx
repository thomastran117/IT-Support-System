import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavShell } from '@/components/NavShell';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SmartDesk', template: '%s · SmartDesk' },
  description: 'SmartDesk IT support ticketing',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AuthProvider>
          <NavShell>{children}</NavShell>
        </AuthProvider>
      </body>
    </html>
  );
}
