// 导入 Node.js 内置模块
import { Readable } from "stream";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vless UUID
    ['LOG_LEVEL']: 'info',  // 改为 info 级别
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

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);
    if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        return await handleVlessRequest(request);
    }
    return new Response("Not Found", { status: 404 });
}

// 处理 VLESS 请求
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
