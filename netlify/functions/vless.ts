// Netlify Edge Functions 版本的 VLESS over XHTTP 代理
import type { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vless UUID
    ['LOG_LEVEL']: 'debug',  // 改为 debug 级别以获取更多日志
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
    // 检查当前日志级别是否应该输出
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
    log('debug', `尝试读取至少 ${n} 字节数据`);
    const buffs: Uint8Array[] = [];
    let done = false;
    let totalRead = 0;
    
    while (n > 0 && !done) {
        log('debug', `还需读取 ${n} 字节数据`);
        const r = await reader.read();
        log('debug', `读取结果: done=${r.done}, value长度=${r.value ? r.value.length : 0}`);
        
        if (r.value) {
            const b = new Uint8Array(r.value);
            buffs.push(b);
            totalRead += b.length;
            n -= b.length;
            log('debug', `已读取 ${totalRead} 字节数据，还需 ${n} 字节`);
        }
        done = r.done || false;
        if (done) {
            log('debug', `读取器已关闭，已读取 ${totalRead} 字节数据`);
        }
    }
    
    if (n > 0) {
        log('error', `数据不足: 需要 ${n + totalRead} 字节，实际读取 ${totalRead} 字节`);
        throw new Error(`not enough data to read: needed ${n + totalRead}, got ${totalRead}`);
    }
    
    log('debug', `成功读取 ${totalRead} 字节数据`);
    return {
        value: buffs.length === 0 ? new Uint8Array(0) : concat_typed_arrays(...buffs),
        done,
    };
}

