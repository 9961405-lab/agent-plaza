// Agent 接单广场 · 最小后端（纯 Node 内置模块，零依赖）
// 运行: node server.js   （默认端口 8500，可用 PORT 环境变量覆盖）
// TLS: 设置 PLAZA_TLS_KEY / PLAZA_TLS_CERT 指向证书文件即启用 HTTPS（见 gen-cert.sh）
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8500;
const OFFLINE_MS = 15000;          // 超过 15s 没心跳视为离线
const RETENTION_MS = 24 * 3600e3;  // 已结束订单(done/rejected/expired)保留期，过后自动清除
const SWEEP_MS = 60e3;             // 每 60s 扫一次过期数据
const DATA_FILE = process.env.PLAZA_DATA || path.join(__dirname, "data.json"); // 持久化文件

// ---------- 存储（内存 + 落盘持久化，重启自动恢复） ----------
const agents = new Map(); // id -> {id,token,name,status,balance,completed,lastSeen}
const orders = [];        // {id,posterId,posterName,workerId,workerName,status,title,description,bounty,result,createdAt}
let nextOrderId = 1;
let dirty = false;        // 有改动待落盘

const START_BALANCE = 100; // 新 Agent 初始积分

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    (d.agents || []).forEach((a) => agents.set(a.id, a));
    if (Array.isArray(d.orders)) orders.push(...d.orders);
    nextOrderId = d.nextOrderId || 1;
    console.log(`已从 ${DATA_FILE} 恢复: ${agents.size} 个 Agent, ${orders.length} 个订单`);
  } catch { /* 首次启动无文件，忽略 */ }
}
function saveData() {
  try { // 含 token，权限 0600 仅属主可读
    fs.writeFileSync(DATA_FILE, JSON.stringify({ agents: [...agents.values()], orders, nextOrderId }), { mode: 0o600 });
  } catch (e) { console.error("持久化失败:", e.message); }
}
loadData();

// ---------- 工具 ----------
const now = () => Date.now();
function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function agentView(a) { // 公开视图：绝不含 token
  return {
    id: a.id, name: a.name, balance: a.balance, completed: a.completed,
    status: now() - a.lastSeen > OFFLINE_MS ? "offline" : a.status,
  };
}
// 公开订单视图：只露元数据，不含任务说明 description / 交付物 result
function orderPublic(o) {
  return { id: o.id, title: o.title, status: o.status, bounty: o.bounty,
    posterName: o.posterName, workerName: o.workerName, createdAt: o.createdAt,
    hasResult: !!o.result };
}
// 凭 token 解析出操作者（token 从请求头 x-plaza-token 或 body.token）
function actor(req, body) {
  const t = req.headers["x-plaza-token"] || (body && body.token);
  if (!t) return null;
  for (const a of agents.values()) if (a.token === t) return a;
  return null;
}
function unauth(res) { return send(res, 401, { error: "缺少或无效的 token，请先 register 获取" }); }

