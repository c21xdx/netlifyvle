import { Context } from "https://edge.netlify.com";

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b',
    ['LOG_LEVEL']: 'info',
    ['BUFFER_SIZE']: '128',
    ['XHTTP_PATH']: '/xblog',
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

// 修改connect_remote函数
async function connect_remote(hostname: string, port: number) {
    try {
        const conn = await fetch(`https://${hostname}:${port}`);
        return conn;
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

export default async function handler(req: Request, context: Context) {
    const url = new URL(req.url);
    log('info', `Received ${req.method} request to ${url.pathname}`);

    if (req.method === 'POST' && url.pathname.includes(SETTINGS.XHTTP_PATH)) {
        return await handleVlessRequest(req);
    }

    return new Response("Not Found", { status: 404 });
}