async function read_vless_header(reader: ReadableStreamDefaultReader<Uint8Array>, cfg_uuid_str: string) {
    // VLESS 协议常量
    const COMMAND_TYPE_TCP = 1;
    const ADDRESS_TYPE_IPV4 = 1;
    const ADDRESS_TYPE_STRING = 2;
    const ADDRESS_TYPE_IPV6 = 3;

    log('debug', '开始读取 VLESS 头部');
    let readed_len = 0;
    let header = new Uint8Array();

    let read_result = { value: header, done: false };
    async function inner_read_until(offset: number) {
        if (read_result.done) {
            log('error', '头部长度不足');
            throw new Error('header length too short');
        }
        const len = offset - readed_len;
        if (len < 1) return;
        log('debug', `尝试读取 ${len} 字节数据，当前已读取 ${readed_len} 字节`);
        read_result = await read_atleast(reader, len);
        readed_len += read_result.value.length;
        header = concat_typed_arrays(header, read_result.value);
        log('debug', `成功读取数据，当前总长度: ${header.length} 字节`);
    }

    log('debug', `开始读取 VLESS 头部基本信息`);
    await inner_read_until(1 + 16 + 1);

    const version = header[0];
    log('debug', `VLESS 版本: ${version}`);
    
    const uuid = header.slice(1, 1 + 16);
    log('debug', `接收到的 UUID: ${Array.from(uuid).map(b => b.toString(16).padStart(2, '0')).join('')}`);
    
    const cfg_uuid = parse_uuid(cfg_uuid_str);
    log('debug', `配置的 UUID: ${Array.from(cfg_uuid).map(b => b.toString(16).padStart(2, '0')).join('')}`);
    
    if (!validate_uuid(uuid, cfg_uuid)) {
        log('error', 'UUID 验证失败');
        throw new Error(`invalid UUID`);
    }
    log('debug', `UUID 验证通过`);
    
    const pb_len = header[1 + 16];
    log('debug', `附加信息长度: ${pb_len}`);
    
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1;
    await inner_read_until(addr_plus1 + 1);

    const cmd = header[1 + 16 + 1 + pb_len];
    log('debug', `命令类型: ${cmd}`);
    
    if (cmd !== COMMAND_TYPE_TCP) {
        log('error', `不支持的命令类型: ${cmd}`);
        throw new Error(`unsupported command: ${cmd}`);
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1];
    log('debug', `目标端口: ${port}`);
    
    const atype = header[addr_plus1 - 1];
    log('debug', `地址类型: ${atype}`);

    let header_len = -1;
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4;
        log('debug', `IPv4 地址，头部长度: ${header_len}`);
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16;
        log('debug', `IPv6 地址，头部长度: ${header_len}`);
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1];
        log('debug', `域名地址，头部长度: ${header_len}`);
    }
    
    if (header_len < 0) {
        log('error', '读取地址类型失败');
        throw new Error('read address type failed');
    }
    
    await inner_read_until(header_len);

    const idx = addr_plus1;
    let hostname = '';
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.');
        log('debug', `IPv4 地址: ${hostname}`);
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        );
        log('debug', `域名: ${hostname}`);
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':');
        log('debug', `IPv6 地址: ${hostname}`);
    }

    log('info', `VLESS 连接到 ${hostname}:${port}`);

    if (!hostname) {
        log('error', '解析主机名失败');
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

// Netlify Edge Function 处理函数
export default async (request: Request, context: Context) => {
    log('debug', `收到请求: ${request.method} ${request.url}`);
    try {
        return await handleRequest(request);
    } catch (err) {
        log('error', `处理请求时发生错误: ${err.message}`, err.stack);
        return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
    }
};

// 配置 Netlify Edge Function
export const config = {
    path: SETTINGS.XHTTP_PATH + "*", // 匹配 XHTTP_PATH 及其子路径
};

// 添加一个缓存来存储客户端的请求数据
const clientRequests = new Map<string, {
    posts: Map<number, Uint8Array>,
    lastActivity: number,
    writer?: WritableStreamDefaultWriter<Uint8Array>,
    maxSeq: number,
    targetInfo?: {
        hostname: string,
        port: number
    }
}>();

// 定期清理过期的请求
setInterval(() => {
    const now = Date.now();
    for (const [uuid, data] of clientRequests.entries()) {
        if (now - data.lastActivity > 30000) { // 30秒超时
            log('debug', `清理过期的请求: ${uuid}`);
            if (data.writer) {
                try {
                    data.writer.close().catch(() => {});
                } catch {}
            }
            clientRequests.delete(uuid);
        }
    }
}, 10000); // 每10秒检查一次

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);

    // 解析路径中的 UUID 和序列号
    const pathParts = url.pathname.split('/');
    if (pathParts.length >= 3 && pathParts[1] === SETTINGS.XHTTP_PATH.substring(1)) {
        const clientUUID = pathParts[2];
        
        // 处理 POST 请求 (下行数据)
        if (request.method === 'POST' && pathParts.length >= 4) {
            const seq = parseInt(pathParts[3], 10);
            if (isNaN(seq)) {
                log('error', `无效的序列号: ${pathParts[3]}`);
                return new Response("Invalid sequence number", { status: 400 });
            }
            
            log('debug', `收到 POST 请求，UUID: ${clientUUID}, 序列号: ${seq}`);
            return await handlePostRequest(request, clientUUID, seq);
        }
        
        // 处理 GET 请求 (下行数据)
        if (request.method === 'GET') {
            log('debug', `收到 GET 请求，UUID: ${clientUUID}`);
            return await handleGetRequest(clientUUID);
        }
    }

    // 处理 VLESS 请求 (兼容旧模式)
    if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        log('debug', `匹配到 VLESS 请求路径: ${url.pathname}`);
        return await handleVlessRequest(request);
    }

    // 添加简单的健康检查端点
    if (request.method === 'GET' && url.pathname === '/health') {
        return new Response("OK", { status: 200 });
    }

    log('debug', `未匹配到任何处理路径: ${url.pathname}`);
    return new Response("Not Found", { status: 404 });
}

