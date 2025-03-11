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

// UUID 相关函数保持不变
function validate_uuid(left: Uint8Array, right: Uint8Array): boolean {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

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

// VLESS 协议解析函数保持不变
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

// VLESS header 解析保持不变
async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid_str: string) {
    // ... (保持原有的 read_vless_header 实现不变)
}

// 修改网络连接函数以使用 fetch
async function connect_remote(hostname: string, port: number) {
    try {
        // 使用 fetch 创建到目标服务器的连接
        const response = await fetch(`http://${hostname}:${port}`);
        if (!response.body) {
            throw new Error('No response body');
        }
        
        // 创建双向流
        const { readable, writable } = new TransformStream();
        
        return {
            readable: response.body,
            writable
        };
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// Netlify Edge Function 处理函数
export default async function handler(request: Request, context: Context) {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);

    if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        return await handleVlessRequest(request);
    }

    return new Response("Not Found", { status: 404 });
}

// VLESS 请求处理函数
async function handleVlessRequest(request: Request): Promise<Response> {
    try {
        const reader = request.body?.getReader();
        if (!reader) {
            throw new Error("No request body");
        }

        const vless = await read_vless_header(reader, SETTINGS.UUID);
        const remote = await connect_remote(vless.hostname, vless.port);
        const { readable, writable } = new TransformStream();

        // 设置数据转发
        relay(reader, remote, vless.data, readable, writable, vless.resp);

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'application/grpc',
                'X-Request-Id': Math.random().toString(36).substring(2),
                'X-Response-Id': '1',
                'X-Stream-Mode': 'one'
            }
        });
    } catch (err) {
        log('error', 'Failed to handle VLESS request:', err);
        return new Response("Invalid Request", { status: 400 });
    }
}

// 数据转发函数
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
                    } catch {
                        // 忽略关闭时的错误
                    }
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
                    } catch {
                        // 忽略关闭时的错误
                    }
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
