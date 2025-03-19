import { Context } from "https://edge.netlify.com";

const SETTINGS = {
    UUID: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    LOG_LEVEL: 'debug',
    BUFFER_SIZE: 128,
    XHTTP_PATH: '/xblog',
    MAX_BUFFERED_POSTS: 30,
    MAX_POST_SIZE: 1000000,
    SESSION_TIMEOUT: 30000,
};

// 存储会话状态
const sessions = new Map<string, Session>();

// 工具函数
function log(type: string, ...args: any[]) {
    console.log(`[${new Date().toISOString()}] [${type}]`, ...args);
}

// VLESS 协议解析相关功能
// 修改 UUID 解析函数
function parseUUID(uuid: string): Uint8Array {
    try {
        const cleanUUID = uuid.replace(/-/g, '');
        const bytes = new Uint8Array(16);
        
        for (let i = 0; i < 16; i++) {
            bytes[i] = parseInt(cleanUUID.substr(i * 2, 2), 16);
        }
        
        log('debug', `Parsed UUID bytes: [${Array.from(bytes)}]`);
        return bytes;
    } catch (err) {
        log('error', `UUID parse error: ${err.message}`);
        throw new Error('Failed to parse UUID');
    }
}

// 修改 UUID 验证函数
function validateUUID(received: Uint8Array, expected: Uint8Array): boolean {
    try {
        if (received.length !== 16 || expected.length !== 16) {
            log('error', `Invalid UUID length - received: ${received.length}, expected: 16`);
            return false;
        }

        // 添加更多日志以便调试
        const receivedHex = Array.from(received).map(b => b.toString(16).padStart(2, '0')).join('');
        const expectedHex = Array.from(expected).map(b => b.toString(16).padStart(2, '0')).join('');
        
        log('debug', `Comparing UUIDs:`);
        log('debug', `Received: ${receivedHex}`);
        log('debug', `Expected: ${expectedHex}`);

        return received.every((val, idx) => val === expected[idx]);
    } catch (err) {
        log('error', `UUID validation error: ${err.message}`);
        return false;
    }
}

// 修改头部解析中的 UUID 处理
async function readVlessHeader(chunk: Uint8Array, uuid: string) {
    try {
        if (chunk.length < 18) {
            throw new Error('Insufficient data length');
        }

        const version = chunk[0];
        const receivedUUID = chunk.slice(1, 17);
        log('debug', `Processing VLESS header - version: ${version}`);
        
        // Base64 encode UUID for logging
        const b64ReceivedUUID = btoa(String.fromCharCode(...receivedUUID));
        log('debug', `Received UUID (base64): ${b64ReceivedUUID}`);
        
        const expectedUUID = parseUUID(uuid);
        const b64ExpectedUUID = btoa(String.fromCharCode(...expectedUUID));
        log('debug', `Expected UUID (base64): ${b64ExpectedUUID}`);

        if (!validateUUID(receivedUUID, expectedUUID)) {
            throw new Error('Invalid UUID');
        }

        const addonsLength = chunk[17];
        const command = chunk[18 + addonsLength];
        
        if (command !== 1) { // 1 = TCP
            throw new Error(`Unsupported command: ${command}`);
        }

        // 读取地址信息
        const portIndex = 18 + addonsLength + 2;
        const portBytes = chunk.slice(portIndex, portIndex + 2);
        const port = (portBytes[0] << 8) | portBytes[1];
        
        const addressType = chunk[portIndex + 2];
        let address = '';
        let headerEnd = 0;

        switch (addressType) {
            case 1: // IPv4
                const ipv4Bytes = chunk.slice(portIndex + 3, portIndex + 7);
                address = Array.from(ipv4Bytes).join('.');
                headerEnd = portIndex + 7;
                break;
            case 2: // Domain
                const domainLen = chunk[portIndex + 3];
                const domain = new TextDecoder().decode(
                    chunk.slice(portIndex + 4, portIndex + 4 + domainLen)
                );
                address = domain;
                headerEnd = portIndex + 4 + domainLen;
                break;
            case 3: // IPv6
                const ipv6Bytes = chunk.slice(portIndex + 3, portIndex + 19);
                address = Array.from(ipv6Bytes)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join(':');
                headerEnd = portIndex + 19;
                break;
            default:
                throw new Error(`Unsupported address type: ${addressType}`);
        }

        return {
            version,
            addr: address,
            port,
            rawHeader: chunk.slice(0, headerEnd),
            rawDataIndex: headerEnd,
        };
    } catch (err) {
        log('error', `VLESS header parse error: ${err.message}`);
        throw err;
    }
}

class VlessSession {
    uuid: string;
    nextSeq: number = 0;
    initialized: boolean = false;
    pendingBuffers: Map<number, Uint8Array> = new Map();
    remoteConnection: TransformStream;
    vlessResponseHeader: Uint8Array | null = null;
    
    constructor(uuid: string) {
        this.uuid = uuid;
        this.remoteConnection = new TransformStream();
        log('debug', `Created new VLESS session: ${uuid}`);
    }

