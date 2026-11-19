/**
 * Factory for mocking `next/navigation` (FE-G4).
 *
 * Only tests that render components using router hooks should call this.
 * Each hook is a plain `vi.fn` so assertions stay explicit.
 */

import { vi } from 'vitest';

export interface NextNavigationMocks {
  useRouter: () => {
    push: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    back: ReturnType<typeof vi.fn>;
    forward: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    prefetch: ReturnType<typeof vi.fn>;
  };
  usePathname: () => string;
  useSearchParams: () => URLSearchParams;
  useParams: () => Record<string, string>;
}

export function mockNextNavigation(options: {
  pathname?: string;
  searchParams?: string;
  params?: Record<string, string>;
} = {}): NextNavigationMocks {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  };

  const mocks: NextNavigationMocks = {
    useRouter: () => router,
    usePathname: () => options.pathname ?? '/',
    useSearchParams: () => new URLSearchParams(options.searchParams ?? ''),
    useParams: () => options.params ?? {},
  };

  vi.doMock('next/navigation', () => mocks);

  return mocks;
}
