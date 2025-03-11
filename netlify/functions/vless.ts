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

// ... 前面的导入和配置保持不变 ...

// 修改处理函数以支持新的URL格式
export default async function handler(request: Request, context: Context) {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);

    // 检查URL格式是否符合预期
    if (!url.pathname.startsWith(SETTINGS.XHTTP_PATH)) {
        return new Response("Not Found", { status: 404 });
    }

    // 根据请求方法分别处理
    if (request.method === 'POST') {
        return await handleVlessRequest(request);
    } else if (request.method === 'GET') {
        // 处理GET请求，返回一个简单的响应
        return new Response("OK", {
            status: 200,
            headers: {
                'Content-Type': 'text/plain'
            }
        });
    }

    return new Response("Method Not Allowed", { status: 405 });
}

// 修改VLESS请求处理函数，添加更多错误检查
async function handleVlessRequest(request: Request): Promise<Response> {
    try {
        const reader = request.body?.getReader();
        if (!reader) {
            throw new Error("No request body");
        }

        // 添加详细的日志
        log('debug', 'Starting VLESS header parsing');
        
        const vless = await read_vless_header(reader, SETTINGS.UUID);
        
        // 添加结果验证
        if (!vless || !vless.hostname || !vless.port) {
            throw new Error("Invalid VLESS header: missing required fields");
        }

        log('debug', `Parsed VLESS header - Host: ${vless.hostname}, Port: ${vless.port}`);

        // 建立远程连接
        log('debug', `Attempting to connect to remote: ${vless.hostname}:${vless.port}`);
        const remote = await connect_remote(vless.hostname, vless.port);

        if (!remote || !remote.readable || !remote.writable) {
            throw new Error("Failed to establish remote connection");
        }

        const { readable, writable } = new TransformStream();

        // 设置数据转发
        relay(reader, remote, vless.data, readable, writable, vless.resp).catch(err => {
            log('error', 'Relay error:', err);
        });

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
        
        // 返回更详细的错误信息
        return new Response(JSON.stringify({
            error: err.message,
            timestamp: new Date().toISOString()
        }), {
            status: 400,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }
}

// 修改远程连接函数，添加更多错误处理
async function connect_remote(hostname: string, port: number) {
    try {
        log('debug', `Connecting to ${hostname}:${port}`);
        
        // 创建双向流
        const { readable, writable } = new TransformStream();
        
        // 使用fetch建立连接
        const response = await fetch(`http://${hostname}:${port}`, {
            method: 'CONNECT',
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to connect to remote: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
            throw new Error('No response body from remote');
        }

        return {
            readable: response.body,
            writable
        };
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// 修改read_vless_header函数，添加更多验证
async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid_str: string) {
    try {
        log('debug', 'Starting to read VLESS header');
        
        // ... (原有的 VLESS 头部解析代码) ...

        // 添加额外的验证
        if (!hostname) {
            throw new Error('Failed to parse hostname from VLESS header');
        }

        if (port <= 0 || port > 65535) {
            throw new Error(`Invalid port number: ${port}`);
        }

        log('debug', `Successfully parsed VLESS header - Host: ${hostname}, Port: ${port}`);

        return {
            version,
            hostname,
            port,
            data: header.slice(header_len),
            resp: new Uint8Array([version, 0])
        };
    } catch (err) {
        log('error', 'Failed to parse VLESS header:', err);
        throw err;
    }
}
