import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from '../src/app/(public)/page';
import DashboardPage from '../src/app/(account)/dashboard/page';
import { Button } from '../src/components/ui/button';

describe('frontend foundation', () => {
  it('renders the minimal homepage shell', () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain('Skoriva');
    expect(html).toContain('Frontend foundation');
  });

  it('renders a route placeholder for future screens', () => {
    const html = renderToStaticMarkup(<DashboardPage />);

    expect(html).toContain('Dashboard');
    expect(html).toContain('task berikutnya');
  });

  it('renders the shadcn Button component', () => {
    const html = renderToStaticMarkup(<Button>Verifikasi shadcn</Button>);

    expect(html).toContain('data-slot="button"');
    expect(html).toContain('Verifikasi shadcn');
  });
});
