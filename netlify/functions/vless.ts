import { Handler } from '@netlify/functions'
import net from 'net'

interface VLESSConfig {
    UUID: string;
    XHTTP_PATH: string;
    MAX_BUFFERED_POSTS: number;
    MAX_POST_SIZE: number;
    SESSION_TIMEOUT: number;
}

const CONFIG: VLESSConfig = {
    UUID: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    XHTTP_PATH: '/xblog',
    MAX_BUFFERED_POSTS: 30,
    MAX_POST_SIZE: 1000000,
    SESSION_TIMEOUT: 30000,
};

const log = {
    debug: (...args: any[]) => console.log('[DEBUG]', ...args),
    info: (...args: any[]) => console.log('[INFO]', ...args),
    warn: (...args: any[]) => console.log('[WARN]', ...args),
    error: (...args: any[]) => console.log('[ERROR]', ...args)
};

const VLESS = {
    VERSION: new Uint8Array([0]),
    ADDR_TYPE: {
        IPv4: 1,
        Domain: 2,
        IPv6: 3,
    }
};

// 会话存储
const sessions = new Map<string, {
    socket?: net.Socket;
    nextSeq: number;
    target?: { host: string; port: number };
    pendingBuffers: Map<number, Buffer>;
    lastActive: number;
}>();

// 添加连接黑名单
const blacklist = new Map<string, {
    failCount: number;
    lastFail: number;
}>();

// 修改连接配置
const CONNECTION_CONFIG = {
    TIMEOUT: 2000,          // 连接超时改为2秒
    RETRY_TIMES: 1,         // 只重试一次
    RETRY_DELAY: 500,       // 重试延迟改为0.5秒
    BAN_TIME: 30000,        // 封禁时间改为30秒
    MAX_FAIL_COUNT: 3,
    WHITELIST: ['1.187.2.14', 'localhost', '127.0.0.1']
};

// 优化会话管理
class SessionManager {
    private static instance: SessionManager;
    private sessions: Map<string, any>;
    private cleanupInterval: NodeJS.Timeout;

    private constructor() {
        this.sessions = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 5000);
    }

    static getInstance() {
        if (!SessionManager.instance) {
            SessionManager.instance = new SessionManager();
        }
        return SessionManager.instance;
    }

    get(uuid: string) {
        return this.sessions.get(uuid);
    }

    set(uuid: string, session: any) {
        this.sessions.set(uuid, session);
    }

    delete(uuid: string) {
        this.sessions.delete(uuid);
    }

    private cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (now - session.lastActive > CONFIG.SESSION_TIMEOUT) {
                session.socket?.destroy();
                this.sessions.delete(id);
            }
        }
    }
}

const sessionManager = SessionManager.getInstance();

// 优化黑名单管理
function checkBlacklist(host: string): boolean {
    // 白名单直接通过
    if (CONNECTION_CONFIG.WHITELIST.includes(host)) {
        return true;
    }

    const now = Date.now();
    const record = blacklist.get(host);
    
    // 清理过期黑名单
    for (const [h, r] of blacklist.entries()) {
        if (now - r.lastFail > CONNECTION_CONFIG.BAN_TIME * 2) {
            blacklist.delete(h);
        }
    }
    
    if (!record) return true;
    
    // 失败次数未超过限制
    if (record.failCount < CONNECTION_CONFIG.MAX_FAIL_COUNT) {
        return true;
    }
    
    // 检查是否已过封禁时间
    if (now - record.lastFail > CONNECTION_CONFIG.BAN_TIME) {
        // 重置失败计数
        record.failCount = 0;
        return true;
    }
    
    return false;
}

function randomPadding(): string {
    const len = 100 + Math.floor(Math.random() * 900);
    return 'X'.repeat(len);
}

