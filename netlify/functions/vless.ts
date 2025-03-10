// netlify/edge-functions/vless-proxy.ts
export default async (request: Request) => {
  // 从环境变量获取后端服务器地址
  const TARGET_URL = Deno.env.get('VLESS_SERVER_URL') || 'http://your-vless-server.com';

  // 仅处理 POST 请求（VLESS over XHTTP 通常使用 POST）
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // 转发请求到后端 VLESS 服务器
    const response = await fetch(TARGET_URL, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      duplex: 'half', // 必须配置以支持流式传输
    });

    // 返回后端服务器的响应
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    console.error('代理失败:', error);
    return new Response('Proxy Error', { status: 502 });
  }
};
