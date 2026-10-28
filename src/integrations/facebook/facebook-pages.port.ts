export const FACEBOOK_PAGES = Symbol('FACEBOOK_PAGES');

/** A Facebook Page as the Graph API shows it (`GET /{page-id}?fields=id,name`). */
export interface FacebookPage {
  id: string;
  name: string;
}

/** What getproperty posts on a Page for a listing: the text and the link Facebook previews (its Open Graph card). */
export interface FacebookPost {
  message: string;
  link: string;
}

/**
 * The Graph API refused a call. `code` is Facebook's error code: 190 = the Page access token is invalid or expired
 * (OAuthException), 10 / 200–299 = a permission is missing, 4 / 17 / 32 / 613 = rate limits, 1 / 2 = temporary
 * errors. `retryable` = try again later; `tokenRefused` = the Page must be connected again.
 */
export class FacebookError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'FacebookError';
  }

  get tokenRefused(): boolean {
    return (
      this.code === 190 || this.code === 10 || (this.code !== null && this.code >= 200 && this.code < 300)
    );
  }

  get retryable(): boolean {
    if (this.tokenRefused) return false;
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 341, 613].includes(this.code ?? -1);
  }
}

/** The provider is switched off (`FACEBOOK_MODE=off`, O-029: no approved Meta app yet). */
export class FacebookUnavailableError extends Error {
  constructor() {
    super('Facebook Page posting is not available (FACEBOOK_MODE=off)');
    this.name = 'FacebookUnavailableError';
  }
}

/**
 * Posting on a tenant's own Facebook Page with that Page's access token (D-288): check the Page, publish a post with
 * a link, edit its text, delete it. Never Facebook groups (the Groups API was removed in Graph API v19).
 */
export interface FacebookPagesPort {
  readonly mode: 'off' | 'fake' | 'real';
  page(pageToken: string, pageId: string): Promise<FacebookPage>;
  publish(pageToken: string, pageId: string, post: FacebookPost): Promise<{ postId: string }>;
  update(pageToken: string, postId: string, post: Pick<FacebookPost, 'message'>): Promise<void>;
  remove(pageToken: string, postId: string): Promise<void>;
}

/** `FACEBOOK_MODE=off`: every call refuses (connecting a Page answers `facebook.unavailable`). */
export class FacebookPagesUnavailable implements FacebookPagesPort {
  readonly mode = 'off' as const;
  page(): Promise<FacebookPage> {
    return Promise.reject(new FacebookUnavailableError());
  }
  publish(): Promise<{ postId: string }> {
    return Promise.reject(new FacebookUnavailableError());
  }
  update(): Promise<void> {
    return Promise.reject(new FacebookUnavailableError());
  }
  remove(): Promise<void> {
    return Promise.reject(new FacebookUnavailableError());
  }
}
