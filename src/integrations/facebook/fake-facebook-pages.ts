import {
  FacebookError,
  type FacebookPage,
  type FacebookPagesPort,
  type FacebookPost,
} from './facebook-pages.port';

/**
 * Fake Pages for tests and `pnpm dev`: a token `fake-page-token-<name>` manages any Page id and the Page is named
 * `<name>`; `fake-page-token-revoked…` answers OAuth error 190 and `fake-page-token-busy…` the rate limit 32 on
 * posts. Posts are kept in memory for assertions; a removed post is gone.
 */
export class FakeFacebookPages implements FacebookPagesPort {
  readonly mode = 'fake' as const;
  readonly posts = new Map<string, { pageId: string; token: string; message: string; link: string }>();
  readonly removed: string[] = [];
  private seq = 0;

  private check(token: string): string {
    if (!token.startsWith('fake-page-token-') || token.startsWith('fake-page-token-revoked'))
      throw new FacebookError(400, 190, 'Error validating access token (OAuthException)');
    return token.slice('fake-page-token-'.length);
  }

  private settle<T>(work: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(work());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  page(pageToken: string, pageId: string): Promise<FacebookPage> {
    return this.settle(() => ({ id: pageId, name: this.check(pageToken) }));
  }

  publish(pageToken: string, pageId: string, post: FacebookPost) {
    return this.settle(() => {
      this.check(pageToken);
      if (pageToken.startsWith('fake-page-token-busy'))
        throw new FacebookError(400, 32, 'Page request limit reached');
      this.seq += 1;
      const postId = `${pageId}_${String(1000 + this.seq)}`;
      this.posts.set(postId, { pageId, token: pageToken, ...post });
      return { postId };
    });
  }

  update(pageToken: string, postId: string, post: Pick<FacebookPost, 'message'>) {
    return this.settle(() => {
      this.check(pageToken);
      const existing = this.posts.get(postId);
      if (!existing) throw new FacebookError(400, 100, 'Unsupported post request');
      existing.message = post.message;
    });
  }

  remove(pageToken: string, postId: string) {
    return this.settle(() => {
      this.check(pageToken);
      this.posts.delete(postId);
      this.removed.push(postId);
    });
  }
}