async function parseVLESSHeader(data: Buffer): Promise<{
    isValid: boolean;
    target?: { host: string; port: number };
    remainData?: Buffer;
    resp?: Buffer;
}> {
    try {
        log.debug('Parsing VLESS header, data length:', data.length);
        
        if (data.length < 18) {
            log.warn('Header too short:', data.length);
            return { isValid: false };
        }
        
        // 版本检查
        if (data[0] !== 0) {
            log.warn('Invalid version:', data[0]);
            return { isValid: false };
        }

        // UUID 验证
        const userID = data.slice(1, 17);
        if (!validateUUID(userID, CONFIG.UUID)) {
            log.warn('Invalid UUID');
            return { isValid: false };
        }

        // 解析附加信息长度
        let pos = 17;
        const addInfoLen = data[pos];
        pos += 1;
        
        // 跳过附加信息
        pos += addInfoLen;
        
        if (pos >= data.length) {
            log.warn('Header ended unexpectedly after add info');
            return { isValid: false };
        }

        // 解析地址类型
        const addType = data[pos];
        pos += 1;
        
        log.debug('Parsing address type:', addType);
        let host: string;
        
        switch (addType) {
            case VLESS.ADDR_TYPE.Domain:
                if (pos >= data.length) {
                    log.warn('Header ended unexpectedly before domain length');
                    return { isValid: false };
                }
                const lenDomain = data[pos++];
                if (pos + lenDomain > data.length) {
                    log.warn('Header ended unexpectedly in domain');
                    return { isValid: false };
                }
                host = data.slice(pos, pos + lenDomain).toString();
                pos += lenDomain;
                break;
                
            case VLESS.ADDR_TYPE.IPv4:
                if (pos + 4 > data.length) {
                    log.warn('Header ended unexpectedly in IPv4');
                    return { isValid: false };
                }
                host = Array.from(data.slice(pos, pos + 4)).join('.');
                pos += 4;
                break;
                
            case VLESS.ADDR_TYPE.IPv6:
                if (pos + 16 > data.length) {
                    log.warn('Header ended unexpectedly in IPv6');
                    return { isValid: false };
                }
                host = Array.from(data.slice(pos, pos + 16))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join(':');
                pos += 16;
                break;
                
            default:
                log.warn('Invalid address type:', addType);
                return { isValid: false };
        }

        // 解析端口
        if (pos + 2 > data.length) {
            log.warn('Header ended unexpectedly before port');
            return { isValid: false };
        }
        const port = (data[pos] << 8) | data[pos + 1];
        pos += 2;

        log.info('Successfully parsed VLESS header:', { host, port });
        
        // 构造响应
        const resp = Buffer.from([0, 0]); // VLESS响应头

        return {
            isValid: true,
            target: { host, port },
            remainData: data.slice(pos),
            resp
        };
    } catch (err) {
        log.error('Failed to parse VLESS header:', err);
        return { isValid: false };
    }
}

function validateUUID(test: Uint8Array, against: string): boolean {
    const valid = against.replace(/-/g, '');
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(valid.substr(i * 2, 2), 16);
    }
    for (let i = 0; i < 16; i++) {
        if (test[i] !== bytes[i]) return false;
    }
    return true;
}

// 改进连接函数
async function connectToTarget(host: string, port: number): Promise<net.Socket> {
    let lastError;
    
    // 添加快速失败检测
    if (!checkBlacklist(host)) {
        const record = blacklist.get(host);
        const remainingTime = Math.ceil((CONNECTION_CONFIG.BAN_TIME - (Date.now() - record!.lastFail)) / 1000);
        throw new Error(`Target blocked for ${remainingTime} seconds`);
    }

    for (let i = 0; i <= CONNECTION_CONFIG.RETRY_TIMES; i++) {
        try {
            // 使用AbortController来实现快速超时
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), CONNECTION_CONFIG.TIMEOUT);

            const socket = await new Promise<net.Socket>((resolve, reject) => {
                const socket = net.createConnection({
                    host: host,
                    port: port
                });

                socket.once('connect', () => {
                    clearTimeout(timeoutId);
                    socket.setTimeout(CONNECTION_CONFIG.TIMEOUT);
                    resolve(socket);
                });

                socket.once('error', (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                });

                abortController.signal.addEventListener('abort', () => {
                    socket.destroy();
                    reject(new Error('Connection timeout'));
                });
            });

            // 连接成功，重置黑名单
            blacklist.delete(host);
            return socket;

        } catch (err) {
            lastError = err;
            updateBlacklist(host);
            
            if (i < CONNECTION_CONFIG.RETRY_TIMES) {
                log.info(`Retry attempt ${i + 1} for ${host}:${port}`);
                await new Promise(r => setTimeout(r, CONNECTION_CONFIG.RETRY_DELAY));
            }
        }
    }
    
    throw lastError;
}

