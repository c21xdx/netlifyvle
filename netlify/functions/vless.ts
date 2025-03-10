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

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);

    // 检查请求方法和路径
    if (request.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        log('debug', `匹配到 VLESS 请求路径: ${url.pathname}`);
        return await handleVlessRequest(request);
    } else if (request.method === 'GET' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        // 处理 GET 请求，可能是客户端的初始化请求
        log('debug', `收到 GET 请求，可能是客户端初始化: ${url.pathname}`);
        return new Response("OK", { 
            status: 200,
            headers: {
                'Content-Type': 'text/plain',
                'X-Request-Id': Math.random().toString(36).substring(2)
            }
        });
    }

    // 添加简单的健康检查端点
    if (request.method === 'GET' && url.pathname === '/health') {
        return new Response("OK", { status: 200 });
    }

    log('debug', `未匹配到任何处理路径: ${url.pathname}`);
    return new Response("Not Found", { status: 404 });
}

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
            
            // 模拟连接远程服务器
            log('debug', `模拟连接到远程服务器: ${vless.hostname}:${vless.port}`);
            
            // 在 Netlify Edge Functions 中，我们无法直接建立 TCP 连接
            // 所以这里只是模拟一个响应
            
            // 启动数据转发
            startDataRelay(reader, writer, vless.data);
            
            // 返回响应
            log('debug', `返回 VLESS 响应流`);
            return new Response(readable, {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Request-Id': Math.random().toString(36).substring(2),
                    'Connection': 'keep-alive'
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
            // 在实际场景中，这里应该将数据发送到远程服务器
        }
        
        // 模拟数据转发
        setTimeout(async () => {
            try {
                // 模拟从远程服务器收到的响应
                const mockResponse = new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body>Hello from VLESS proxy!</body></html>");
                await clientWriter.write(mockResponse);
                log('debug', `已发送模拟响应: ${mockResponse.length} 字节`);
                
                // 继续读取客户端数据
                while (true) {
                    const { value, done } = await clientReader.read();
                    if (done) {
                        log('debug', '客户端已关闭连接');
                        break;
                    }
                    
                    if (value) {
                        log('debug', `收到客户端数据: ${value.length} 字节`);
                        // 在实际场景中，这里应该将数据发送到远程服务器
                    }
                }
            } catch (err) {
                log('error', `数据转发错误: ${err.message}`);
            } finally {
                try {
                    await clientWriter.close();
                } catch (err) {
                    log('error', `关闭写入器错误: ${err.message}`);
                }
            }
        }, 100);
        
    } catch (err) {
        log('error', `启动数据转发错误: ${err.message}`);
        try {
            await clientWriter.close();
        } catch {
            // 忽略关闭错误
        }
    }
}

// 以下是缺少的工具函数

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
            
            // 模拟连接远程服务器
            log('debug', `模拟连接到远程服务器: ${vless.hostname}:${vless.port}`);
            
            // 启动数据转发
            startDataRelay(reader, writer, vless.data);
            
            // 返回响应
            log('debug', `返回 VLESS 响应流`);
            return new Response(readable, {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Request-Id': Math.random().toString(36).substring(2),
                    'Connection': 'keep-alive'
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
