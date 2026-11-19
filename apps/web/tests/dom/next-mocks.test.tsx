/**
 * FE-G4 DOM tests — modular mocks for Next.js boundaries.
 *
 * These prove the mock factories work, so future page/layout tests can reuse
 * them instead of inventing per-file stubs.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNextFontMock } from '../setup/mocks/next-font';
import { mockNextNavigation } from '../setup/mocks/next-navigation';

afterEach(() => {
  vi.doUnmock('next/navigation');
  vi.resetModules();
});

describe('next/font mock factory', () => {
  it('returns the shape next/font exposes to a layout', () => {
    const font = createNextFontMock('inter', '--font-inter');

    expect(font).toStrictEqual({
      className: 'font-inter',
      variable: '--font-inter',
      style: { fontFamily: 'inter' },
    });
  });
});

describe('next/navigation mock factory', () => {
  it('exposes router hooks and records navigation calls', async () => {
    const mocks = mockNextNavigation({ pathname: '/dashboard', searchParams: 'code=abc' });
    const { usePathname, useSearchParams, useRouter } = await import('next/navigation');

    function Probe() {
      const router = useRouter();
      const pathname = usePathname();
      const code = useSearchParams().get('code');

      return (
        <button type="button" onClick={() => router.push('/events')}>
          {pathname}:{code}
        </button>
      );
    }

    const user = userEvent.setup();
    render(<Probe />);

    await user.click(screen.getByRole('button', { name: '/dashboard:abc' }));

    expect(mocks.useRouter().push).toHaveBeenCalledWith('/events');
  });
});
