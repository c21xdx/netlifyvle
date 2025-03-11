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

// 添加工具函数
function concat_typed_arrays(first: Uint8Array, ...args: Uint8Array[]): Uint8Array {
    if (!args || args.length < 1) return first;
    let len = first.length;
    for (const a of args) len += a.length;
    const result = new Uint8Array(len);
    result.set(first, 0);
    len = first.length;
    for (const a of args) {
        result.set(a, len);
        len += a.length;
    }
    return result;
}

function parse_uuid(uuid: string): Uint8Array {
    const clean = uuid.replaceAll('-', '');
    const result = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        result[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return result;
}

// VLESS 协议解析
async function read_atleast(reader: ReadableStreamDefaultReader<Uint8Array>, n: number) {
    const buffs: Uint8Array[] = [];
    let done = false;
    while (n > 0 && !done) {
        const r = await reader.read();
        if (r.value) {
            const b = new Uint8Array(r.value);
            buffs.push(b);
            n -= b.length;
        }
        done = r.done || false;
    }
    if (n > 0) {
        throw new Error(`not enough data to read`);
    }
    return {
        value: concat_typed_arrays(...buffs),
        done,
    };
}

async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid_str: string) {
    // VLESS 协议常量
    const COMMAND_TYPE_TCP = 1;
    const ADDRESS_TYPE_IPV4 = 1;
    const ADDRESS_TYPE_STRING = 2;
    const ADDRESS_TYPE_IPV6 = 3;

    log('debug', 'Starting to read VLESS header');
    let readed_len = 0;
    let header = new Uint8Array();

    let read_result = { value: header, done: false };
    async function inner_read_until(offset: number) {
        if (read_result.done) {
            throw new Error('header length too short');
        }
        const len = offset - readed_len;
        if (len < 1) return;
        read_result = await read_atleast(reader, len);
        readed_len += read_result.value.length;
        header = concat_typed_arrays(header, read_result.value);
    }

    await inner_read_until(1 + 16 + 1);

    const version = header[0];
    const uuid = header.slice(1, 1 + 16);
    const cfg_uuid = parse_uuid(cfg_uuid_str);
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`);
    }

    const pb_len = header[1 + 16];
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1;
    await inner_read_until(addr_plus1 + 1);

    const cmd = header[1 + 16 + 1 + pb_len];
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`);
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1];
    const atype = header[addr_plus1 - 1];

    let header_len = -1;
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4;
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16;
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1];
    }
    if (header_len < 0) {
        throw new Error('read address type failed');
    }
    await inner_read_until(header_len);

    const idx = addr_plus1;
    let hostname = '';
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.');
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        );
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':');
    }

    log('info', `VLESS connection to ${hostname}:${port}`);

    if (!hostname) {
        log('error', 'Failed to parse hostname');
        throw new Error('parse hostname failed');
    }

    return {
        version,
        hostname,
        port,
        data: header.slice(header_len),
        resp: new Uint8Array([version, 0]),
    };
}

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
    if (!url.pathname.startsWith(SETTINGS.XHTTP_PATH)) {
        log('debug', `路径不匹配 XHTTP_PATH: ${url.pathname}`);
        return new Response('Not Found', { status: 404 });
    }
    
    // 修改路径解析逻辑，正确提取 UUID 和 seq
    const pathParts = url.pathname.substring(SETTINGS.XHTTP_PATH.length).split('/').filter(p => p);
    if (pathParts.length < 2) {
        log('debug', `路径格式错误: ${url.pathname}`);
        return new Response('Not Found', { status: 404 });
    }

    const uuid = pathParts[0];  // 第一个部分是 UUID
    const seq = pathParts[1];   // 第二个部分是 seq
    log('debug', `解析路径: UUID=${uuid}, SEQ=${seq}`);

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
            if (seqNum === 0 && (!conn.vlessHeader || !conn.remoteConnection)) {
                log('info', `解析首个数据包的 VLESS 头`);
                
                try {
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
                        
                        // ...existing remote connection code...
                    } finally {
                        reader.releaseLock();
                    }
                } catch (e) {
                    log('error', `VLESS 头解析或连接失败:`, e);
                    connections.delete(uuid);
                    return new Response('Bad Request', { status: 400 });
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