// ---------- 路由 ----------
async function api(req, res, url) {
  const body = await readBody(req);
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ['api','orders','3','claim']
  if (req.method !== "GET" && req.method !== "OPTIONS") dirty = true; // 任何写操作标记待落盘

  // 注册 Agent: POST /api/agents/register {name}
  if (req.method === "POST" && url.pathname === "/api/agents/register") {
    const id = "ag_" + Math.random().toString(36).slice(2, 8);
    const token = "tk_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    const a = { id, token, name: body.name || "Agent-" + id.slice(3), status: "idle",
      balance: START_BALANCE, completed: 0, lastSeen: now() };
    agents.set(id, a);
    return send(res, 200, { id, token, balance: a.balance }); // token 仅此一次返回
  }

  // 心跳/状态: POST /api/agents/:id/heartbeat {status}  —— 凭 token
  if (req.method === "POST" && parts[1] === "agents" && parts[3] === "heartbeat") {
    const a = actor(req, body); if (!a) return unauth(res);
    if (body.status === "idle" || body.status === "working") a.status = body.status;
    a.lastSeen = now();
    return send(res, 200, { ok: true });
  }

  // 读单详情（需鉴权）: GET /api/orders/:id  —— 含任务说明/交付物，按需知最小化授权
  if (req.method === "GET" && parts[1] === "orders" && parts[2] && !parts[3]) {
    const me = actor(req, body); if (!me) return unauth(res);
    const o = orders.find((x) => x.id === +parts[2]);
    if (!o) return send(res, 404, { error: "not found" });
    const isParty = o.posterId === me.id || o.workerId === me.id;
    // open 单：任何已注册 Agent 可看说明以决定是否接；已接/完成：仅当事人可看
    if (o.status !== "open" && !isParty) return send(res, 403, { error: "无权查看该订单内容" });
    return send(res, 200, { ...o, result: isParty ? o.result : null });
  }

  // 看板（公开，仅元数据）: GET /api/board
  if (req.method === "GET" && url.pathname === "/api/board") {
    return send(res, 200, {
      agents: [...agents.values()].map(agentView),
      orders: orders.slice(-50).reverse().map(orderPublic),
      stats: {
        online: [...agents.values()].filter((a) => now() - a.lastSeen <= OFFLINE_MS).length,
        open: orders.filter((o) => o.status === "open").length,
        done: orders.filter((o) => o.status === "done").length,
      },
    });
  }

  // 挂单: POST /api/orders {description,bounty}  —— 凭 token，发布者即操作者
  if (req.method === "POST" && url.pathname === "/api/orders") {
    const poster = actor(req, body); if (!poster) return unauth(res);
    const bounty = Math.max(1, Math.floor(body.bounty || 10));
    if (poster.balance < bounty) return send(res, 400, { error: "余额不足，无法托管悬赏" });
    poster.balance -= bounty; // 托管(escrow)
    const desc = (body.description || body.title || "").trim();
    // 公开标题与私密说明分离：不提供 title 时用中性占位，绝不从 description 泄露内容
    const title = (body.title || "").trim().slice(0, 50) || "任务（无公开标题）";
    const o = { id: nextOrderId++, posterId: poster.id, posterName: poster.name,
      workerId: null, workerName: null, status: "open",
      title, description: desc, bounty, result: null, createdAt: now() };
    orders.push(o);
    return send(res, 200, o);
  }

  // 接单: POST /api/orders/:id/claim  —— 凭 token，接单者即操作者
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "claim") {
    const a = actor(req, body); if (!a) return unauth(res);
    const o = orders.find((x) => x.id === +parts[2]);
    if (!o) return send(res, 404, { error: "not found" });
    if (o.status !== "open") return send(res, 409, { error: "订单已被接走或已结束" });
    if (o.posterId === a.id) return send(res, 400, { error: "不能接自己的单" });
    o.status = "claimed"; o.workerId = a.id; o.workerName = a.name;
    a.status = "working"; a.lastSeen = now();
    return send(res, 200, o);
  }

  // 交付: POST /api/orders/:id/submit {result}  —— 凭 token，须为接单方
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "submit") {
    const a = actor(req, body); if (!a) return unauth(res);
    const o = orders.find((x) => x.id === +parts[2]);
    if (!o) return send(res, 404, { error: "not found" });
    if (o.workerId !== a.id) return send(res, 403, { error: "不是接单方" });
    if (o.status !== "claimed") return send(res, 409, { error: "状态不允许交付" });
    o.status = "submitted"; o.result = body.result || "(无内容)";
    a.status = "idle";
    return send(res, 200, o);
  }

  // 确认付款: POST /api/orders/:id/confirm  —— 凭 token，须为挂单方
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "confirm") {
    const me = actor(req, body); if (!me) return unauth(res);
    const o = orders.find((x) => x.id === +parts[2]);
    if (!o) return send(res, 404, { error: "not found" });
    if (o.posterId !== me.id) return send(res, 403, { error: "不是挂单方" });
    if (o.status !== "submitted") return send(res, 409, { error: "无待确认的交付" });
    const worker = agents.get(o.workerId);
    if (worker) { worker.balance += o.bounty; worker.completed += 1; } // 释放托管→接单方
    o.status = "done";
    return send(res, 200, o);
  }

  // 退回(可选): POST /api/orders/:id/reject  —— 凭 token，须为挂单方
  if (req.method === "POST" && parts[1] === "orders" && parts[3] === "reject") {
    const me = actor(req, body); if (!me) return unauth(res);
    const o = orders.find((x) => x.id === +parts[2]);
    if (!o) return send(res, 404, { error: "not found" });
    if (o.posterId !== me.id) return send(res, 403, { error: "不是挂单方" });
    o.status = "open"; o.workerId = null; o.workerName = null; o.result = null;
    return send(res, 200, o);
  }

  // 删除订单(含任务内容/交付物): DELETE /api/orders/:id  —— 凭 token，须为挂单方
  if (req.method === "DELETE" && parts[1] === "orders" && parts[2] && !parts[3]) {
    const me = actor(req, body); if (!me) return unauth(res);
    const idx = orders.findIndex((x) => x.id === +parts[2]);
    if (idx < 0) return send(res, 404, { error: "not found" });
    const o = orders[idx];
    if (o.posterId !== me.id) return send(res, 403, { error: "不是挂单方" });
    // 进行中(已接/已交付待确认)不许删，以免接单方白做
    if (o.status === "claimed" || o.status === "submitted")
      return send(res, 409, { error: "订单进行中，不能删除（先 confirm 或 reject）" });
    if (o.status === "open") { const p = agents.get(o.posterId); if (p) p.balance += o.bounty; } // 退还托管
    orders.splice(idx, 1); // 彻底删除，任务说明与交付物一并清除
    return send(res, 200, { ok: true, deleted: o.id });
  }

  return send(res, 404, { error: "unknown route" });
}

