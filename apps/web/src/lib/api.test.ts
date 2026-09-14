import { describe, expect, it } from 'vitest';
import { wsUrl } from './api';

describe('api helpers', () => {
  it('builds a websocket url from current origin', () => {
    expect(wsUrl()).toMatch(/^wss?:\/\/.+\/api\/realtime/);
  });
});