// 分离超时连接逻辑
function connectWithTimeout(host: string, port: number): Promise<net.Socket> {
    // 检查黑名单状态
    if (!checkBlacklist(host)) {
        const record = blacklist.get(host);
        const remainingTime = Math.ceil((CONNECTION_CONFIG.BAN_TIME - (Date.now() - record!.lastFail)) / 1000);
        throw new Error(`Target blocked for ${remainingTime} seconds`);
    }

    return new Promise((resolve, reject) => {
        let timeoutId: NodeJS.Timeout;
        let isResolved = false;

        const socket = net.createConnection({
            host: host,
            port: port
        });

        const cleanup = () => {
            clearTimeout(timeoutId);
            socket.removeAllListeners();
            if (!isResolved) {
                socket.destroy();
            }
        };

        timeoutId = setTimeout(() => {
            cleanup();
            updateBlacklist(host);
            reject(new Error('Connection timeout'));
        }, CONNECTION_CONFIG.TIMEOUT);

        socket.once('connect', () => {
            isResolved = true;
            cleanup();
            
            // 连接成功后设置新的超时处理
            socket.setTimeout(CONNECTION_CONFIG.TIMEOUT);
            socket.on('timeout', () => {
                socket.destroy(new Error('Operation timeout'));
            });
            
            // 连接成功，重置黑名单状态
            if (blacklist.has(host)) {
                blacklist.delete(host);
            }
            
            resolve(socket);
        });

        socket.once('error', (err) => {
            cleanup();
            updateBlacklist(host);
            reject(err);
        });
    });
}

// 优化黑名单更新函数
function updateBlacklist(host: string): void {
    if (CONNECTION_CONFIG.WHITELIST.includes(host)) {
        return;
    }

    const record = blacklist.get(host) || { failCount: 0, lastFail: 0 };
    const now = Date.now();
    
    // 如果距离上次失败超过封禁时间，重置计数
    if (now - record.lastFail > CONNECTION_CONFIG.BAN_TIME) {
        record.failCount = 0;
    }
    
    record.failCount++;
    record.lastFail = now;
    blacklist.set(host, record);
    
    log.warn(`Updated blacklist for ${host}: fail count = ${record.failCount}`);
}

