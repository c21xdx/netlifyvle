// 使用 Node.js 内置模块
import http from "http";
import { Readable, Writable } from "stream";

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

// 启动服务器
async function startServer() {
    try {
        const port = parseInt(process.env.PORT || "3000");
        log('info', `Server running on port ${port}`);

        // 使用 Node.js 的 http 模块创建服务器
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url || "", `http://${req.headers.host}`);
                log('info', `Received ${req.method} request to ${url.pathname}`);
                if (req.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
                    const response = await handleVlessRequest(req);
                    res.writeHead(response.status, response.headers);
                    response.body?.pipe(res); // 将响应流传递给客户端
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end("Not Found");
                }
            } catch (err) {
                log('error', 'Failed to handle request:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end("Internal Server Error");
            }
        });

        server.listen(port, () => {
            log('info', `Server listening on port ${port}`);
        });
    } catch (err) {
        log('error', 'Failed to start server:', err);
    }
}

// 处理 VLESS 请求
async function handleVlessRequest(request: http.IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body?: Readable }> {
    try {
        const reader = request.pipe(new PassThrough()); // 将请求体转换为可读流
        const vless = await read_vless_header(reader, SETTINGS.UUID);
        const remote = await connect_remote(vless.hostname, vless.port);
        const remoteStream = tcpToWebStream(remote);

        const { readable, writable } = new TransformStream();
        relay(reader, remoteStream, vless.data, readable, writable, vless.resp);

        return {
            status: 200,
            headers: {
                'Content-Type': 'application/grpc',
                'X-Request-Id': Math.random().toString(36).substring(2),
                'X-Response-Id': '1',
                'X-Stream-Mode': 'one'
            },
            body: Readable.from(readable)
        };
    } catch (err) {
        log('error', 'Failed to handle VLESS request:', err);
        return {
            status: 400,
            headers: { 'Content-Type': 'text/plain' },
            body: Readable.from(["Invalid Request"])
        };
    }
}

// 网络相关函数
async function connect_remote(hostname: string, port: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = require('net').connect({ host: hostname, port }, () => {
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

// 启动服务器
startServer();
