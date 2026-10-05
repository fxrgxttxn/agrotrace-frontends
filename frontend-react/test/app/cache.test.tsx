import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetSessionCache, useCacheWriter, type CacheWriter } from '../../src/app/cache';

describe('session cache generation', () => {
  it('a screen writes while its session lasts; after a reset its late writes are dropped, a new screen writes', () => {
    const client = new QueryClient();
    let writer: CacheWriter | null = null;
    const Probe = () => {
      writer = useCacheWriter();
      return null;
    };
    const first = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    writer!.set(['channels'], { owner: 'A' });
    expect(client.getQueryData(['channels'])).toEqual({ owner: 'A' });
    const late = writer!;
    resetSessionCache(client);
    expect(client.getQueryData(['channels'])).toBeUndefined();
    late.set(['channels'], { owner: 'A, late' });
    expect(client.getQueryData(['channels'])).toBeUndefined();
    first.unmount();
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    writer!.set(['channels'], { owner: 'B' });
    expect(client.getQueryData(['channels'])).toEqual({ owner: 'B' });
  });
});
