// netlify/edge-functions/vless.ts
import { read_vless_header, relay, LOG_LEVELS } from "./vless-utils.ts";

// 配置（从环境变量读取）
const SETTINGS = {
  UUID: process.env.VLESS_UUID || "0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  BUFFER_SIZE: process.env.BUFFER_SIZE || "128",
  XHTTP_PATH: process.env.XHTTP_PATH || "/xblog",
} as const;

// 日志函数（适配 Netlify）
function log(type: string, ...args: unknown[]) {
  const level = LOG_LEVELS[type as keyof typeof LOG_LEVELS] || 0;
  const configLevel = LOG_LEVELS[SETTINGS.LOG_LEVEL as keyof typeof LOG_LEVELS] || 1;
  if (level >= configLevel) {
    console.log(`[${type}]`, ...args);
  }
}

// 处理请求
export default async (request: Request) => {
  const url = new URL(request.url);

  // 仅处理指定路径的 POST 请求
  if (request.method !== "POST" || !url.pathname.startsWith(SETTINGS.XHTTP_PATH)) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    // 解析 VLESS 请求头
    const reader = request.body?.getReader();
    if (!reader) throw new Error("No request body");
    const { hostname, port, data, resp } = await read_vless_header(reader, SETTINGS.UUID);

    // 连接到远程服务器（需替换为支持 TCP 的中转服务）
    const remoteUrl = `https://${hostname}:${port}`;
    const remoteResponse = await fetch(remoteUrl, {
      method: "POST",
      headers: request.headers,
      body: data,
      duplex: "half",
    });

    // 中转数据
    const { readable, writable } = new TransformStream();
    relay(reader, remoteResponse, writable, resp);

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Proxy-Status": "active",
      },
    });
  } catch (error) {
    log("error", "代理失败:", error);
    return new Response("Bad Request", { status: 400 });
  }
};

// 数据中转（需适配 Fetch API）
async function relay(
  clientReader: ReadableStreamDefaultReader<Uint8Array>,
  remoteResponse: Response,
  clientWritable: WritableStream<Uint8Array>,
  vlessResp: Uint8Array
) {
  try {
    // 发送 VLESS 响应
    const writer = clientWritable.getWriter();
    await writer.write(vlessResp);
    writer.releaseLock();

    // 双向转发
    const remoteReader = remoteResponse.body?.getReader();
    if (!remoteReader) throw new Error("Remote read failed");

    // 远程到客户端
    (async () => {
      try {
        while (true) {
          const { value, done } = await remoteReader.read();
          if (done) break;
          const writer = clientWritable.getWriter();
          await writer.write(value);
          writer.releaseLock();
        }
      } catch (error) {
        log("error", "远程读取失败:", error);
      }
    })();

    // 客户端到远程
    (async () => {
      try {
        while (true) {
          const { value, done } = await clientReader.read();
          if (done) break;
          await remoteResponse.body?.pipeThrough(new TransformStream()).pipeTo(clientWritable);
        }
      } catch (error) {
        log("error", "客户端读取失败:", error);
      }
    })();
  } catch (error) {
    log("error", "中转失败:", error);
  }
}