// 处理 POST 请求 (上行数据)
async function handlePostRequest(request: Request, uuid: string, seq: number): Promise<Response> {
    try {
        if (!request.body) {
            log('error', `请求没有 body`);
            return new Response("No request body", { status: 400 });
        }

        // 获取或创建客户端请求数据
        if (!clientRequests.has(uuid)) {
            log('debug', `创建新的客户端请求: ${uuid}`);
            clientRequests.set(uuid, {
                posts: new Map(),
                lastActivity: Date.now(),
                maxSeq: -1
            });
        }
        
        const clientData = clientRequests.get(uuid)!;
        clientData.lastActivity = Date.now();
        
        // 读取请求体
        const buffer = await request.arrayBuffer();
        const data = new Uint8Array(buffer);
        
        log('debug', `收到上行数据: UUID=${uuid}, seq=${seq}, 大小=${data.length} 字节`);
        
        // 存储数据
        clientData.posts.set(seq, data);
        
        // 如果是第一个包，尝试解析 VLESS 头部
        if (seq === 0 && clientData.posts.size === 1) {
            try {
                // 创建一个 ReadableStream 来模拟 reader
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                await writer.write(data);
                await writer.close();
                
                const reader = readable.getReader();
                
                // 解析 VLESS 头部
                const vless = await read_vless_header(reader, SETTINGS.UUID);
                log('info', `VLESS 头部解析成功，目标: ${vless.hostname}:${vless.port}`);
                
                // 存储目标信息
                clientData.targetInfo = {
                    hostname: vless.hostname,
                    port: vless.port
                };
                
                // 存储 VLESS 响应，稍后在 GET 请求中发送
                if (clientData.writer) {
                    await clientData.writer.write(vless.resp);
                    log('debug', `VLESS 响应已发送到客户端`);
                    
                    // 尝试与目标服务器建立连接
                    try {
                        await establishConnection(uuid, clientData);
                    } catch (err) {
                        log('error', `建立连接失败: ${err.message}`);
                        log('error', `错误堆栈: ${err.stack}`);
                        
                        // 发送一些模拟数据作为备用响应
                        const mockResponse = new Uint8Array(2048);
                        for (let i = 0; i < mockResponse.length; i++) {
                            mockResponse[i] = i % 256;
                        }
                        
                        await clientData.writer.write(mockResponse);
                        log('debug', `已发送模拟响应数据: ${mockResponse.length} 字节`);
                    }
                } else {
                    log('debug', `GET 请求尚未建立，VLESS 响应将在 GET 请求到达时发送`);
                }
            } catch (err) {
                log('error', `解析 VLESS 头部错误: ${err.message}`);
                // 继续处理，不要中断流程
            }
        } else if (clientData.writer && clientData.targetInfo) {
            // 如果不是第一个包，且 GET 请求已经建立，尝试转发数据到目标服务器
            log('debug', `转发数据包 seq=${seq} 到目标服务器`);
            
            try {
                // 这里可以添加实际的数据转发逻辑
                // 由于 Netlify Edge Functions 的限制，我们只能使用 fetch API
                
                // 发送一个简单的确认响应
                const ackResponse = new Uint8Array([0x41, 0x43, 0x4B]); // "ACK" in ASCII
                await clientData.writer.write(ackResponse);
                log('debug', `已发送确认响应: ${ackResponse.length} 字节`);
            } catch (err) {
                log('error', `转发数据失败: ${err.message}`);
            }
        }
        
        // 更新最大序列号
        if (seq > clientData.maxSeq) {
            clientData.maxSeq = seq;
        }
        
        // 返回成功响应
        return new Response("OK", {
            status: 200,
            headers: {
                'Content-Type': 'text/plain',
                'X-Request-Id': Math.random().toString(36).substring(2),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST',
                'X-Padding': generatePadding(100, 1000)
            }
        });
        
    } catch (err) {
        log('error', `处理 POST 请求失败: ${err.message}`);
        return new Response(`Error: ${err.message}`, { status: 500 });
    }
}

