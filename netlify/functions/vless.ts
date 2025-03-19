interface VLESSConfig {
    UUID: string;
    XHTTP_PATH: string;
    MAX_BUFFERED_POSTS: number;
    MAX_POST_SIZE: number;
    SESSION_TIMEOUT: number;
}

// 基础配置
const CONFIG: VLESSConfig = {
    UUID: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    XHTTP_PATH: '/xblog',
    MAX_BUFFERED_POSTS: 30,
    MAX_POST_SIZE: 1000000,
    SESSION_TIMEOUT: 30000,
};

// 添加日志工具函数在配置后面
const log = {
    debug: (...args: any[]) => console.log('[DEBUG]', ...args),
    info: (...args: any[]) => console.log('[INFO]', ...args),
    warn: (...args: any[]) => console.log('[WARN]', ...args),
    error: (...args: any[]) => console.log('[ERROR]', ...args)
};

// 会话存储
const sessions = new Map<string, {
    nextSeq: number;
    target?: { host: string; port: number };
    pendingBuffers: Map<number, Uint8Array>;
    lastActive: number;
}>();

// VLESS 协议常量
const VLESS = {
    VERSION: new Uint8Array([0]),
    ADDR_TYPE: {
        IPv4: 1,
        Domain: 2,
        IPv6: 3,
    }
};

// 工具函数
function makeHeaders(addChunked = false): HeadersInit {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Padding': randomPadding(),
    };
    
    if (addChunked) {
        headers['Content-Type'] = 'text/event-stream';
        headers['Transfer-Encoding'] = 'chunked';
    }
    
    return headers;
}

function randomPadding(): string {
    const len = 100 + Math.floor(Math.random() * 900);
    return 'X'.repeat(len);
}

// VLESS 协议解析
async function parseVLESSHeader(data: Uint8Array): Promise<{
    isValid: boolean;
    target?: { host: string; port: number };
    remainData?: Uint8Array;
}> {
    try {
        log.debug('Parsing VLESS header, data length:', data.length);
        
        if (data.length < 18) {
            log.warn('Header too short:', data.length);
            return { isValid: false };
        }
        
        const userID = data.slice(1, 17);
        if (!validateUUID(userID, CONFIG.UUID)) {
            log.warn('Invalid UUID');
            return { isValid: false };
        }

        const addType = data[17];
        let pos = 18;
        let host: string;
        
        log.debug('Parsing address type:', addType);
        
        switch (addType) {
            case VLESS.ADDR_TYPE.Domain:
                const lenDomain = data[pos++];
                host = new TextDecoder().decode(data.slice(pos, pos + lenDomain));
                pos += lenDomain;
                break;
            case VLESS.ADDR_TYPE.IPv4:
                host = Array.from(data.slice(pos, pos + 4)).join('.');
                pos += 4;
                break;
            case VLESS.ADDR_TYPE.IPv6:
                host = Array.from(data.slice(pos, pos + 16))
                    .map(b => b.toString(16))
                    .join(':');
                pos += 16;
                break;
            default:
                return { isValid: false };
        }

        const port = (data[pos] << 8) | data[pos + 1];
        pos += 2;

        log.info('Successfully parsed VLESS header:', { host, port });
        return {
            isValid: true,
            target: { host, port },
            remainData: data.slice(pos)
        };
    } catch (err) {
        log.error('Failed to parse VLESS header:', err);
        return { isValid: false };
    }
}

function validateUUID(test: Uint8Array, against: string): boolean {
    const valid = against.replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(valid.substr(i * 2, 2), 16);
    }
    for (let i = 0; i < 16; i++) {
        if (test[i] !== bytes[i]) return false;
    }
    return true;
}