    async processInbound(seq: number, chunk: Uint8Array): Promise<void> {
        try {
            if (!this.initialized && seq === 0) {
                // 直接解析 VLESS 头部
                const vlessHeader = await readVlessHeader(chunk, SETTINGS.UUID);
                
                // 保存 VLESS 响应头用于下行连接
                this.vlessResponseHeader = new Uint8Array([vlessHeader.version, 0]);
                
                log('info', `VLESS target: ${vlessHeader.addr}:${vlessHeader.port}`);
                this.initialized = true;
                
                // 处理剩余数据
                const remainingData = chunk.slice(vlessHeader.rawDataIndex);
                if (remainingData.length > 0) {
                    const writer = this.remoteConnection.writable.getWriter();
                    await writer.write(remainingData);
                    writer.releaseLock();
                }
            } else {
                // 后续数据包直接转发
                const writer = this.remoteConnection.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
            }
        } catch (err) {
            log('error', `Process inbound error: ${err.message}`);
            throw err;
        }
    }

    // ... rest of the class implementation
}

class Session {
    vlessSession: VlessSession;
    uuid: string;
    nextSeq: number = 0;
    initialized: boolean = false;
    pendingBuffers: Map<number, Uint8Array> = new Map();
    transformer: TransformStream;
    controller: ReadableStreamDefaultController | null = null;
    
    constructor(uuid: string) {
        this.uuid = uuid;
        this.vlessSession = new VlessSession(uuid);
        this.transformer = new TransformStream();
        log('debug', `Created new session: ${uuid}`);
    }

    async processPacket(seq: number, data: Uint8Array): Promise<boolean> {
        this.pendingBuffers.set(seq, data);
        
        while(this.pendingBuffers.has(this.nextSeq)) {
            const nextData = this.pendingBuffers.get(this.nextSeq)!;
            this.pendingBuffers.delete(this.nextSeq);
            
            if(this.controller) {
                this.controller.enqueue(nextData);
            }
            
            this.nextSeq++;
        }
        
        if(this.pendingBuffers.size > SETTINGS.MAX_BUFFERED_POSTS) {
            throw new Error('Too many buffered packets');
        }
        
        return true;
    }

    getResponse(headers: HeadersInit): Response {
        return new Response(this.transformer.readable, {
            status: 200,
            headers
        });
    }

    cleanup() {
        this.pendingBuffers.clear();
        if(this.controller) {
            try {
                this.controller.close();
            } catch (e) {
                // 忽略关闭错误
            }
        }
    }
}

// 处理函数
export const handler = async (event: any) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    };

    try {
        const method = event.httpMethod || event.method || 'GET';
        const path = event.path || event.rawPath || '/';
        
        // 修正路径解析逻辑
        const pathRegex = new RegExp(`${SETTINGS.XHTTP_PATH}/([^/]+)(?:/([0-9]+))?$`);
        const match = path.match(pathRegex);
        
        if (!match) {
            log('warn', `Invalid path format: ${path}`);
            return new Response('Not Found', { status: 404 });
        }

        const [, uuid, seqStr] = match;
        const seq = seqStr ? parseInt(seqStr) : null;

        log('debug', `Parsed request - Method: ${method}, UUID: ${uuid}, Sequence: ${seq}`);

        // GET 请求处理
        if (method === 'GET') {
            log('info', `Creating new downstream for session ${uuid}`);
            let session = sessions.get(uuid);
            if (!session) {
                session = new Session(uuid);
                sessions.set(uuid, session);
            }
            
            headers['Content-Type'] = 'application/octet-stream';
            return session.getResponse(headers);
        }
        
        // POST 请求处理
        if (method === 'POST' && typeof seq === 'number') {
            log('info', `Processing packet seq=${seq} for session ${uuid}`);
            let session = sessions.get(uuid);
            if (!session) {
                session = new Session(uuid);
                sessions.set(uuid, session);
            }

            try {
                // 修改: 正确处理请求体
                let buffer: ArrayBuffer;
                if (event.body instanceof ArrayBuffer) {
                    buffer = event.body;
                } else if (typeof event.body === 'string') {
                    buffer = new TextEncoder().encode(event.body).buffer;
                } else if (event.rawBody) {
                    // 尝试使用 rawBody
                    buffer = typeof event.rawBody === 'string' 
                        ? new TextEncoder().encode(event.rawBody).buffer
                        : event.rawBody;
                } else {
                    throw new Error('Unsupported body format');
                }

                log('debug', `Received packet size: ${buffer.byteLength}`);
                await session.vlessSession.processInbound(seq, new Uint8Array(buffer));
                return new Response('OK', { status: 200, headers });
            } catch (err) {
                log('error', `Failed to process packet: ${err.message}`);
                session.cleanup();
                sessions.delete(uuid);
                return new Response('Internal Server Error', { status: 500 });
            }
        }

        return new Response('Not Found', { status: 404 });
    } catch (err) {
        log('error', `Handler error:`, err);
        return new Response('Internal Server Error', { 
            status: 500,
            headers: {
                'Content-Type': 'text/plain'
            }
        });
    }
};
