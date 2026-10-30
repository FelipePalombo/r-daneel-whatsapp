import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { publicAddress, type Address } from './gif-download.js';

export type HttpReply = { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; close: () => void };
export type PublicHttp = {
  resolve: (host: string) => Promise<Address[]>;
  request: (url: URL, address: Address, signal: AbortSignal, method: string, headers: Record<string, string>, body?: string) => Promise<HttpReply>;
};
const network: PublicHttp = {
  resolve: host => lookup(host, { all: true, verbatim: true }),
  request: (url, address, signal, method, headers, body) => new Promise((resolve, reject) => {
    const req = request(url, { method, headers, signal, agent: false, lookup: (_host, options, callback) => {
      if (options.all) (callback as unknown as (err: null, addresses: Address[]) => void)(null, [address]);
      else callback(null, address.address, address.family);
    } }, res => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, close: () => res.destroy() }));
    req.on('error', reject); req.end(body);
  }),
};

/** HTTPS público com IP fixado, corpo limitado e orçamento compartilhado pelo chamador. */
export async function publicHttp(value: string, options: {
  signal: AbortSignal; limit: number; allowedHost: (host: string) => boolean;
  method?: string; headers?: Record<string, string>; body?: string;
}, io: PublicHttp = network): Promise<{ body: Buffer; headers: HttpReply['headers'] }> {
  let url = new URL(value), method = options.method ?? 'GET', body = options.body;
  let headers = { ...options.headers };
  const work = async () => {
    for (let redirects = 0; redirects <= 3; redirects++) {
      options.signal.throwIfAborted();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !options.allowedHost(url.hostname)) throw new Error('Destino externo bloqueado.');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await io.resolve(host);
      options.signal.throwIfAborted();
      if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Endereço externo bloqueado.');
      const reply = await io.request(url, addresses[0]!, options.signal, method, headers, body);
      try {
        if ([301, 302, 303, 307, 308].includes(reply.status)) {
          if (redirects === 3 || typeof reply.headers.location !== 'string') throw new Error('Redirecionamento externo inválido.');
          const next = new URL(reply.headers.location, url);
          if (next.origin !== url.origin) headers = { 'User-Agent': headers['User-Agent'] ?? 'R-Daneel' };
          if (reply.status === 303 || ([301, 302].includes(reply.status) && method === 'POST')) { method = 'GET'; body = undefined; delete headers['Content-Type']; }
          url = next; continue;
        }
        if (reply.status !== 200) throw new Error('Serviço externo indisponível.');
        if (Number(reply.headers['content-length']) > options.limit) throw new Error('Resposta externa acima do limite.');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of reply.body) {
          options.signal.throwIfAborted(); size += chunk.length;
          if (size > options.limit) throw new Error('Resposta externa acima do limite.');
          chunks.push(Buffer.from(chunk));
        }
        if (!size) throw new Error('Resposta externa vazia.');
        return { body: Buffer.concat(chunks), headers: reply.headers };
      } finally { reply.close(); }
    }
    throw new Error('Redirecionamento externo inválido.');
  };
  options.signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const abort = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Contingência excedeu o tempo permitido.')); options.signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([work(), abort]); }
  finally { options.signal.removeEventListener('abort', onAbort); }
}
