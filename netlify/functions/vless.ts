// 导入 Node.js 内置模块
import { Readable, Writable } from "stream";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vless UUID
    ['LOG_LEVEL']: 'debug',  // 改为 info 级别
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

// 其他工具函数保持不变...

// VLESS 协议解析
async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid_str: string) {
    // 解析逻辑保持不变...
}

// 网络相关函数
async function connect_remote(hostname: string, port: number) {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const socket = net.connect({ host: hostname, port }, () => {
            resolve(socket);
        });
        socket.on('error', reject);
    });
}

function tcpToWebStream(conn: any) {
    return {
        readable: new Readable({
            read() {
                conn.on('data', (chunk: Buffer) => this.push(chunk));
                conn.on('end', () => this.push(null));
                conn.on('error', (err: Error) => this.destroy(err));
            }
        }),
        writable: new Writable({
            write(chunk: Buffer, _encoding, callback) {
                conn.write(chunk, callback);
            },
            final(callback) {
                conn.end(callback);
            }
        })
    };
}

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);
    if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        return await handleVlessRequest(request);
    }
    return new Response("Not Found", { status: 404 });
}

async function handleVlessRequest(request: Request): Promise<Response> {
    try {
        const reader = request.body?.getReader();
        if (!reader) {
            throw new Error("No request body");
        }
        const vless = await read_vless_header(reader, SETTINGS.UUID);
        const remote = await connect_remote(vless.hostname, vless.port);
        const remoteStream = tcpToWebStream(remote);

        const { readable, writable } = new TransformStream();
        relay(reader, remoteStream, vless.data, readable, writable, vless.resp);

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
                    // 忽略连接关闭和中止的错误
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
                    // 忽略连接关闭和中止的错误
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
        // 只记录重要错误
        if (!err.message.includes('connection') &&
            !err.message.includes('abort') &&
            !err.message.includes('closed') &&
            !err.message.includes('stream error')) {
            log('error', 'Relay error:', err);
        }
    }
}

// Netlify 的 handler 函数
export async function handler(event: any, context: any): Promise<Response> {
    try {
        // 构造 Request 对象
        const request = new Request(event.rawUrl, {
            method: event.httpMethod,
            headers: new Headers(event.headers),
            body: event.body ? Buffer.from(event.body, 'base64') : null,
        });

        // 调用现有的请求处理逻辑
        const response = await handleRequest(request);

        // 构造 Netlify 的响应格式
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });

        return {
            statusCode: response.status,
            headers,
            body: response.body ? Buffer.from(await response.arrayBuffer()).toString('base64') : '',
            isBase64Encoded: true,
        };
    } catch (err) {
        log('error', 'Handler error:', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'text/plain' },
            body: 'Internal Server Error',
        };
    }
}
