// 导入 Netlify Edge Functions 模块
import { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vless UUID
    ['LOG_LEVEL']: 'info',  // 日志级别
    ['BUFFER_SIZE']: '128', // 缓冲区大小 KiB
    ['XHTTP_PATH']: '/xblog', // XHTTP 路径
} as const;

// 定义日志级别
const LOG_LEVELS = {
    'debug': 0,
    'info': 1,
    'warn': 2,
    'error': 3
} as const;

// 工具函数
function log(type: string, ...args: unknown[]) {
    const currentLevel = LOG_LEVELS[type as keyof typeof LOG_LEVELS] || 0;
    const configLevel = LOG_LEVELS[SETTINGS.LOG_LEVEL as keyof typeof LOG_LEVELS] || 1;
    if (currentLevel >= configLevel) {
        const time = new Date().toISOString();
        console.log(`[${time}] [${type}]`, ...args);
    }
}

// 验证 UUID 是否匹配
function validate_uuid(left: Uint8Array, right: Uint8Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

// 将多个 Uint8Array 拼接成一个数组
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

// 将字符串形式的 UUID 转换为 Uint8Array
function parse_uuid(uuid: string): Uint8Array {
    const clean = uuid.replaceAll('-', '');
    const result = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        result[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return result;
}

// VLESS 协议解析
async function read_atleast(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<{ value: Uint8Array; done: boolean }> {
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

    // 解析协议头
    await inner_read_until(1 + 16 + 1); // 版本号 + UUID + 额外数据长度
    const version = header[0];
    const uuid = header.slice(1, 1 + 16);
    const cfg_uuid = parse_uuid(cfg_uuid_str);
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`);
    }

    const pb_len = header[1 + 16]; // 额外数据长度
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1; // 计算地址偏移量
    await inner_read_until(addr_plus1 + 1);

    const cmd = header[1 + 16 + 1 + pb_len];
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`);
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1];
    const atype = header[addr_plus1 - 1];

    let header_len = -1;
    let hostname = '';
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4;
        hostname = header.slice(addr_plus1, addr_plus1 + 4).join('.');
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1];
        hostname = new TextDecoder().decode(
            header.slice(addr_plus1 + 1, addr_plus1 + 1 + header[addr_plus1]),
        );
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16;
        hostname = header
            .slice(addr_plus1, addr_plus1 + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':');
    }

    if (header_len < 0) {
        throw new Error('read address type failed');
    }

    await inner_read_until(header_len);

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

// 连接到远程服务器
async function connect_remote(hostname: string, port: number): Promise<ReadableStream> {
    const url = `http://${hostname}:${port}`;
    const response = await fetch(url, {
        method: 'CONNECT',
        headers: {
            'Content-Type': 'application/octet-stream',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to connect to ${hostname}:${port}`);
    }

    return response.body;
}

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    try {
        const url = new URL(request.url);
        log('info', `Received ${request.method} request to ${url.pathname}`);

        if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
            return await handleVlessRequest(request);
        }

        return new Response("Not Found", { status: 404 });
    } catch (err) {
        log('error', 'Handler error:', err);
        return new Response("Internal Server Error", { status: 500 });
    }
}

async function handleVlessRequest(request: Request): Promise<Response> {
    try {
        const reader = request.body?.getReader();
        if (!reader) {
            throw new Error("No request body");
        }

        const vless = await read_vless_header(reader, SETTINGS.UUID);
        if (!vless || !vless.hostname || !vless.port) {
            throw new Error("Invalid VLESS header");
        }

        const remoteStream = await connect_remote(vless.hostname, vless.port);
        const { readable, writable } = tcpToWebStream(remoteStream);

        relay(reader, { readable, writable }, vless.data, readable, writable, vless.resp);

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'application/grpc',
                'X-Request-Id': Math.random().toString(36).substring(2),
                'X-Response-Id': '1',
                'X-Stream-Mode': 'one',
            },
        });
    } catch (err) {
        log('error', 'Failed to handle VLESS request:', err);
        return new Response("Invalid Request", { status: 400 });
    }
}

// 双向数据转发
async function relay(
    clientReader: ReadableStreamDefaultReader<Uint8Array>,
    remoteStream: { readable: ReadableStream; writable: WritableStream },
    firstPacket: Uint8Array,
    responseReadable: ReadableStream,
    responseWritable: WritableStream,
    vlessResponse: Uint8Array
) {
    try {
        // 发送第一个数据包到远程
        const remoteWriter = remoteStream.writable.getWriter();
        await remoteWriter.write(firstPacket);
        remoteWriter.releaseLock();

        // 发送 VLESS 响应
        const responseWriter = responseWritable.getWriter();
        await responseWriter.write(vlessResponse);
        responseWriter.releaseLock();

        // 创建双向转发
        await Promise.all([
            // 客户端到远程的转发
            (async () => {
                const writer = remoteStream.writable.getWriter();
                try {
                    while (true) {
                        const { value, done } = await clientReader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                } catch (err) {
                    if (!err.message.includes('connection') && !err.message.includes('abort')) {
                        throw err;
                    }
                } finally {
                    try {
                        await writer.close();
                    } catch {}
                    writer.releaseLock();
                }
            })(),
            // 远程到客户端的转发
            (async () => {
                const reader = remoteStream.readable.getReader();
                const writer = responseWritable.getWriter();
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        await writer.write(value);
                    }
                } catch (err) {
                    if (!err.message.includes('connection') && !err.message.includes('abort')) {
                        throw err;
                    }
                } finally {
                    try {
                        await writer.close();
                    } catch {}
                    reader.releaseLock();
                    writer.releaseLock();
                }
            })()
        ]);
    } catch (err) {
        if (!err.message.includes('connection') &&
            !err.message.includes('abort') &&
            !err.message.includes('closed') &&
            !err.message.includes('stream error')) {
            log('error', 'Relay error:', err);
        }
    }
}

// Netlify 的 handler 函数
export async function handler(request: Request, context: Context): Promise<Response> {
    return await handleRequest(request);
}