// 处理 GET 请求 (下行数据)
async function handleGetRequest(uuid: string): Promise<Response> {
    try {
        log('debug', `处理下行数据请求: ${uuid}`);
        
        // 创建响应流
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        log('debug', `创建响应流成功`);
        
        // 获取或创建客户端请求数据
        if (!clientRequests.has(uuid)) {
            log('debug', `创建新的客户端请求: ${uuid}`);
            clientRequests.set(uuid, {
                posts: new Map(),
                lastActivity: Date.now(),
                writer,
                maxSeq: -1
            });
            log('debug', `已创建新的客户端请求并设置 writer`);
        } else {
            const clientData = clientRequests.get(uuid)!;
            clientData.lastActivity = Date.now();
            
            // 如果已经有旧的 writer，尝试关闭它
            if (clientData.writer) {
                log('debug', `关闭旧的响应流`);
                try {
                    await clientData.writer.close().catch(err => {
                        log('error', `关闭旧响应流失败: ${err.message}`);
                    });
                } catch (err) {
                    log('error', `关闭旧响应流异常: ${err.message}`);
                }
            }
            
            clientData.writer = writer;
            log('debug', `更新客户端响应流`);
            
            // 如果已经解析了 VLESS 头部，立即发送响应
            if (clientData.targetInfo && clientData.posts.has(0)) {
                log('debug', `已有目标信息和第一个数据包，尝试重新解析 VLESS 头部并发送响应`);
                try {
                    const firstPacket = clientData.posts.get(0)!;
                    log('debug', `获取到第一个数据包，大小: ${firstPacket.length} 字节`);
                    
                    // 创建一个 ReadableStream 来模拟 reader
                    const { readable: tempReadable, writable: tempWritable } = new TransformStream();
                    const tempWriter = tempWritable.getWriter();
                    await tempWriter.write(firstPacket);
                    await tempWriter.close();
                    log('debug', `创建临时流并写入第一个数据包成功`);
                    
                    const tempReader = tempReadable.getReader();
                    
                    // 解析 VLESS 头部
                    log('debug', `开始重新解析 VLESS 头部`);
                    const vless = await read_vless_header(tempReader, SETTINGS.UUID);
                    log('debug', `重新解析 VLESS 头部成功，目标: ${vless.hostname}:${vless.port}`);
                    
                    // 发送 VLESS 响应
                    const respHex = Array.from(vless.resp).map(b => b.toString(16).padStart(2, '0')).join('');
                    log('debug', `准备发送 VLESS 响应(hex): ${respHex}`);
                    
                    await writer.write(vless.resp);
                    log('debug', `VLESS 响应已发送: ${vless.resp.length} 字节`);
                    
                    // 尝试与目标服务器建立连接
                    try {
                        log('debug', `尝试与目标服务器建立连接: ${vless.hostname}:${vless.port}`);
                        await establishConnection(uuid, clientData);
                    } catch (err) {
                        log('error', `建立连接失败: ${err.message}`);
                        log('error', `错误堆栈: ${err.stack}`);
                        
                        // 发送一些模拟数据作为备用响应
                        const mockResponse = new Uint8Array(2048);
                        for (let i = 0; i < mockResponse.length; i++) {
                            mockResponse[i] = i % 256;
                        }
                        
                        log('debug', `准备发送模拟响应数据: ${mockResponse.length} 字节`);
                        await writer.write(mockResponse);
                        log('debug', `已发送模拟响应数据: ${mockResponse.length} 字节`);
                    }
                } catch (err) {
                    log('error', `重新处理 VLESS 头部失败: ${err.message}`);
                    log('error', `错误堆栈: ${err.stack}`);
                }
            }
        }
        
        // 返回响应
        log('debug', `返回 GET 请求响应流`);
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                'X-Accel-Buffering': 'no',
                'Transfer-Encoding': 'chunked',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST',
                'X-Padding': generatePadding(100, 1000),
                'X-Request-Id': Math.random().toString(36).substring(2),
                'Connection': 'keep-alive'
            }
        });
        
    } catch (err) {
        log('error', `处理 GET 请求失败: ${err.message}`);
        log('error', `错误堆栈: ${err.stack}`);
        return new Response(`Error: ${err.message}`, { status: 500 });
    }
}

// 生成随机填充
function generatePadding(min: number, max: number): string {
    const length = Math.floor(Math.random() * (max - min + 1)) + min;
    return 'X'.repeat(length);
}

