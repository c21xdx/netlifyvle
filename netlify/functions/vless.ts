import { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    UUID: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    BUFFER_SIZE: 16384,
    XHTTP_PATH: '/xblog',
    LOG_LEVEL: 'debug',  // 设置日志级别为 debug
    // 添加 packet-up 模式的配置
    SC_MAX_EACH_POST_BYTES: 1000000,  // 1MB
    SC_MAX_BUFFERED_POSTS: 30,
    MIN_PADDING_LEN: 100,
    MAX_PADDING_LEN: 1000
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

// 在 connections 定义前添加远程连接和转发相关函数
async function connect_remote(hostname: string, port: number) {
    try {
        const targetUrl = `https://${hostname}:${port}`;
        log('debug', `尝试连接到目标服务器: ${targetUrl}`);
        
        const response = await fetch(targetUrl, {
            method: 'CONNECT',  // 使用 CONNECT 方法
            headers: {
                'Host': hostname,
                'Connection': 'keep-alive',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            redirect: 'follow',
            duplex: 'half'
        });

        if (!response.ok && response.status !== 200) {
            throw new Error(`远程连接失败: ${response.status}`);
        }

        const stream = response.body;
        if (!stream) {
            throw new Error('未获取到响应流');
        }

        log('debug', `成功建立连接，响应状态: ${response.status}`);
        return {
            stream,
            response
        };
    } catch (err) {
        log('error', `连接远程服务器失败: ${err.message}`);
        throw err;
    }
}

async function relay(
    remoteResponse: { stream: ReadableStream, response: Response },
    responseWriter: WritableStreamDefaultWriter<any>,
    firstPacket?: Uint8Array
) {
    try {
        const remoteStream = remoteResponse.stream;
        const remoteReader = remoteStream.getReader();
        
        // 先写入首包数据（如果有）
        if (firstPacket) {
            await responseWriter.write(firstPacket);
        }

        // 持续转发数据
        while (true) {
            const { value, done } = await remoteReader.read();
            if (done) {
                log('debug', '远程连接已结束');
                break;
            }
            if (value) {
                log('debug', `转发远程数据: ${value.length} 字节`);
                await responseWriter.write(value);
            }
        }
    } catch (err) {
        log('error', '数据转发错误:', err);
        throw err;
    } finally {
        try {
            await responseWriter.close();
        } catch (e) {
            // 忽略关闭错误
        }
    }
}

// 修改连接管理接口
const connections = new Map<string, {
    buffer: Map<number, Uint8Array>,
    stream: WritableStream | null,
    vlessHeader: any | null,
    remoteConnection: any | null,
    lastActive: number,
    isEstablished: boolean,  // 新增：标记连接是否完全建立
    expectedSeq: number      // 新增：期望的下一个序列号
}>();

// 更新清理超时连接的逻辑
setInterval(() => {
    const now = Date.now();
    for (const [uuid, conn] of connections) {
        if (now - conn.lastActive > 30000 || 
            (now - conn.lastActive > 10000 && !conn.isEstablished)) {
            log('info', `清理超时连接: UUID=${uuid}, isEstablished=${conn.isEstablished}`);
            if (conn.remoteConnection) {
                try {
                    conn.remoteConnection.cancel();
                } catch (e) {
                    log('warn', `关闭远程连接失败:`, e);
                }
            }
            if (conn.stream) {
                try {
                    const writer = conn.stream.getWriter();
                    writer.close().catch(() => {});
                } catch (e) {
                    log('warn', `关闭流失败:`, e);
                }
            }
            connections.delete(uuid);
        }
    }
}, 5000);

// 修改连接初始化逻辑
function initConnection(uuid: string) {
    const conn = {
        buffer: new Map(),
        stream: null,
        vlessHeader: null,
        remoteConnection: null,
        lastActive: Date.now(),
        isEstablished: false,
        expectedSeq: 0
    };
    connections.set(uuid, conn);
    return conn;
}

export default async function handler(req: Request, context: Context) {
    // 验证 padding
    const referer = req.headers.get('Referer');
    if (!referer?.includes('x_padding=')) {
        log('warn', '请求缺少必要的 padding');
        return new Response('Bad Request', { status: 400 });
    }

    const padMatch = referer.match(/x_padding=([X]+)/);
    if (!padMatch || 
        padMatch[1].length < SETTINGS.MIN_PADDING_LEN || 
        padMatch[1].length > SETTINGS.MAX_PADDING_LEN) {
        log('warn', 'padding 长度不符合要求');
        return new Response('Bad Request', { status: 400 });
    }

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
        'X-Padding': 'X'.repeat(
            SETTINGS.MIN_PADDING_LEN + 
            Math.floor(Math.random() * (SETTINGS.MAX_PADDING_LEN - SETTINGS.MIN_PADDING_LEN))
        )
    };

    // POST 请求处理(上行数据)
    if (req.method === 'POST') {
        log('debug', `处理 POST 请求: SEQ=${seq}`);
        const seqNum = parseInt(seq);
        if (isNaN(seqNum)) {
            log('warn', `无效的 SEQ 数值: ${seq}`);
            return new Response('Bad Request', { status: 400 });
        }

        // 检查 POST 大小限制
        const contentLength = parseInt(req.headers.get('content-length') || '0');
        if (contentLength > SETTINGS.SC_MAX_EACH_POST_BYTES) {
            log('warn', `POST 数据超过大小限制: ${contentLength}`);
            return new Response('Payload Too Large', { status: 413 });
        }

        let conn = connections.get(uuid);
        if (!conn) {
            conn = initConnection(uuid);
        }
        
        // 验证序列号
        if (seqNum !== conn.expectedSeq) {
            log('warn', `序列号不匹配: 期望=${conn.expectedSeq}, 实际=${seqNum}`);
            if (seqNum < conn.expectedSeq) {
                // 忽略重复的包
                return new Response(null, { headers });
            }
            // 序列号跳跃，终止连接
            connections.delete(uuid);
            return new Response('Bad Request', { status: 400 });
        }

        // 检查缓存数量限制
        if (conn.buffer.size >= SETTINGS.SC_MAX_BUFFERED_POSTS) {
            log('warn', `缓存的 POST 请求数量超过限制: ${conn.buffer.size}`);
            connections.delete(uuid);
            return new Response('Too Many Requests', { status: 429 });
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
                        
                        log('debug', `尝试建立远程连接到 ${conn.vlessHeader.hostname}:${conn.vlessHeader.port}`);
                        const remoteStream = await connect_remote(conn.vlessHeader.hostname, conn.vlessHeader.port);
                        if (!remoteStream) {
                            throw new Error('Failed to establish remote connection');
                        }
                        
                        conn.remoteConnection = remoteStream;
                        log('info', `远程连接建立成功`);
                        
                        // 发送初始数据
                        const { writable, readable } = new TransformStream();
                        const writer = writable.getWriter();
                        await writer.write(conn.vlessHeader.data);
                        writer.releaseLock();
                        
                        conn.stream = writable;
                    } finally {
                        reader.releaseLock();
                    }
                } catch (e) {
                    log('error', `VLESS 头解析或连接失败:`, e);
                    connections.delete(uuid);
                    return new Response('Bad Request', { status: 400 });
                }
                conn.isEstablished = true;
            }

            conn.expectedSeq++;
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
        if (!conn || !conn.isEstablished) {
            log('warn', `无效的下行请求: UUID=${uuid}, isEstablished=${conn?.isEstablished}`);
            return new Response('Not Found', { status: 404 });
        }

        const responseHeaders = {
            ...headers,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        };

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        try {
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
            
            // 开始数据转发
            if (conn.remoteConnection) {
                log('debug', `开始数据转发`);
                conn.stream = writable;
                
                // 建立响应流
                const responseStream = await relay(conn.remoteConnection, writer);
                
                return new Response(responseStream, {
                    headers: responseHeaders
                });
            }

            return new Response(readable, {
                headers: responseHeaders
            });
        } catch (e) {
            log('error', `处理下行数据错误:`, e);
            connections.delete(uuid);
            return new Response('Internal Server Error', { status: 500 });
        }
    }

    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers });
    }

    log('warn', `不支持的请求方法: ${req.method}`);
    return new Response('Method Not Allowed', { status: 405 });
}
