import type { ReactNode } from 'react';

interface RoutePlaceholderProps {
  title: string;
  description: string;
  children?: ReactNode;
}

/**
 * Temporary shell for routes whose screens are implemented by later tasks.
 * It contains no product logic, data fetching, or forms.
 */
export function RoutePlaceholder({ title, description, children }: RoutePlaceholderProps) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-xs font-semibold tracking-[0.2em] text-primary uppercase">Skoriva</p>
        <h1 className="text-2xl font-bold tracking-tight text-card-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        {children}
      </section>
    </main>
  );
}
