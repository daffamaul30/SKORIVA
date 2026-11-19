/**
 * Test-only bridge between the browser-shaped client and Node's `fetch`.
 *
 * The HTTP client intentionally issues relative `/api/...` requests exactly like
 * a browser. Node's `fetch` has no document base and MSW's interceptor binds the
 * native `fetch` before any shim can wrap it, so this bridge records the raw
 * request and forwards an absolute equivalent to the same API.
 *
 * It records what production code *sent* (path, headers, credentials), which is
 * the part the tests assert. MSW still produces all responses.
 */

export const TEST_ORIGIN = 'http://localhost:3000';

export interface RecordedRequest {
  /** Path exactly as the client passed it, e.g. `/api/matches/m1`. */
  relativePath: string;
  url: URL;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

export interface FetchBridge {
  requests: RecordedRequest[];
  last(): RecordedRequest;
  restore(): void;
}

export function installFetchBridge(): FetchBridge {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];

  const bridged = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isRelative = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawUrl);
    const absolute = isRelative
      ? `${TEST_ORIGIN}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
      : rawUrl;

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    requests.push({
      relativePath: rawUrl,
      url: new URL(absolute),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
      body,
    });

    return original(absolute, init);
  }) as typeof globalThis.fetch;

  globalThis.fetch = bridged;

  return {
    requests,
    last() {
      const last = requests[requests.length - 1];
      if (!last) throw new Error('no request was recorded');
      return last;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
