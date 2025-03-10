// Netlify Edge Functions 版本的 VLESS over XHTTP 代理
import type { Context } from "https://edge.netlify.com";

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
    // 检查当前日志级别是否应该输出
    const currentLevel = LOG_LEVELS[type as keyof typeof LOG_LEVELS] || 0;
    const configLevel = LOG_LEVELS[SETTINGS.LOG_LEVEL as keyof typeof LOG_LEVELS] || 1;
    
    if (currentLevel >= configLevel) {
        const time = new Date().toISOString();
        console.log(`[${time}] [${type}]`, ...args);
    }
}

// ... 其他工具函数保持不变 ...

// Netlify Edge Function 处理函数
export default async (request: Request, context: Context) => {
    return await handleRequest(request);
};

// 配置 Netlify Edge Function
export const config = {
    path: SETTINGS.XHTTP_PATH + "*", // 匹配 XHTTP_PATH 及其子路径
};

// 请求处理函数
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    log('info', `Received ${request.method} request to ${url.pathname}`);

    // 修改为更灵活的路径匹配
    if (request.method === 'POST' && url.pathname.endsWith(SETTINGS.XHTTP_PATH)) {
        return await handleVlessRequest(request);
    }

    // 添加简单的健康检查端点
    if (request.method === 'GET' && url.pathname === '/health') {
        return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
}

// ... 其他函数保持不变 ...
