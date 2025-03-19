const net = require('net');
const http = require('http');
const fs = require('fs');
const { Readable } = require('stream');

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vless UUID
    ['LOG_LEVEL']: 'debug',  // 改为 info 级别，减少调试信息
    ['BUFFER_SIZE']: '128', // 缓冲区大小 KiB
    ['XHTTP_PATH']: '/xblog', // XHTTP 路径
    ['MAX_BUFFERED_POSTS']: 30,    // 最大缓存POST请求数
    ['MAX_POST_SIZE']: 1000000,    // 每个POST最大字节数(1MB)
    ['SESSION_TIMEOUT']: 30000,    // 会话超时时间(30秒)
}

// 基础工具函数
function validate_uuid(left, right) {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

function concat_typed_arrays(first, ...args) {
    if (!args || args.length < 1) return first
    let len = first.length
    for (let a of args) len += a.length
    const r = new first.constructor(len)
    r.set(first, 0)
    len = first.length
    for (let a of args) {
        r.set(a, len)
        len += a.length
    }
    return r
}

// 扩展日志函数
function log(type, ...args) {
    const levels = {
        'debug': 0,
        'info': 1,
        'warn': 2,
        'error': 3
    };
    
    const colors = {
        'debug': '\x1b[36m', // 青色
        'info': '\x1b[32m',  // 绿色
        'warn': '\x1b[33m',  // 黄色
        'error': '\x1b[31m', // 红色
        'reset': '\x1b[0m'   // 重置
    };

    const configLevel = levels[SETTINGS.LOG_LEVEL] || 1;
    const messageLevel = levels[type] || 0;

    if (messageLevel >= configLevel) {
        const time = new Date().toISOString();
        const color = colors[type] || colors.reset;
        console.log(`${color}[${time}] [${type}]`, ...args, colors.reset);
    }
}

// VLESS 协议解析
function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '')
    const r = []
    for (let index = 0; index < 16; index++) {
        r.push(parseInt(uuid.substr(index * 2, 2), 16))
    }
    return r
}

async function read_vless_header(reader, cfg_uuid_str) {
    // 移除调试日志，只保留连接信息
    let readed_len = 0
    let header = new Uint8Array()

    // prevent inner_read_until() throw error
    let read_result = { value: header, done: false }
    async function inner_read_until(offset) {
        if (read_result.done) {
            throw new Error('header length too short')
        }
        const len = offset - readed_len
        if (len < 1) {
            return
        }
        read_result = await read_atleast(reader, len)
        readed_len += read_result.value.length
        header = concat_typed_arrays(header, read_result.value)
    }

    await inner_read_until(1 + 16 + 1)

    const version = header[0]
    const uuid = header.slice(1, 1 + 16)
    const cfg_uuid = parse_uuid(cfg_uuid_str)
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`)
    }
    const pb_len = header[1 + 16]
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1
    await inner_read_until(addr_plus1 + 1)

    const cmd = header[1 + 16 + 1 + pb_len]
    const COMMAND_TYPE_TCP = 1
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`)
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1]
    const atype = header[addr_plus1 - 1]

    const ADDRESS_TYPE_IPV4 = 1
    const ADDRESS_TYPE_STRING = 2
    const ADDRESS_TYPE_IPV6 = 3
    let header_len = -1
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1]
    }
    if (header_len < 0) {
        throw new Error('read address type failed')
    }
    await inner_read_until(header_len)

    const idx = addr_plus1
    let hostname = ''
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.')
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        )
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':')
    }
    
    if (!hostname) {
        log('error', 'Failed to parse hostname');
        throw new Error('parse hostname failed')
    }
    
    log('info', `VLESS connection to ${hostname}:${port}`);
    return {
        hostname,
        port,
        data: header.slice(header_len),
        resp: new Uint8Array([version, 0]),
    }
}

// 添加 read_atleast 函数
async function read_atleast(reader, n) {
    const buffs = []
    let done = false
    while (n > 0 && !done) {
        const r = await reader.read()
        if (r.value) {
            const b = new Uint8Array(r.value)
            buffs.push(b)
            n -= b.length
        }
        done = r.done
    }
    if (n > 0) {
        throw new Error(`not enough data to read`)
    }
    return {
        value: concat_typed_arrays(...buffs),
        done,
    }
}

