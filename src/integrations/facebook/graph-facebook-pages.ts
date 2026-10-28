import {
  FacebookError,
  type FacebookPage,
  type FacebookPagesPort,
  type FacebookPost,
} from './facebook-pages.port';

/**
 * Facebook Graph API with a Page access token (D-288):
 * - `GET /{page-id}?fields=id,name` — the Page the token manages;
 * - `POST /{page-id}/feed` (`message`, `link`) → `{ id: "<page-id>_<post-id>" }` — needs `pages_manage_posts`;
 * - `POST /{page-post-id}` (`message`) — edits the text of a post the app published;
 * - `DELETE /{page-post-id}` → `{ success: true }`.
 * Errors come as `{ error: { message, type, code, error_subcode } }`. Form-encoded bodies, token in the body (never in a
 * logged URL), 10 s timeout.
 * // UNVERIFIED against live provider: written from the Graph API reference; needs the Meta app review of O-029.
 */
export class GraphFacebookPages implements FacebookPagesPort {
  readonly mode = 'real' as const;

  constructor(
    private readonly version = 'v21.0',
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>) {
    const url = `${this.baseUrl}/${this.version}/${path}`;
    const body = new URLSearchParams(params);
    const response =
      method === 'GET'
        ? await fetch(`${url}?${new URLSearchParams({ fields: params.fields ?? '' }).toString()}`, {
            headers: { authorization: `Bearer ${params.access_token}` },
            signal: AbortSignal.timeout(10_000),
          })
        : await fetch(url, {
            method,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(10_000),
          });
    const json = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number };
    } & T;
    if (!response.ok || json.error)
      throw new FacebookError(
        response.status,
        typeof json.error?.code === 'number' ? json.error.code : null,
        `Graph API ${method} ${path.split('/')[1] ?? path}: ${(json.error?.message ?? String(response.status)).slice(0, 200)}`,
      );
    return json as T;
  }

  async page(pageToken: string, pageId: string): Promise<FacebookPage> {
    const body = await this.call<{ id?: string; name?: string }>('GET', encodeURIComponent(pageId), {
      fields: 'id,name',
      access_token: pageToken,
    });
    if (!body.id || body.id !== pageId)
      throw new FacebookError(400, 100, 'the token does not manage this Page');
    return { id: body.id, name: body.name ?? '' };
  }

  async publish(pageToken: string, pageId: string, post: FacebookPost) {
    const body = await this.call<{ id?: string }>('POST', `${encodeURIComponent(pageId)}/feed`, {
      message: post.message,
      link: post.link,
      access_token: pageToken,
    });
    if (!body.id) throw new FacebookError(502, null, 'Graph API answered without a post id');
    return { postId: body.id };
  }

  async update(pageToken: string, postId: string, post: Pick<FacebookPost, 'message'>) {
    await this.call('POST', encodeURIComponent(postId), { message: post.message, access_token: pageToken });
  }

  async remove(pageToken: string, postId: string) {
    try {
      await this.call('DELETE', encodeURIComponent(postId), { access_token: pageToken });
    } catch (error) {
      // a post someone already deleted on Facebook is gone: nothing to do (code 100 "does not exist")
      if (error instanceof FacebookError && error.code === 100) return;
      throw error;
    }
  }
}