// ---------- 静态面板 ----------
function serveStatic(res) {
  const file = path.join(__dirname, "panel.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("panel.html not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

// ---------- 数据保留期：定期清除已结束的旧订单（连同任务说明/交付物） ----------
setInterval(() => {
  const cutoff = now() - RETENTION_MS;
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    if (["done", "rejected", "expired"].includes(o.status) && o.createdAt < cutoff) { orders.splice(i, 1); dirty = true; }
  }
}, SWEEP_MS).unref();

// ---------- 持久化：每 3s 落盘有改动的数据；退出时强制保存 ----------
setInterval(() => { if (dirty) { saveData(); dirty = false; } }, 3000).unref();
["SIGINT", "SIGTERM"].forEach((sig) =>
  process.on(sig, () => { saveData(); console.log("\n已保存数据，退出。"); process.exit(0); }));

// ---------- 请求处理（http/https 共用） ----------
function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { // CORS 预检
    res.writeHead(204, { "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,x-plaza-token" });
    return res.end();
  }
  if (url.pathname.startsWith("/api/")) return api(req, res, url);
  return serveStatic(res); // 其余都返回面板
}

// ---------- 启动：有证书走 HTTPS，否则 HTTP ----------
const KEY = process.env.PLAZA_TLS_KEY, CERT = process.env.PLAZA_TLS_CERT;
if (KEY && CERT && fs.existsSync(KEY) && fs.existsSync(CERT)) {
  https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, handler)
    .listen(PORT, () => console.log(`接单广场 (HTTPS) → https://localhost:${PORT}`));
} else {
  http.createServer(handler)
    .listen(PORT, () => console.log(`接单广场 (HTTP) → http://localhost:${PORT}`
      + (KEY || CERT ? "  [证书路径无效，已回退 HTTP]" : "  [未配证书；上公网请配 TLS]")));
}
