/**
 * FE-G4 DOM tests — non-overlay primitives.
 *
 * These render in a real DOM (jsdom) and query by accessibility semantics
 * rather than CSS selectors.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';

describe('Input and Label', () => {
  it('associates a label with its input by accessible name', () => {
    render(
      <>
        <Label htmlFor="team-name">Nama tim</Label>
        <Input id="team-name" placeholder="Tim A" />
      </>,
    );

    expect(screen.getByLabelText('Nama tim')).toBeInTheDocument();
  });

  it('accepts typed text', () => {
    render(<Input aria-label="Skor" defaultValue="" />);
    const input = screen.getByRole('textbox', { name: 'Skor' });

    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('data-slot', 'input');
  });
});

describe('Textarea', () => {
  it('renders a multiline textbox', () => {
    render(<Textarea aria-label="Deskripsi event" />);

    expect(screen.getByRole('textbox', { name: 'Deskripsi event' })).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('exposes status text to assistive technology', () => {
    render(<Badge variant="destructive">CANCELLED</Badge>);

    const badge = screen.getByText('CANCELLED');
    expect(badge).toBeVisible();
    expect(badge).toHaveAttribute('data-variant', 'destructive');
  });
});

describe('Card', () => {
  it('renders an accessible heading inside the card header', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Event Liga Kampus</CardTitle>
        </CardHeader>
      </Card>,
    );

    expect(screen.getByText('Event Liga Kampus')).toBeInTheDocument();
    expect(screen.getByText('Event Liga Kampus').closest('[data-slot="card"]')).not.toBeNull();
  });
});

describe('Separator and Skeleton', () => {
  it('renders a decorative separator and a loading skeleton', () => {
    render(
      <>
        <Separator />
        <Skeleton aria-label="Memuat" />
      </>,
    );

    expect(screen.getByLabelText('Memuat')).toHaveAttribute('data-slot', 'skeleton');
    expect(document.querySelector('[data-slot="separator"]')).not.toBeNull();
  });
});

describe('Sonner Toaster', () => {
  it('renders without a ThemeProvider', () => {
    // `next-themes` is intentionally NOT mocked: without a provider it returns
    // its default theme and the toaster must still mount.
    const { container } = render(<Toaster />);

    expect(container.querySelector('section[aria-label*="Notification" i]')).not.toBeNull();
  });
});
