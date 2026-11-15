// Minimal CKB JSON-RPC client: several URLs tried in order, each retried once.

export interface Script { code_hash: string; hash_type: string; args: string }
export interface OutPoint { tx_hash: string; index: string }
export interface SearchKey {
  script: Script;
  script_type: 'lock' | 'type';
  script_search_mode?: 'prefix' | 'exact';
  filter?: Record<string, unknown>;
  with_data?: boolean;
}
export interface IndexerCell {
  output: { capacity: string; lock: Script; type?: Script | null };
  output_data?: string | null;
  out_point: OutPoint;
  block_number?: string;
  tx_index?: string;
}
export interface IndexerPage { objects: IndexerCell[]; last_cursor: string }
export interface LiveCellResult {
  cell: { output: { capacity: string; lock: Script; type?: Script | null }; data?: { content: string; hash: string } } | null;
  status: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly url?: string) { super(message); this.name = 'RpcError'; }
}

export interface RpcOptions { fetch?: FetchLike; retries?: number }

export class RpcClient {
  readonly urls: string[];
  private readonly fetchFn: FetchLike;
  private readonly retries: number;
  private id = 0;

  constructor(urls: string | string[], opts: RpcOptions = {}) {
    this.urls = Array.isArray(urls) ? [...urls] : [urls];
    if (this.urls.length === 0) throw new RpcError('no RPC url given');
    this.fetchFn = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.retries = opts.retries ?? 1;
  }

  /** Calls `method` on the first URL that answers; every URL gets `1 + retries` attempts. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    let last: unknown;
    for (const url of this.urls) {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await this.once<T>(url, method, params);
        } catch (e) { last = e; }
      }
    }
    throw last instanceof Error ? last : new RpcError(String(last));
  }

  private async once<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ++this.id, jsonrpc: '2.0', method, params }),
    });
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, res.status, url);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, url);
    if (!('result' in body)) throw new RpcError(`${method}: malformed response`, undefined, url);
    return body.result as T;
  }

  getCells(key: SearchKey, order: 'asc' | 'desc' = 'asc', limit = 100, cursor?: string): Promise<IndexerPage> {
    const params: unknown[] = [key, order, '0x' + limit.toString(16)];
    if (cursor) params.push(cursor);
    return this.call('get_cells', params);
  }

  /** All cells matching `key`, following the cursor. */
  async getAllCells(key: SearchKey, pageSize = 100, maxPages = 1000): Promise<IndexerCell[]> {
    const out: IndexerCell[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.getCells(key, 'asc', pageSize, cursor);
      out.push(...page.objects);
      if (page.objects.length < pageSize || !page.last_cursor || page.last_cursor === '0x') break;
      cursor = page.last_cursor;
    }
    return out;
  }

  getLiveCell(outPoint: OutPoint, withData = true): Promise<LiveCellResult> {
    return this.call('get_live_cell', [outPoint, withData]);
  }
  getTransaction(hash: string): Promise<unknown> { return this.call('get_transaction', [hash]); }
  getTipHeader(): Promise<Record<string, string>> { return this.call('get_tip_header', []); }
  getHeader(hash: string): Promise<Record<string, string> | null> { return this.call('get_header', [hash]); }
  sendTransaction(tx: unknown, outputsValidator: 'passthrough' | 'well_known_scripts_only' = 'passthrough'): Promise<string> {
    return this.call('send_transaction', [tx, outputsValidator]);
  }
}
