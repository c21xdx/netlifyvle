import { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    UUID: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    BUFFER_SIZE: 16384,
    XHTTP_PATH: '/xblog',
    LOG_LEVEL: 'debug',  // 设置日志级别为 debug
} as const;

// 定义日志级别
const LOG_LEVELS = {
    'debug': 0,
    'info': 1,
    'warn': 2,
    'error': 3
} as const;

// 增强的日志函数
function log(type: string, ...args: unknown[]) {
    const currentLevel = LOG_LEVELS[type as keyof typeof LOG_LEVELS] || 0;
    const configLevel = LOG_LEVELS[SETTINGS.LOG_LEVEL as keyof typeof LOG_LEVELS] || 1;
    
    if (currentLevel >= configLevel) {
        const time = new Date().toISOString();
        console.log(`[${time}] [${type}]`, ...args);
    }
}

function validate_uuid(left: Uint8Array, right: Uint8Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

// ... existing code from deno.ts for concat_typed_arrays, parse_uuid ...

// VLESS 协议解析函数
async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid: string) {
    // ... existing code from deno.ts for read_vless_header ...
}

// 连接管理
const connections = new Map<string, {
    buffer: Map<number, Uint8Array>,
    stream: WritableStream | null,
    vlessHeader: any | null,
    remoteConnection: any | null,
    lastActive: number
}>();

// 清理超时连接
setInterval(() => {
    const now = Date.now();
    for (const [uuid, conn] of connections) {
        if (now - conn.lastActive > 30000) {
            if (conn.remoteConnection) {
                try {
                    conn.remoteConnection.close();
                } catch (e) {
                    // ignore
                }
            }
            connections.delete(uuid);
        }
    }
}, 5000);

export default async function handler(req: Request, context: Context) {
    const url = new URL(req.url);
    log('debug', `收到请求: ${req.method} ${url.pathname}`);
    
    // 检查路径是否包含配置的 XHTTP_PATH
    if (!url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        log('debug', `路径不匹配 XHTTP_PATH: ${url.pathname}`);
        return new Response('Not Found', { status: 404 });
    }
    
    const parts = url.pathname.split('/');
    if (parts.length < 3) {
        log('debug', `路径格式错误: ${url.pathname}`);
        return new Response('Not Found', { status: 404 });
    }

    const uuid = parts[parts.length - 2];
    const seq = parts[parts.length - 1];
    log('debug', `UUID: ${uuid}, SEQ: ${seq}`);

    // 通用响应头
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'X-Padding': 'X'.repeat(100 + Math.floor(Math.random() * 900))
    };

    // POST 请求处理(上行数据)
    if (req.method === 'POST') {
        log('debug', `处理 POST 请求: SEQ=${seq}`);
        const seqNum = parseInt(seq);
        if (isNaN(seqNum)) {
            log('warn', `无效的 SEQ 数值: ${seq}`);
            return new Response('Bad Request', { status: 400 });
        }

        let conn = connections.get(uuid);
        if (!conn) {
            log('info', `创建新连接: UUID=${uuid}`);
            conn = {
                buffer: new Map(),
                stream: null,
                vlessHeader: null,
                remoteConnection: null,
                lastActive: Date.now()
            };
            connections.set(uuid, conn);
        }

        try {
            // 先获取完整的请求数据
            const rawData = await req.arrayBuffer();
            const data = new Uint8Array(rawData);
            log('debug', `收到数据包: SEQ=${seqNum}, 大小=${data.length}字节`);
            
            // 如果是第一个包，需要解析 VLESS 头
            if (seqNum === 0 && !conn.vlessHeader) {
                log('info', `解析首个数据包的 VLESS 头`);
                
                // 创建一个新的 ReadableStream 来处理数据
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(data);
                        controller.close();
                    }
                });
                
                const reader = stream.getReader();
                try {
                    conn.vlessHeader = await read_vless_header(reader, SETTINGS.UUID);
                    log('info', `成功解析 VLESS 头: ${conn.vlessHeader.hostname}:${conn.vlessHeader.port}`);
                    
                    log('debug', `尝试建立远程连接...`);
                    const resp = await fetch(`http://${conn.vlessHeader.hostname}:${conn.vlessHeader.port}`, {
                        method: 'CONNECT',
                        body: conn.vlessHeader.data
                    });
                    
                    if (!resp.ok) {
                        throw new Error(`远程连接失败: ${resp.status}`);
                    }
                    conn.remoteConnection = resp.body;
                    log('info', `远程连接建立成功`);
                } finally {
                    reader.releaseLock();
                }
            }

            conn.buffer.set(seqNum, data);
            conn.lastActive = Date.now();
            log('debug', `数据包已缓存: SEQ=${seqNum}`);

            return new Response(null, { headers });
        } catch (e) {
            log('error', `处理请求出错:`, e);
            connections.delete(uuid);
            return new Response('Internal Server Error', { status: 500 });
        }
    }

    // GET 请求处理(下行数据)
    if (req.method === 'GET') {
        log('debug', `处理 GET 请求: UUID=${uuid}`);
        const conn = connections.get(uuid);
        if (!conn) {
            log('warn', `未找到连接: UUID=${uuid}`);
            return new Response('Not Found', { status: 404 });
        }

        const responseHeaders = {
            ...headers,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'
        };

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        log('debug', `开始处理下行数据流`);
        // 先发送 VLESS 响应
        if (conn.vlessHeader) {
            log('debug', `发送 VLESS 响应头`);
            await writer.write(conn.vlessHeader.resp);
        }

        // 处理缓存的数据
        const bufferedData = Array.from(conn.buffer.entries())
            .sort(([a], [b]) => a - b)
            .map(([_, data]) => data);
        
        log('debug', `发送缓存数据包: ${bufferedData.length}个`);
        for (const data of bufferedData) {
            await writer.write(data);
        }
        conn.buffer.clear();
        log('debug', `缓存已清空`);

        // 连接远程流
        if (conn.remoteConnection) {
            log('debug', `建立远程数据流管道`);
            conn.stream = writable;
            conn.remoteConnection.pipeTo(writable).catch((e: any) => {
                log('error', 'Remote connection error:', e);
                connections.delete(uuid);
            });
        }

        log('info', `数据流已建立`);
        return new Response(readable, { headers: responseHeaders });
    }

    log('warn', `不支持的请求方法: ${req.method}`);
    return new Response('Method Not Allowed', { status: 405 });
}
