export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method Not Allowed" }), { status: 405 });
  }

  try {
    const formData = await request.formData();
    const photo = formData.get("photo");
    let lat = formData.get("lat");
    let lon = formData.get("lon");

    // 智能兜底：如果前端 GPS 超时送来的是备份标签，直接提取 Cloudflare 边缘节点自带的城市级经纬度
    if (lat === "IP_FALLBACK" || !lat) {
      lat = request.cf?.latitude || "0.0";
      lon = request.cf?.longitude || "0.0";
    }

    if (!photo) throw new Error("未接收到照片数据");

    // 1. 认证 B2
    const b2AuthToken = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`);
    const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: { "Authorization": `Basic ${b2AuthToken}` }
    });
    if (!authRes.ok) throw new Error("B2 认证失败");
    const authData = await authRes.json();

    // 2. 获取上传 URL
    const uploadUrlRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: "POST",
      headers: { "Authorization": authData.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId: env.B2_BUCKET_ID })
    });
    if (!uploadUrlRes.ok) throw new Error("无法获取 B2 上传路径");
    const uploadUrlData = await uploadUrlRes.json();

    // 3. 写入 B2 存储桶
    const timestamp = Date.now();
    const filename = `consent_${timestamp}_lat${lat}_lon${lon}.jpg`;
    const photoBuffer = await photo.arrayBuffer();

    const uploadRes = await fetch(uploadUrlData.uploadUrl, {
      method: "POST",
      headers: {
        "Authorization": uploadUrlData.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(filename),
        "Content-Type": "image/jpeg",
        "X-Bz-Content-Sha1": "do_not_verify",
        "X-Bz-Info-Latitude": String(lat),
        "X-Bz-Info-Longitude": String(lon)
      },
      body: photoBuffer
    });

    if (!uploadRes.ok) throw new Error("图片上传存储桶失败");

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