// 添加 parse_header 函数
async function parse_header(uuid_str, client) {
    log('debug', 'Starting to parse VLESS header');
    const reader = client.readable.getReader()
    try {
        const vless = await read_vless_header(reader, uuid_str)
        log('debug', 'VLESS header parsed successfully');
        return vless
    } catch (err) {
        log('error', `VLESS header parse error: ${err.message}`);
        throw new Error(`read vless header error: ${err.message}`)
    } finally {
        reader.releaseLock()
    }
}

// 添加 connect_remote 函数
async function connect_remote(hostname, port) {
    const timeout = 8000;
    try {
        const conn = await timed_connect(hostname, port, timeout);
        log('info', `Connected to ${hostname}:${port}`);
        return conn;
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// 添加 timed_connect 函数
function timed_connect(hostname, port, ms) {
    return new Promise((resolve, reject) => {
        const conn = net.createConnection({ host: hostname, port: port })
        const handle = setTimeout(() => {
            reject(new Error(`connect timeout`))
        }, ms)
        conn.on('connect', () => {
            clearTimeout(handle)
            resolve(conn)
        })
        conn.on('error', (err) => {
            clearTimeout(handle)
            reject(err)
        })
    })
}

// 网络传输
function pipe_relay() {
    async function pump(src, dest, first_packet) {
        log('debug', `Starting relay with first packet length: ${first_packet.length}`);
        if (first_packet.length > 0) {
            if (dest.write) {
                // Node.js Stream
                await new Promise((resolve, reject) => {
                    dest.write(first_packet, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                // Web Stream
                const writer = dest.writable.getWriter();
                try {
                    await writer.write(first_packet);
                } finally {
                    writer.releaseLock();
                }
            }
        }
        
        try {
            if (src.pipe) {
                // Node.js Stream
                await new Promise((resolve, reject) => {
                    src.pipe(dest);
                    src.on('end', resolve);
                    src.on('error', reject);
                });
            } else {
                // Web Stream
                await src.readable.pipeTo(dest.writable);
            }
        } catch (err) {
            log('error', 'Relay error:', err.message);
            throw err;
        }
    }
    return pump;
}

// XHTTP 客户端
function create_xhttp_client(cfg, buff_size, nodeReadableStream) {
    log('debug', 'Creating XHTTP client');
    
    // 将 Node.js 可读流转换为 Web Streams API 可读流
    const readable = new ReadableStream({
        start(controller) {
            nodeReadableStream.on('data', (chunk) => {
                controller.enqueue(chunk);
            });
            nodeReadableStream.on('end', () => {
                controller.close();
            });
            nodeReadableStream.on('error', (err) => {
                controller.error(err);
            });
        }
    });

    const buff_stream = new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(chunk)
        },
    })

    const headers = {
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-store',
        Connection: 'Keep-Alive',
        // 移除 grpc 相关头部
        'Content-Type': 'text/event-stream'  // 改为 event-stream
    }

    const resp = new Response(buff_stream.readable, { 
        status: 200,
        headers: headers 
    })
    log('debug', 'XHTTP client created with headers:', headers);
    
    return {
        readable: readable,
        writable: buff_stream.writable,
        resp,
    }
}

// 核心处理逻辑
async function handle_client(cfg, client) {
    try {
        log('info', 'New client connection received');
        const vless = await parse_header(cfg.UUID, client)
        log('info', `Connecting to remote: ${vless.hostname}:${vless.port}`);
        const remote = await connect_remote(vless.hostname, vless.port)
        log('info', 'Remote connection established');
        relay(cfg, client, remote, vless)
        return true
    } catch (err) {
        log('error', 'Client handling error:', err.message);
        client.close && client.close()
    }
    return false
}

// 修改 socketToWebStream 函数
function socketToWebStream(socket) {
    let readController;
    let writeController;
    
    socket.on('error', (err) => {
        log('error', 'Socket error:', err.message);
        readController?.error(err);
        writeController?.error(err);
    });

    return {
        readable: new ReadableStream({
            start(controller) {
                readController = controller;
                socket.on('data', (chunk) => {
                    try {
                        controller.enqueue(chunk);
                    } catch (err) {
                        log('error', 'Read controller error:', err.message);
                    }
                });
                socket.on('end', () => {
                    try {
                        controller.close();
                    } catch (err) {
                        log('error', 'Read controller close error:', err.message);
                    }
                });
            },
            cancel() {
                socket.destroy();
            }
        }),
        writable: new WritableStream({
            start(controller) {
                writeController = controller;
            },
            write(chunk) {
                return new Promise((resolve, reject) => {
                    if (socket.destroyed) {
                        reject(new Error('Socket is destroyed'));
                        return;
                    }
                    socket.write(chunk, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            },
            close() {
                if (!socket.destroyed) {
                    socket.end();
                }
            },
            abort(err) {
                socket.destroy(err);
            }
        })
    };
}

// 修改 relay 函数
function relay(cfg, client, remote, vless) {
    const pump = pipe_relay();
    let isClosing = false;
    
    const remoteStream = socketToWebStream(remote);
    
    function cleanup() {
        if (!isClosing) {
            isClosing = true;
            try {
                remote.destroy();
            } catch (err) {
                // 忽略常规断开错误
                if (!err.message.includes('aborted') && 
                    !err.message.includes('socket hang up')) {
                    log('error', `Cleanup error: ${err.message}`);
                }
            }
        }
    }

    const uploader = pump(client, remoteStream, vless.data)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Upload error: ${err.message}`);
            }
        })
        .finally(() => {
            client.reading_done && client.reading_done();
        });

    const downloader = pump(remoteStream, client, vless.resp)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Download error: ${err.message}`);
            }
        });

    downloader
        .finally(() => uploader)
        .finally(cleanup);
}

// HTTP 服务器
const sessions = new Map();

class Session {
    constructor(uuid) {
        this.uuid = uuid;
        this.nextSeq = 0;
        this.downstreamStarted = false;
        this.lastActivity = Date.now();
        this.vlessHeader = null;
        this.remote = null;
        this.initialized = false;
        this.responseHeader = null;
        this.headerSent = false;
        this.bufferedData = new Map();
        this.cleaned = false;
        this.pendingPackets = [];  // 存储待处理的数据包
        this.currentStreamRes = null; // 当前下行流响应
        this.pendingBuffers = new Map(); // 存储未按序到达的数据包
        log('debug', `Created new session with UUID: ${uuid}`);
    }

    async initializeVLESS(firstPacket) {
        if (this.initialized) return true;
        
        try {
            log('debug', 'Initializing VLESS connection from first packet');
            // 创建可读流来解析VLESS头
            const readable = new ReadableStream({
                start(controller) {
                    controller.enqueue(firstPacket);
                    controller.close();
                }
            });
            
            const client = {
                readable: readable,
                writable: new WritableStream()
            };
            
            this.vlessHeader = await parse_header(SETTINGS.UUID, client);
            log('info', `VLESS header parsed: ${this.vlessHeader.hostname}:${this.vlessHeader.port}`);
            
            // 建立远程连接
            this.remote = await connect_remote(this.vlessHeader.hostname, this.vlessHeader.port);
            log('info', 'Remote connection established');
            
            this.initialized = true;
            return true;
        } catch (err) {
            log('error', `Failed to initialize VLESS: ${err.message}`);
            return false;
        }
    }

    async processPacket(seq, data) {
        try {
            // 保存数据到pendingBuffers
            this.pendingBuffers.set(seq, data);
            log('debug', `Buffered packet seq=${seq}, size=${data.length}`);
            
            // 按序处理数据包
            while (this.pendingBuffers.has(this.nextSeq)) {
                const nextData = this.pendingBuffers.get(this.nextSeq);
                this.pendingBuffers.delete(this.nextSeq);
                
                // 只有第一个包需要初始化VLESS
                if (!this.initialized && this.nextSeq === 0) {
                    if (!await this.initializeVLESS(nextData)) {
                        throw new Error('Failed to initialize VLESS connection');
                    }
                    // 存储响应头
                    this.responseHeader = Buffer.from(this.vlessHeader.resp);
                    // 写入VLESS头部数据到远程
                    await this._writeToRemote(this.vlessHeader.data);
                    
                    // 如果有待处理的下游连接，立即发送响应
                    if (this.currentStreamRes) {
                        this._startDownstreamResponse();
                    }
                } else {
                    // 后续数据包直接发送
                    if (!this.initialized) {
                        log('warn', `Received out of order packet seq=${seq} before initialization`);
                        continue;
                    }
                    await this._writeToRemote(nextData);
                }
                
                this.nextSeq++;
                log('debug', `Processed packet seq=${this.nextSeq-1}`);
            }

            // 检查缓存大小
            if (this.pendingBuffers.size > SETTINGS.MAX_BUFFERED_POSTS) {
                throw new Error('Too many buffered packets');
            }

            return true;
        } catch (err) {
            log('error', `Process packet error: ${err.message}`);
            throw err;
        }
    }

    _startDownstreamResponse() {
        if (!this.currentStreamRes || !this.responseHeader) return;
        
        try {
            const protocol = this.currentStreamRes.socket?.alpnProtocol || 'http/1.1';
            const isH2 = protocol === 'h2';

            if (!this.headerSent) {
                log('debug', `Sending VLESS response header (${protocol}): ${this.responseHeader.length} bytes`);
                this.currentStreamRes.write(this.responseHeader);
                this.headerSent = true;
            }
            
            // 根据协议使用不同的传输策略
            if (isH2) {
                // HTTP/2 优化
                this.currentStreamRes.socket.setNoDelay(true);
                
                // 使用 Transform 流进行数据分块
                const transform = new require('stream').Transform({
                    transform(chunk, encoding, callback) {
                        const size = 16384; // 16KB chunks
                        for (let i = 0; i < chunk.length; i += size) {
                            this.push(chunk.slice(i, i + size));
                        }
                        callback();
                    }
                });
                
                this.remote.pipe(transform).pipe(this.currentStreamRes);
            } else {
                // HTTP/1.1 直接传输
                this.remote.pipe(this.currentStreamRes);
            }
            
            // 处理关闭事件
            this.remote.on('end', () => {
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            });
            
            this.remote.on('error', (err) => {
                log('error', `Remote error: ${err.message}`);
                if (!this.currentStreamRes.writableEnded) {
                    this.currentStreamRes.end();
                }
            });
        } catch (err) {
            log('error', `Error starting downstream: ${err.message}`);
            this.cleanup();
        }
    }

    startDownstream(res, headers) {
        if (!res.headersSent) {
            res.writeHead(200, headers);
        }

        this.currentStreamRes = res;
        
        if (this.initialized && this.responseHeader) {
            this._startDownstreamResponse();
        }
        
        res.on('close', () => {
            log('info', 'Client connection closed');
            this.cleanup();
        });

        return true;
    }

    async _writeToRemote(data) {
        if (!this.remote || this.remote.destroyed) {
            throw new Error('Remote connection not available');
        }

        // 优化大数据包处理
        if (data.length > 16384) { // 16KB chunks
            const chunks = [];
            for (let i = 0; i < data.length; i += 16384) {
                chunks.push(data.slice(i, i + 16384));
            }
                
            for (const chunk of chunks) {
                await new Promise((resolve, reject) => {
                    this.remote.write(chunk, (err) => {
                        if (err) {
                            log('error', `Failed to write chunk to remote: ${err.message}`);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            }
            return;
        }

        return new Promise((resolve, reject) => {
            this.remote.write(data, (err) => {
                if (err) {
                    log('error', `Failed to write to remote: ${err.message}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    cleanup() {
        if (!this.cleaned) {
            this.cleaned = true;
            log('debug', `Cleaning up session ${this.uuid}`);
            if (this.remote) {
                this.remote.destroy();
                this.remote = null;
            }
            this.initialized = false;
            this.headerSent = false;
        }
    }
}

// 设置全局配置
// 设置全局配置
const PERFORMANCE_SETTINGS = {
    h2: {
        initialWindowSize: 1024 * 1024, // 1MB
        maxFrameSize: 16384, // 16KB
        maxConcurrentStreams: 100
    }
};

// 修改服务器创建方式 - 改回使用普通的 http server
const server = http.createServer((req, res) => {
    // 从请求头获取实际协议版本
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const isHttps = protocol === 'https';
    
    // 添加通用响应头
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Padding': generatePadding(100, 1000),
    };

    // 强制启用长连接
    headers['Connection'] = 'keep-alive'; 
    headers['Keep-Alive'] = 'timeout=600';

    const startTime = Date.now();
    log('info', `=> ${req.method} ${req.url}`);

    // 解析 UUID 和 seq
    const pathMatch = req.url.match(new RegExp(`${SETTINGS.XHTTP_PATH}/([^/]+)(?:/([0-9]+))?$`));
    if (!pathMatch) {
        res.writeHead(404);
        res.end();
        return;
    }

    const uuid = pathMatch[1];
    const seq = pathMatch[2] ? parseInt(pathMatch[2]) : null;

    if (req.method === 'GET' && !seq) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Transfer-Encoding'] = 'chunked';

        let session = sessions.get(uuid);
        if (!session) {
            session = new Session(uuid);
            sessions.set(uuid, session);
            log('info', `Created new session for GET: ${uuid}`);
        }

        session.downstreamStarted = true;
        
        if (!session.startDownstream(res, headers)) {
            log('error', `Failed to start downstream for session: ${uuid}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
            session.cleanup();
            sessions.delete(uuid);
        }
        return;
    }
    
    // 处理上行流
    if (req.method === 'POST' && seq !== null) {
        headers['Content-Type'] = 'text/plain';
        
        let session = sessions.get(uuid);
        if (!session) {
            session = new Session(uuid);
            sessions.set(uuid, session);
            log('info', `Created new session for POST: ${uuid}`);
            
            setTimeout(() => {
                const currentSession = sessions.get(uuid);
                if (currentSession && !currentSession.downstreamStarted) {
                    log('warn', `Session ${uuid} timed out without downstream`);
                    currentSession.cleanup();
                    sessions.delete(uuid);
                }
            }, SETTINGS.SESSION_TIMEOUT);
        }

        let data = [];
        let size = 0;
        
        req.on('data', chunk => {
            size += chunk.length;
            if (size > SETTINGS.MAX_POST_SIZE) {
                res.writeHead(413);
                res.end();
                return;
            }
            data.push(chunk);
        });

        req.on('end', async () => {
            try {
                const buffer = Buffer.concat(data);
                log('info', `Processing packet: seq=${seq}, size=${buffer.length}`);
                
                await session.processPacket(seq, buffer);
                res.writeHead(200, headers);
                res.end();
                
                log('debug', `POST request completed in ${Date.now() - startTime}ms`);
            } catch (err) {
                log('error', `Failed to process POST request: ${err.message}`);
                session.cleanup();
                sessions.delete(uuid);
                res.writeHead(500);
                res.end();
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

// 启用 HTTP/2 和 HTTP/1.1 监听
server.on('secureConnection', (socket) => {
    log('debug', `New secure connection using: ${socket.alpnProtocol || 'http/1.1'}`);
});

// 添加工具函数
function generatePadding(min, max) {
    const length = min + Math.floor(Math.random() * (max - min));
    return Buffer.from(Array(length).fill('X').join('')).toString('base64');
}

const PORT = process.env.PORT || 30515;

server.keepAliveTimeout = 620000; // 确保比 nginx 的 keepalive_timeout 更长
server.headersTimeout = 625000;   // 需要比 keepAliveTimeout 多 5000ms

server.on('error', (err) => {
    log('error', `Server error: ${err.message}`);
});

server.listen(PORT, () => {
    log('info', `=================================`);
    log('info', `Server running on port ${PORT}`);
    log('info', `VLESS UUID: ${SETTINGS.UUID}`);
    log('info', `Log level: ${SETTINGS.LOG_LEVEL}`);
    log('info', `Max buffer size: ${SETTINGS.BUFFER_SIZE}KB`);
    log('info', `=================================`);
});
