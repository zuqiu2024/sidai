// 后端：兼顾图片上传与后台数据列表拉取
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  // ================= 模块一：可视化后台拉取数据列表 =================
  if (url.pathname === "/submit" && request.method === "GET" && url.searchParams.get("action") !== "img") {
    const password = url.searchParams.get("pw");
    // 【安全防线】后台密码
    const correctPassword = env.BACKEND_PW || "521895"; 

    if (password !== correctPassword) {
      return new Response(JSON.stringify({ success: false, error: "暗号错误，拒绝访问" }), {
        status: 403, headers: { "Content-Type": "application/json" }
      });
    }

    try {
      // 1. 认证 B2
      const b2AuthToken = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`);
      const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
        headers: { "Authorization": `Basic ${b2AuthToken}` }
      });
      const authData = await authRes.json();

      // 2. 索要文件列表（按字母倒序，保证最新的照片在最上面）
      const listRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_list_file_names`, {
        method: "POST",
        headers: { "Authorization": authData.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ bucketId: env.B2_BUCKET_ID, maxFileCount: 100 })
      });
      const listData = await listRes.json();

      // 3. 解析文件名中的 GPS 和时间戳信息
      const records = (listData.files || []).map(file => {
        const name = file.fileName;
        // 匹配 consent_时间戳_lat纬度_lon经度.jpg
        const match = name.match(/consent_(\d+)_lat([0-9.-]+)_lon([0-9.-]+)\.jpg/);

        if (match) {
          return {
            fileName: name,
            time: new Date(parseInt(match[1])).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            lat: match[2],
            lon: match[3]
          };
        }
        return null;
      }).filter(Boolean);

      return new Response(JSON.stringify({ success: true, data: records }), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ================= 模块二：原本的拍照上传接口 =================
  if (url.pathname === "/submit" && request.method === "POST") {
    try {
      const formData = await request.formData();
      const photo = formData.get("photo");
      let lat = formData.get("lat");
      let lon = formData.get("lon");

      if (lat === "IP_FALLBACK" || !lat) {
        lat = request.cf?.latitude || "0.0";
        lon = request.cf?.longitude || "0.0";
      }

      if (!photo) throw new Error("未接收到照片数据");

      const b2AuthToken = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`);
      const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
        headers: { "Authorization": `Basic ${b2AuthToken}` }
      });
      const authData = await authRes.json();

      const uploadUrlRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: "POST",
        headers: { "Authorization": authData.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ bucketId: env.B2_BUCKET_ID })
      });
      const uploadUrlData = await uploadUrlRes.json();

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

      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ================= 模块三：图片安全中转 (自动申请临时授权并重定向) =================
  if (url.pathname === "/submit" && request.method === "GET" && url.searchParams.get("action") === "img") {
    const password = url.searchParams.get("pw");
    const fileName = url.searchParams.get("fileName");
    const correctPassword = env.BACKEND_PW || "521895";

    if (password !== correctPassword) return new Response("Forbidden", { status: 403 });
    if (!fileName) return new Response("Missing filename", { status: 400 });

    try {
      // 1. 认证 B2
      const b2AuthToken = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`);
      const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
        headers: { "Authorization": `Basic ${b2AuthToken}` }
      });
      const authData = await authRes.json();

      // 2. 申请针对特定文件的下载授权（1小时内有效）
      const dlAuthRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_download_authorization`, {
        method: "POST",
        headers: { "Authorization": authData.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          bucketId: env.B2_BUCKET_ID,
          fileNamePrefix: fileName,
          validDurationInSeconds: 3600 
        })
      });
      const dlAuthData = await dlAuthRes.json();

      if (!dlAuthData.authorizationToken) {
         throw new Error("Failed to get download authorization");
      }

      // 3. 拼接带合法鉴权的 B2 直链，并 302 重定向过去
      const bucketName = env.B2_BUCKET_NAME || "parent-monitor-consent";
      const b2DirectUrl = `${authData.downloadUrl}/file/${bucketName}/${encodeURIComponent(fileName)}?Authorization=${dlAuthData.authorizationToken}`;

      return Response.redirect(b2DirectUrl, 302);
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
}