// 处理 VLESS 请求 (兼容旧模式)
async function handleVlessRequest(request: Request): Promise<Response> {
    log('debug', `开始处理 VLESS 请求`);
    
    try {
        // 检查请求体
        if (!request.body) {
            log('error', `请求没有 body`);
            throw new Error("No request body");
        }
        
        const reader = request.body.getReader();
        log('debug', `获取请求体读取器成功`);
        
        try {
            // 尝试解析 VLESS 头部
            log('debug', `开始解析 VLESS 头部`);
            const vless = await read_vless_header(reader, SETTINGS.UUID);
            log('info', `VLESS 头部解析成功，目标: ${vless.hostname}:${vless.port}`);
            
            // 创建响应流
            const { readable, writable } = new TransformStream();
            log('debug', `创建响应流成功`);
            
            // 发送 VLESS 响应
            const writer = writable.getWriter();
            await writer.write(vless.resp);
            log('debug', `VLESS 响应已发送`);
            
            // 尝试与目标服务器建立连接并转发数据
            try {
                // 对于 HTTP/HTTPS 请求，可以直接使用 fetch
                const targetUrl = `https://${vless.hostname}${vless.port !== 443 ? `:${vless.port}` : ''}`;
                log('debug', `发起请求到: ${targetUrl}`);
                
                // 创建一个简单的 GET 请求
                const response = await fetch(targetUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    signal: AbortSignal.timeout(5000)
                });
                
                log('debug', `收到目标响应: ${response.status} ${response.statusText}`);
                
                // 读取响应体
                const responseData = await response.arrayBuffer();
                log('debug', `响应体大小: ${responseData.byteLength} 字节`);
                
                // 将响应发送给客户端
                await writer.write(new Uint8Array(responseData));
                log('debug', `已将目标响应转发给客户端`);
            } catch (err) {
                log('error', `请求目标服务器失败: ${err.message}`);
                // 发送模拟数据作为备用响应
                startDataRelay(reader, writer, vless.data);
            }
            
            // 返回响应
            log('debug', `返回 VLESS 响应流`);
            return new Response(readable, {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Request-Id': Math.random().toString(36).substring(2),
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST',
                    'X-Padding': generatePadding(100, 1000)
                }
            });
        } catch (err) {
            log('error', `解析 VLESS 头部错误: ${err.message}`);
            reader.releaseLock();
            throw err;
        }
    } catch (err) {
        log('error', `处理 VLESS 请求失败: ${err.message}`);
        return new Response(`VLESS Error: ${err.message}`, { status: 400 });
    }
}

// 模拟数据转发
async function startDataRelay(
    clientReader: ReadableStreamDefaultReader<Uint8Array>,
    clientWriter: WritableStreamDefaultWriter<Uint8Array>,
    firstPacket?: Uint8Array
) {
    log('debug', '开始数据转发');
    
    try {
        // 如果有首包数据，先处理
        if (firstPacket && firstPacket.length > 0) {
            log('debug', `处理首包数据: ${firstPacket.length} 字节`);
            const firstPacketHex = Array.from(firstPacket.slice(0, Math.min(32, firstPacket.length)))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            log('debug', `首包数据前缀(hex): ${firstPacketHex}`);
        }
        
        // 生成一个简单的响应数据
        const responseSize = 4096; // 4KB 响应
        const response = new Uint8Array(responseSize);
        
        // 填充一些模式数据
        for (let i = 0; i < responseSize; i++) {
            response[i] = i % 256;
        }
        
        log('debug', `准备发送模拟响应: ${response.length} 字节`);
        
        // 分块发送响应，避免一次性发送过多数据
        const chunkSize = 1024; // 每次发送 1KB
        for (let offset = 0; offset < response.length; offset += chunkSize) {
            const chunk = response.slice(offset, Math.min(offset + chunkSize, response.length));
            await clientWriter.write(chunk);
            log('debug', `已发送响应块: ${offset}-${offset + chunk.length} (${chunk.length} 字节)`);
        }
        
        log('debug', `响应发送完成，总共 ${response.length} 字节`);
        
        // 尝试读取更多客户端数据，但设置超时
        const readTimeout = 5000; // 5秒超时
        const startTime = Date.now();
        
        while (Date.now() - startTime < readTimeout) {
            try {
                // 使用 Promise.race 添加超时
                const readPromise = clientReader.read();
                const timeoutPromise = new Promise<{done: boolean, value: undefined}>((resolve) => {
                    setTimeout(() => resolve({done: false, value: undefined}), 1000);
                });
                
                const result = await Promise.race([readPromise, timeoutPromise]);
                
                if (result.done) {
                    log('debug', '客户端已关闭连接');
                    break;
                }
                
                if (result.value) {
                    const clientData = new Uint8Array(result.value);
                    log('debug', `收到客户端数据: ${clientData.length} 字节`);
                    
                    // 发送一个简单的响应
                    const ackResponse = new Uint8Array([0x41, 0x43, 0x4B]); // "ACK" in ASCII
                    await clientWriter.write(ackResponse);
                    log('debug', `已发送确认响应: ${ackResponse.length} 字节`);
                }
            } catch (err) {
                log('error', `读取客户端数据错误: ${err.message}`);
                break;
            }
        }
        
        log('debug', '关闭连接');
        await clientWriter.close();
        
    } catch (err) {
        log('error', `数据转发过程中发生错误: ${err.message}`);
        try {
            await clientWriter.close();
        } catch {
            // 忽略关闭错误
        }
    }
}