export const handler: Handler = async (event, context) => {
    const { path, httpMethod, body } = event;
    
    log.info(`Handling ${httpMethod} request:`, path);
    
    const match = path.match(new RegExp(`${CONFIG.XHTTP_PATH}/([^/]+)(?:/([0-9]+))?$`));
    if (!match) {
        log.warn('URL pattern not matched');
        return { statusCode: 404 };
    }

    const [_, uuid, seqStr] = match;
    const seq = seqStr ? parseInt(seqStr) : null;
    log.debug('Request params:', { uuid, seq });

    // 清理过期会话
    let cleaned = 0;
    for (const [id, session] of sessions.entries()) {
        if (Date.now() - session.lastActive > CONFIG.SESSION_TIMEOUT) {
            if (session.socket) {
                session.socket.destroy();
            }
            sessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        log.info(`Cleaned ${cleaned} expired sessions`);
    }

    // 通用响应头
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Padding': randomPadding(),
    };

    try {
        // GET请求处理
        if (httpMethod === 'GET' && !seq) {
            log.info('Processing GET request for UUID:', uuid);
            const session = sessionManager.get(uuid);
            
            if (!session?.socket || !session.target) {
                log.warn('Session not found for GET request');
                return { statusCode: 404 };
            }

            // 设置流式响应头
            headers['Content-Type'] = 'text/event-stream';
            headers['Transfer-Encoding'] = 'chunked';

            // 创建流式响应
            const stream = new ReadableStream({
                start(controller) {
                    session.socket!.on('data', (chunk) => {
                        controller.enqueue(chunk);
                    });
                    session.socket!.on('end', () => {
                        controller.close();
                    });
                    session.socket!.on('error', (err) => {
                        controller.error(err);
                    });
                }
            });

            return {
                statusCode: 200,
                headers,
                body: stream,
                isBase64Encoded: false
            };
        }

        // POST请求处理
        if (httpMethod === 'POST' && seq !== null && body) {
            log.info('Processing POST request:', { uuid, seq });
            let session = sessionManager.get(uuid);

            const data = Buffer.from(body, 'base64');
            log.debug('POST data size:', data.length);

            if (data.length > CONFIG.MAX_POST_SIZE) {
                log.warn('Payload too large:', data.length);
                return { statusCode: 413 };
            }

            // 新会话处理
            if (!session) {
                if (seq !== 0) {
                    log.warn('Invalid sequence for new session:', seq);
                    return { statusCode: 400 };
                }

                log.info('Creating new session');
                const vlessHeader = await parseVLESSHeader(data);
                
                if (!vlessHeader.isValid || !vlessHeader.target) {
                    log.error('Invalid VLESS header for new session');
                    return { statusCode: 400 };
                }

                try {
                    // 检查目标地址是否可连接
                    if (!checkBlacklist(vlessHeader.target.host)) {
                        const record = blacklist.get(vlessHeader.target.host);
                        const remainingTime = Math.ceil((CONNECTION_CONFIG.BAN_TIME - (Date.now() - record!.lastFail)) / 1000);
                        log.warn(`Target ${vlessHeader.target.host} is blocked for ${remainingTime} seconds`);
                        return { 
                            statusCode: 503,
                            body: `Service Temporarily Unavailable (${remainingTime}s)`,
                            headers: {
                                ...headers,
                                'Retry-After': remainingTime.toString()
                            }
                        };
                    }

                    const socket = await connectToTarget(vlessHeader.target.host, vlessHeader.target.port);

                    session = {
                        socket,
                        nextSeq: 0,
                        target: vlessHeader.target,
                        pendingBuffers: new Map(),
                        lastActive: Date.now()
                    };

                    sessionManager.set(uuid, session);
                    log.info('New session created:', { uuid, target: vlessHeader.target });

                    if (vlessHeader.resp) {
                        socket.write(vlessHeader.resp);
                    }
                    
                    if (vlessHeader.remainData) {
                        socket.write(vlessHeader.remainData);
                    }

                    // 设置连接空闲超时
                    socket.setTimeout(CONNECTION_CONFIG.TIMEOUT);
                    socket.on('timeout', () => {
                        log.warn(`Connection to ${vlessHeader.target.host}:${vlessHeader.target.port} timed out`);
                        socket.destroy();
                    });
                } catch (err) {
                    log.error('Failed to establish connection:', err.message);
                    return { 
                        statusCode: 503,
                        body: `Connection failed: ${err.message}`,
                        headers: {
                            ...headers,
                            'Retry-After': '5'
                        }
                    };
                }
            }

            // 更新会话状态
            session.lastActive = Date.now();
            session.pendingBuffers.set(seq, data);

            // 检查缓存大小
            if (session.pendingBuffers.size > CONFIG.MAX_BUFFERED_POSTS) {
                log.warn('Too many buffered posts:', session.pendingBuffers.size);
                session.socket?.destroy();
                sessionManager.delete(uuid);
                return { statusCode: 429 };
            }

            // 按序处理数据包
            while (session.pendingBuffers.has(session.nextSeq)) {
                const buffer = session.pendingBuffers.get(session.nextSeq)!;
                session.pendingBuffers.delete(session.nextSeq);
                session.socket?.write(buffer);
                session.nextSeq++;
            }

            return {
                statusCode: 200,
                headers,
                body: 'OK'
            };
        }

        // OPTIONS请求处理
        if (httpMethod === 'OPTIONS') {
            return {
                statusCode: 204,
                headers
            };
        }

        return { 
            statusCode: 405,
            body: 'Method not allowed'
        };

    } catch (error) {
        log.error('Handler error:', error);
        return {
            statusCode: 500,
            body: 'Internal server error'
        };
    }
}
