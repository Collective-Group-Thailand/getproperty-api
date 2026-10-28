import { FacebookError, FacebookPagesUnavailable, FacebookUnavailableError } from './facebook-pages.port';
import { FakeFacebookPages } from './fake-facebook-pages';

describe('Facebook Pages port (G4, D-288)', () => {
  it('maps Graph API errors: token refused vs retryable', () => {
    expect(new FacebookError(400, 190, 'x').tokenRefused).toBe(true);
    expect(new FacebookError(400, 190, 'x').retryable).toBe(false);
    expect(new FacebookError(403, 200, 'x').tokenRefused).toBe(true);
    expect(new FacebookError(400, 32, 'x').retryable).toBe(true);
    expect(new FacebookError(503, null, 'x').retryable).toBe(true);
    expect(new FacebookError(400, 100, 'x').retryable).toBe(false);
  });

  it('is off without an approved app (O-029)', async () => {
    await expect(new FacebookPagesUnavailable().page()).rejects.toBeInstanceOf(FacebookUnavailableError);
  });

  it('fake: publishes, edits and removes; revoked and busy tokens refuse', async () => {
    const fb = new FakeFacebookPages();
    expect(await fb.page('fake-page-token-Baan', '102345678901234')).toEqual({
      id: '102345678901234',
      name: 'Baan',
    });
    const { postId } = await fb.publish('fake-page-token-Baan', '102345678901234', {
      message: 'hello',
      link: 'https://x.test/s/abc',
    });
    await fb.update('fake-page-token-Baan', postId, { message: 'new' });
    expect(fb.posts.get(postId)?.message).toBe('new');
    await fb.remove('fake-page-token-Baan', postId);
    expect(fb.posts.has(postId)).toBe(false);
    await expect(fb.page('fake-page-token-revoked', '1')).rejects.toMatchObject({ code: 190 });
    await expect(fb.publish('fake-page-token-busy', '1', { message: 'm', link: 'l' })).rejects.toMatchObject({
      code: 32,
    });
  });
});
