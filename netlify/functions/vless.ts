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
function parseUUID(uuid: string): Uint8Array {
    uuid = uuid.replaceAll('-', '');
    const r: number[] = [];
    for (let i = 0; i < 16; i++) {
        r.push(parseInt(uuid.substr(i * 2, 2), 16));
    }
    return new Uint8Array(r);
}

function validateUUID(left: Uint8Array, right: Uint8Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

async function readVlessHeader(reader: ReadableStreamDefaultReader<Uint8Array>, uuid: string) {
    let readLen = 0;
    let header = new Uint8Array();

    async function readAtLeast(n: number): Promise<{ done: boolean; value: Uint8Array }> {
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        while (bytesRead < n) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            bytesRead += value.length;
        }
        
        if (bytesRead < n) {
            throw new Error('Insufficient data');
        }

        const merged = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return { value: merged, done: false };
    }

    // 读取前18字节 (version + uuid + addons)
    const { value: vlessHeader } = await readAtLeast(18);
    header = vlessHeader;
    readLen = header.length;

    const version = header[0];
    const uuidBytes = header.slice(1, 17);
    const requestUuid = parseUUID(uuid);
    
    if (!validateUUID(uuidBytes, requestUuid)) {
        throw new Error('Invalid UUID');
    }

    // 解析协议头
    const addonsLength = header[17];
    const command = header[18 + addonsLength];
    
    if (command !== 1) { // 1 = TCP
        throw new Error(`Unsupported command: ${command}`);
    }

    // 读取地址信息
    const portIndex = 18 + addonsLength + 2;
    const portBytes = header.slice(portIndex, portIndex + 2);
    const port = (portBytes[0] << 8) | portBytes[1];
    
    const addressType = header[portIndex + 2];
    let address = '';
    let headerEnd = 0;

    switch (addressType) {
        case 1: // IPv4
            const ipv4Bytes = header.slice(portIndex + 3, portIndex + 7);
            address = Array.from(ipv4Bytes).join('.');
            headerEnd = portIndex + 7;
            break;
        case 2: // Domain
            const domainLen = header[portIndex + 3];
            const domain = new TextDecoder().decode(
                header.slice(portIndex + 4, portIndex + 4 + domainLen)
            );
            address = domain;
            headerEnd = portIndex + 4 + domainLen;
            break;
        case 3: // IPv6
            const ipv6Bytes = header.slice(portIndex + 3, portIndex + 19);
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
        rawHeader: header.slice(0, headerEnd),
        rawDataIndex: headerEnd,
    };
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
        if (!this.initialized && seq === 0) {
            // 处理第一个数据包，解析 VLESS 头
            const streamReader = chunk.stream().getReader();
            const vlessHeader = await readVlessHeader(streamReader, SETTINGS.UUID);
            
            // 保存 VLESS 响应头用于下行连接
            this.vlessResponseHeader = new Uint8Array([vlessHeader.version, 0]);
            
            // 这里应该建立到目标地址的连接
            log('info', `VLESS target: ${vlessHeader.addr}:${vlessHeader.port}`);
            this.initialized = true;
            
            // 处理剩余数据
            const writer = this.remoteConnection.writable.getWriter();
            await writer.write(chunk.slice(vlessHeader.rawDataIndex));
            writer.releaseLock();
        } else {
            // 后续数据包直接转发
            const writer = this.remoteConnection.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
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
export const handler = async (request: Request, context: Context) => {
    log('debug', `Received request: ${context.requestId}`);
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    };

    try {
        // 直接从路径获取参数，避免使用 URL 对象
        const path = context.request.url || request.url || '/';
        log('info', `Request path: ${path}`);
        log('info', `Request method: ${request.method}`);
        
        // 从路径中提取参数
        const parts = path.split('/').filter(Boolean);
        if (parts.length < 1) {
            log('warn', 'Invalid path format');
            return new Response('Not Found', { status: 404 });
        }

        const uuid = parts[parts.length - 2];  // 倒数第二段为 uuid
        const seq = parts[parts.length - 1];   // 最后一段为序号
        
        if (!uuid) {
            log('warn', 'Missing UUID in path');
            return new Response('Not Found', { status: 404 });
        }

        log('debug', `Parsed UUID: ${uuid}, Sequence: ${seq}`);

        // GET 请求处理下行流
        if (request.method === 'GET' && !seq) {
            log('info', `Creating new downstream for session ${uuid}`);
            let session = sessions.get(uuid);
            if (!session) {
                session = new Session(uuid);
                sessions.set(uuid, session);
            }
            
            headers['Content-Type'] = 'application/octet-stream';
            return session.getResponse(headers);
        }
        
        // POST 请求处理上行数据
        if (request.method === 'POST' && seq) {
            const seqNum = parseInt(seq);
            if (isNaN(seqNum)) {
                return new Response('Bad Request', { status: 400 });
            }
            log('info', `Processing packet seq=${seqNum} for session ${uuid}`);
            let session = sessions.get(uuid);
            if (!session) {
                session = new Session(uuid);
                sessions.set(uuid, session);
            }

            try {
                const buffer = await request.arrayBuffer();
                log('debug', `Received packet size: ${buffer.byteLength}`);
                await session.processPacket(seqNum, new Uint8Array(buffer));
                return new Response('OK', { status: 200, headers });
            } catch (err) {
                log('error', `Failed to process packet: ${err.message}`);
                session.cleanup();
                sessions.delete(uuid);
                return new Response('Internal Server Error', { status: 500 });
            }
        }

        log('warn', 'Request did not match any handler');
        return new Response('Not Found', { status: 404 });
    } catch (err) {
        log('error', `Handler error: ${err.message}`);
        log('error', err.stack || 'No stack trace available');
        return new Response('Internal Server Error', { 
            status: 500,
            headers: {
                'Content-Type': 'text/plain'
            }
        });
    }
};