// 主处理函数
export default async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log.info(`Handling ${request.method} request:`, url.pathname);
    
    const match = url.pathname.match(new RegExp(`${CONFIG.XHTTP_PATH}/([^/]+)(?:/([0-9]+))?$`));
    if (!match) {
        log.warn('URL pattern not matched');
        return new Response('Not Found', { status: 404 });
    }

    const [_, uuid, seqStr] = match;
    const seq = seqStr ? parseInt(seqStr) : null;
    log.debug('Request params:', { uuid, seq });

    // 清理过期会话
    let cleaned = 0;
    for (const [id, session] of sessions) {
        if (Date.now() - session.lastActive > CONFIG.SESSION_TIMEOUT) {
            sessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        log.info(`Cleaned ${cleaned} expired sessions`);
    }

    // GET 请求处理下行数据
    if (request.method === 'GET' && !seq) {
        log.info('Processing GET request for UUID:', uuid);
        const session = sessions.get(uuid);
        if (!session?.target) {
            log.warn('Session not found for GET request');
            return new Response('Session not found', { status: 404 });
        }

        const targetUrl = `https://${session.target.host}:${session.target.port}`;
        log.info('Forwarding to:', targetUrl);
        try {
            const proxyResp = await fetch(targetUrl, {
                method: 'GET',
                headers: makeHeaders(true)
            });
            log.info('Proxy response received:', proxyResp.status);
            return new Response(proxyResp.body, {
                headers: makeHeaders(true)
            });
        } catch (err) {
            log.error('Proxy request failed:', err);
            return new Response('Proxy Error', { status: 502 });
        }
    }

    // POST 请求处理上行数据
    if (request.method === 'POST' && seq !== null) {
        log.info('Processing POST request:', { uuid, seq });
        let session = sessions.get(uuid);
        
        const size = parseInt(request.headers.get('content-length') || '0');
        log.debug('POST data size:', size);
        
        if (size > CONFIG.MAX_POST_SIZE) {
            log.warn('Payload too large:', size);
            return new Response('Payload too large', { status: 413 });
        }

        const data = new Uint8Array(await request.arrayBuffer());

        if (!session) {
            if (seq !== 0) {
                log.warn('Invalid sequence for new session:', seq);
                return new Response('Invalid sequence', { status: 400 });
            }
            
            log.info('Creating new session');
            const parsed = await parseVLESSHeader(data);
            if (!parsed.isValid || !parsed.target) {
                log.error('Invalid VLESS header for new session');
                return new Response('Invalid VLESS header', { status: 400 });
            }

            session = {
                nextSeq: 0,
                target: parsed.target,
                pendingBuffers: new Map(),
                lastActive: Date.now()
            };
            sessions.set(uuid, session);
            log.info('New session created:', { uuid, target: parsed.target });
        }

        session.lastActive = Date.now();
        session.pendingBuffers.set(seq, data);
        log.debug('Stored packet:', { seq, size: data.length });

        if (session.pendingBuffers.size > CONFIG.MAX_BUFFERED_POSTS) {
            log.warn('Too many buffered posts:', session.pendingBuffers.size);
            sessions.delete(uuid);
            return new Response('Too many buffered posts', { status: 429 });
        }

        // 处理已排序的数据包
        let processed = 0;
        while (session.pendingBuffers.has(session.nextSeq)) {
            const buffer = session.pendingBuffers.get(session.nextSeq)!;
            session.pendingBuffers.delete(session.nextSeq);
            session.nextSeq++;
            processed++;
            
            if (session.nextSeq === 1) {
                log.info('Processing first packet');
                const parsed = await parseVLESSHeader(buffer);
                if (!parsed.isValid || !parsed.target) {
                    log.error('Invalid VLESS header in first packet');
                    sessions.delete(uuid);
                    return new Response('Invalid VLESS header', { status: 400 });
                }
            }
        }
        log.debug('Processed packets:', processed);

        return new Response('OK', { headers: makeHeaders() });
    }

    log.warn('Method not allowed:', request.method);
    return new Response('Method not allowed', { status: 405 });
}
