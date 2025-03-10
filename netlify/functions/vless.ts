import { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    ['LOG_LEVEL']: 'debug',  // 改为debug级别以输出更多信息
    ['BUFFER_SIZE']: '128',
    ['XHTTP_PATH']: '/xblog',
    ['LOG_DETAIL']: true,    // 是否输出详细日志
} as const;

// 定义日志级别
const LOG_LEVELS = {
    'debug': 0,
    'info': 1,
    'warn': 2,
    'error': 3
} as const;

// 工具函数
// 修改log函数，确保始终输出关键日志
function log(type: string, ...args: unknown[]) {
    const time = new Date().toISOString();
    console.log(`[${time}] [${type}]`, ...args);
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

// 添加handleVlessRequest函数的实现
async function handleVlessRequest(req: Request) {
    log('info', '开始处理VLESS请求');
    try {
        const reader = req.body?.getReader();
        if (!reader) {
            throw new Error('请求体为空');
        }

        const vless = await read_vless_header(reader, SETTINGS.UUID);
        log('debug', `VLESS解析结果: 版本=${vless.version}, 目标=${vless.hostname}:${vless.port}`);

        // 准备请求数据
        const newHeaders = new Headers();
        newHeaders.set('Host', vless.hostname);
        newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0');
        newHeaders.set('Accept', '*/*');
        newHeaders.set('Accept-Language', 'en-US,en;q=0.9');
        newHeaders.set('Connection', 'keep-alive');

        // 创建到目标服务器的请求
        const protocol = vless.port === 443 ? 'https' : 'http';
        const targetUrl = `${protocol}://${vless.hostname}`;

        // 准备请求配置
        const fetchOptions = {
            method: 'POST',
            headers: newHeaders,
            body: req.body,
            duplex: 'half' as const
        };

        // 发送请求
        log('debug', `正在连接到目标服务器: ${targetUrl}`);
        const remoteResponse = await fetch(targetUrl, fetchOptions);
        log('debug', `目标服务器响应状态: ${remoteResponse.status}`);

        // 创建响应流
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        // 写入VLESS响应头
        await writer.write(vless.resp);

        // 转发响应体
        if (remoteResponse.body) {
            remoteResponse.body.pipeTo(writable).catch(error => {
                log('error', '转发响应数据时出错:', error);
            });
        } else {
            writer.close();
        }

        // 返回最终响应
        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-store'
            }
        });

    } catch (err) {
        log('error', `处理VLESS请求失败: ${err.message}`);
        return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
    }
}

export default async function handler(req: Request, context: Context) {
    const url = new URL(req.url);
    log('info', `收到请求: ${req.method} ${url.pathname}`);

    // 修改路径匹配逻辑：使用startsWith检查前缀
    if (req.method === 'POST' && url.pathname.startsWith(SETTINGS.XHTTP_PATH)) {
        log('info', `匹配到VLESS请求路径: ${url.pathname}`);
        return await handleVlessRequest(req);
    }

    log('info', '未匹配到VLESS路径，返回404');
    return new Response("Not Found", { status: 404 });
}
