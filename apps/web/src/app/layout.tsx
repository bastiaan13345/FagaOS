import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'FagaOS — Operator Console',
  description:
    'Phase 3 product UI for FagaOS: persistent workspace shell, agent/task/session/approval operations, control-plane integration.',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
