import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function sanitizeApiToken(raw) {
  if (raw == null) return "";
  let t = String(raw).replace(/^\uFEFF/, "").trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function resolveUtmifyToken() {
  const keys = ["UTMIFY_API_TOKEN", "UTMIFY_TOKEN", "UTMIFY_X_API_TOKEN"];
  for (const key of keys) {
    const t = sanitizeApiToken(process.env[key]);
    if (t) return { token: t, envKey: key };
  }
  return { token: "", envKey: "" };
}

const app = express();
app.set("strict routing", true);
const PORT = Number(process.env.PORT || 8787);
const API_BASE = (process.env.BRUTALCASH_API_BASE || "https://api.brutalcash.com").replace(/\/$/, "");
const PUBLIC_KEY = process.env.BRUTALCASH_PUBLIC_KEY || "";
const SECRET_KEY = process.env.BRUTALCASH_SECRET_KEY || "";
const UNIT_PRICE_CENTS = Number(process.env.RIFA_UNIT_PRICE_CENTS || 19);

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.warn("[WARN] BRUTALCASH_PUBLIC_KEY/BRUTALCASH_SECRET_KEY não configuradas no .env");
}

const authToken = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`, "utf8").toString("base64");

const utmifyAuth = resolveUtmifyToken();
const UTMIFY_TOKEN = utmifyAuth.token;
const UTMIFY_PLATFORM = String(process.env.UTMIFY_PLATFORM || "BrutalCash").trim() || "BrutalCash";
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const PENDING_FILE = path.join(__dirname, "data", "pending-utmify-orders.json");

/** Evita rajadas na BrutalCash (frontend pode disparar vários poll em paralelo). */
const pixStatusCache = new Map();
const PIX_STATUS_TTL_MS = 15000;
const PIX_STATUS_STALE_MS = 180000;

const STATIC_BASE = "/68premio1";
const corsOrigins = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

app.use(cors({
  origin(origin, cb) {
    if (!origin || corsOrigins.has(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "1mb" }));

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function toCents(amount) {
  if (typeof amount === "string") {
    const value = amount.trim();
    if (!value) throw new Error("amount inválido");
    if (/^\d+$/.test(value)) {
      const integer = Number(value);
      if (!Number.isFinite(integer) || integer <= 0) throw new Error("amount inválido");
      return integer >= 100 ? integer : integer * 100;
    }
    const normalized = value.replace(/[^\d,.]/g, "").replace(/\./g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("amount inválido");
    return Math.round(parsed * 100);
  }
  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("amount inválido");
  if (Number.isInteger(raw) && raw >= 100) return raw;
  return Math.round(raw * 100);
}

function safeToCents(value) {
  try {
    return toCents(value);
  } catch (_) {
    return 0;
  }
}

function extractUtms(rawData = {}) {
  const box = rawData.utms || rawData.trackingParameters || rawData.tracking;
  const pick = (src, key) => {
    const v = src[key];
    if (v === undefined || v === null || v === "") return null;
    return String(v).trim() || null;
  };
  const primary = box && typeof box === "object" ? box : rawData;
  return {
    src: pick(primary, "src"),
    sck: pick(primary, "sck"),
    utm_source: pick(primary, "utm_source"),
    utm_campaign: pick(primary, "utm_campaign"),
    utm_medium: pick(primary, "utm_medium"),
    utm_content: pick(primary, "utm_content"),
    utm_term: pick(primary, "utm_term"),
  };
}

function ensureDataDir() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPendingUtmify() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(PENDING_FILE, "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writePendingUtmify(list) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list), "utf8");
}

function toUtcSql(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} `
    + `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function clientIp(req) {
  const raw = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress || req.ip || "0.0.0.0";
  return raw.replace(/^::ffff:/, "");
}

function phoneForUtmify(digits) {
  const d = onlyDigits(digits);
  if (!d) return null;
  if (d.startsWith("55") && d.length >= 12) return d;
  return `55${d}`;
}

function buildUtmifyPayload({
  orderId,
  status,
  createdAt,
  approvedDate,
  customer,
  lineItems,
  amountCents,
  utms,
}) {
  const gatewayFee = Math.round(amountCents * 0.01);
  const userCommission = Math.max(1, amountCents - gatewayFee);
  const ut = utms || {};
  let products = (lineItems || []).filter((it) => it && typeof it === "object").map((it, i) => {
    const qty = Number(it.quantity || 1) || 1;
    const unit = Math.round(Number(it.unit_price || 0));
    return {
      id: String(it.external_ref || it.externalRef || `line-${i}`),
      name: String(it.title || it.name || "Produto"),
      planId: null,
      planName: null,
      quantity: qty,
      priceInCents: Math.max(0, unit * qty),
    };
  }).filter((p) => p.priceInCents > 0);

  if (!products.length) {
    products = [{
      id: "pedido",
      name: "Pedido",
      planId: null,
      planName: null,
      quantity: 1,
      priceInCents: amountCents,
    }];
  }

  const payload = {
    orderId: String(orderId),
    platform: UTMIFY_PLATFORM,
    paymentMethod: "pix",
    status,
    createdAt,
    approvedDate: approvedDate ?? null,
    refundedAt: null,
    customer: {
      name: customer.name,
      email: customer.email,
      phone: phoneForUtmify(customer.phone),
      document: customer.document ? String(customer.document) : null,
      country: "BR",
      ip: customer.ip || "0.0.0.0",
    },
    products,
    trackingParameters: {
      src: ut.src ?? null,
      sck: ut.sck ?? null,
      utm_source: ut.utm_source ?? null,
      utm_campaign: ut.utm_campaign ?? null,
      utm_medium: ut.utm_medium ?? null,
      utm_content: ut.utm_content ?? null,
      utm_term: ut.utm_term ?? null,
    },
    commission: {
      totalPriceInCents: amountCents,
      gatewayFeeInCents: gatewayFee,
      userCommissionInCents: userCommission,
    },
  };

  if (process.env.UTMIFY_IS_TEST === "true") payload.isTest = true;

  return payload;
}

async function sendUtmify(payload) {
  if (!UTMIFY_TOKEN) return false;
  try {
    const response = await axios.post(UTMIFY_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-api-token": UTMIFY_TOKEN,
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300) {
      console.log(`[Utmify] OK orderId=${payload.orderId} status=${payload.status}`);
      return true;
    }
    const body = response.data;
    const msg = body && typeof body === "object" ? body.message : "";
    console.error("[Utmify] HTTP", response.status, JSON.stringify(body));
    if (response.status === 404 && String(msg).includes("API_CREDENTIAL")) {
      console.error(
        "[Utmify] Credencial não encontrada na Utmify. Confira: Integrações → Webhooks → Credenciais de API → criar/copiar token. "
        + "No .env use UTMIFY_API_TOKEN (ou UTMIFY_TOKEN), sem aspas nem espaços extras. "
        + `Token atual: ${UTMIFY_TOKEN.length} caracteres (variável: ${utmifyAuth.envKey || "nenhuma"}).`,
      );
    }
    return false;
  } catch (error) {
    console.error("[Utmify] Falha:", error.message);
    return false;
  }
}

async function finalizeUtmifyPaid(transactionId, approvedDateUtcSql) {
  if (!UTMIFY_TOKEN) return;
  const pending = readPendingUtmify();
  const idx = pending.findIndex((p) => String(p.transactionId) === String(transactionId));
  if (idx === -1) return;
  const row = pending[idx];
  pending.splice(idx, 1);
  writePendingUtmify(pending);

  const approvedDate = approvedDateUtcSql || toUtcSql(new Date());
  const paidPayload = { ...row.utmPayload, status: "paid", approvedDate };
  const ok = await sendUtmify(paidPayload);
  if (!ok) {
    pending.splice(idx, 0, row);
    writePendingUtmify(pending);
    console.warn(`[Utmify] paid não aceito para ${transactionId}; pedido recolocado na fila`);
    return;
  }
  console.log(`[Utmify] Pedido ${transactionId} atualizado para paid`);
}

function normalizePixRequest(rawData = {}) {
  const normalized = {
    name: String(rawData.name || rawData.nome || rawData.nomeCompleto || rawData.customerName || rawData.customer_name || "").trim(),
    email: String(rawData.email || rawData.emailCliente || rawData.customerEmail || "").trim(),
    cpf: onlyDigits(rawData.cpf || rawData.document || rawData.documentNumber || rawData.cpfCliente || ""),
    phone: onlyDigits(rawData.phone || rawData.telefone || rawData.celular || rawData.phoneNumber || ""),
    amount: safeToCents(rawData.amount || rawData.amountTotal || rawData.total || rawData.valor || rawData.price || 0),
    productTitle: String(rawData.productTitle || rawData.title || rawData.produto || "100 Números").trim(),
    quantity: Number(rawData.quantity || rawData.quantidade || rawData.numbers || 1) || 1,
    numbers: Number(rawData.numbers || rawData.quantity || rawData.quantidade || 1) || 1,
    hasUpsell: Boolean(rawData.hasUpsell),
    upsellTitle: String(rawData.upsellTitle || "+50 números"),
    upsellAmount: safeToCents(rawData.upsellAmount || 0),
    upsellQuantity: Number(rawData.upsellQuantity || 50) || 50,
    items: Array.isArray(rawData.items) ? rawData.items : (Array.isArray(rawData.cartItems) ? rawData.cartItems : (Array.isArray(rawData.carrinho) ? rawData.carrinho : [])),
    utms: extractUtms(rawData),
  };
  return normalized;
}

const normalizeCheckoutData = normalizePixRequest;

function normalizeItems(normalizedData) {
  let items = (normalizedData.items || []).filter((it) => it && typeof it === "object").map((it) => {
    const numbers = Number(it.numbers || 0) || 0;
    const unitPrice = numbers > 0 ? numbers * UNIT_PRICE_CENTS : safeToCents(it.unit_price || it.amount || it.price || normalizedData.amount);
    return {
      title: String(it.title || "Produto"),
      unit_price: unitPrice,
      quantity: Number(it.quantity || 1) || 1,
      tangible: false,
      external_ref: it.external_ref || "produto-rifa",
      numbers,
    };
  }).filter((it) => it.unit_price > 0);

  if (!items.length) {
    const numbers = normalizedData.quantity || normalizedData.numbers || 0;
    items = [{
      title: normalizedData.productTitle || "100 Números",
      unit_price: numbers > 0 ? numbers * UNIT_PRICE_CENTS : normalizedData.amount,
      quantity: 1,
      tangible: false,
      external_ref: "produto-base",
      numbers,
    }];
    if (normalizedData.hasUpsell && normalizedData.upsellAmount > 0) {
      items.push({
        title: normalizedData.upsellTitle || "+50 números",
        unit_price: normalizedData.upsellAmount,
        quantity: 1,
        tangible: false,
        external_ref: "adicional-50-numeros",
        numbers: normalizedData.upsellQuantity || 50,
      });
    }
  }

  return items;
}

function pickObj(root, pathSpec) {
  let current = root;
  for (const key of pathSpec) {
    if (current == null) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      current = current[key];
    }
  }
  return current;
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function extractPixData(responseData) {
  const n0 = responseData;
  const n1 = pickObj(responseData, ["data"]);
  const n2 = pickObj(responseData, ["data", "data"]);
  const n3 = pickObj(responseData, ["data", "data", 0]);
  const n4 = pickObj(responseData, ["data", 0]);

  const pixCandidates = [
    pickObj(n0, ["pix"]),
    pickObj(n1, ["pix"]),
    pickObj(n2, [0, "pix"]),
    pickObj(n2, ["pix"]),
    pickObj(n3, ["pix"]),
    pickObj(n3, ["pix", 0]),
    pickObj(n4, ["pix"]),
    pickObj(n4, ["pix", 0]),
    pickObj(n0, ["data", 0, "pix", 0]),
  ];

  const pixNode = pixCandidates.find((p) => p && typeof p === "object") || {};

  const transactionId = firstDefined(
    pickObj(n0, ["id"]),
    pickObj(n1, ["id"]),
    pickObj(n2, ["id"]),
    pickObj(n3, ["id"]),
    pickObj(n0, ["transactionId"]),
    pickObj(n1, ["transactionId"]),
  );

  const status = firstDefined(
    pickObj(n0, ["status"]),
    pickObj(n1, ["status"]),
    pickObj(n2, ["status"]),
    pickObj(n3, ["status"]),
  );

  const pixCode = firstDefined(
    pixNode.qr_code,
    pixNode.qrcode,
    pixNode.qrCode,
    pixNode.copy_paste,
    pixNode.copyPaste,
    pixNode.emv,
    pixNode.payload,
    pixNode.code,
    pixNode.url,
  );

  const pixQrCode = firstDefined(
    pixNode.qr_code,
    pixNode.qrcode,
    pixNode.qrCode,
    pixNode.qr_image,
    pixNode.qrImage,
    pixNode.image,
    pixNode.base64,
    pixNode.url,
  );

  const pixUrl = firstDefined(
    pixNode.url,
    pixNode.pix_url,
    pixNode.pixUrl,
  );

  return { transactionId, status, pixCode, pixQrCode, pixUrl };
}

function brutalClient() {
  return axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    headers: {
      Authorization: `Basic ${authToken}`,
      "Content-Type": "application/json",
    },
  });
}

app.get("/api/health", (_req, res) => {
  return res.json({ success: true, message: "Backend Pix rodando" });
});

app.post("/api/webhook-brutalcash", (req, res) => {
  const body = req.body || {};
  const id = firstDefined(body.Id, body.id, body.transaction_id, body.transactionId);
  const statusRaw = firstDefined(body.Status, body.status);
  const status = String(statusRaw || "").toUpperCase();
  const paidAt = firstDefined(body.PaidAt, body.paid_at, body.paidAt, body.approved_at, body.approvedAt);

  if (status === "PAID" && id) {
    const approvedDate = paidAt ? toUtcSql(new Date(paidAt)) : toUtcSql(new Date());
    finalizeUtmifyPaid(String(id), approvedDate).catch(() => {});
  }

  return res.status(200).send("OK");
});

app.post("/api/pix/create", async (req, res) => {
  try {
    const normalizedData = normalizePixRequest(req.body || {});
    const cleanCpf = normalizedData.cpf;
    const cleanPhone = normalizedData.phone;
    const missingFields = [];

    if (!normalizedData.name) missingFields.push("name");
    if (!normalizedData.email) missingFields.push("email");
    if (!cleanCpf || cleanCpf.length < 11) missingFields.push("cpf");
    if (!cleanPhone || cleanPhone.length < 10) missingFields.push("phone");
    if (!normalizedData.amount || normalizedData.amount <= 0) missingFields.push("amount");

    console.log("=== DEBUG /api/pix/create ===");
    console.log("Body bruto recebido:", req.body);
    console.log("Body normalizado:", normalizedData);
    console.log("Campos faltando:", missingFields);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Dados inválidos para gerar Pix.",
        missingFields,
        received: {
          name: normalizedData.name,
          email: normalizedData.email,
          cpf: normalizedData.cpf,
          phone: normalizedData.phone,
          amount: normalizedData.amount,
          productTitle: normalizedData.productTitle,
          quantity: normalizedData.quantity,
          items: normalizedData.items,
        },
        rawBody: req.body,
      });
    }

    const items = normalizeItems(normalizedData);
    const totalItems = items.reduce((acc, item) => acc + (item.unit_price * (item.quantity || 1)), 0);
    const amountCents = totalItems > 0 ? totalItems : normalizedData.amount;

    const payload = {
      amount: amountCents,
      payment_method: "pix",
      customer: {
        name: normalizedData.name,
        email: normalizedData.email,
        document: {
          number: cleanCpf,
          type: "cpf",
        },
        phone: cleanPhone,
      },
      items: items.map((item) => ({
        title: item.title,
        unit_price: item.unit_price,
        quantity: item.quantity,
        tangible: false,
        external_ref: item.external_ref,
      })),
      pix: {
        expires_in_days: 1,
      },
      postback_url: process.env.BRUTALCASH_POSTBACK_URL,
      metadata: {
        productTitle: normalizedData.productTitle,
        quantity: normalizedData.quantity,
        hasUpsell: normalizedData.hasUpsell,
        upsellTitle: normalizedData.upsellTitle,
        upsellAmount: normalizedData.upsellAmount,
        upsellQuantity: normalizedData.upsellQuantity,
        items,
      },
      ip: clientIp(req),
    };

    console.log("Payload recebido do frontend:", req.body);
    console.log("Payload normalizado:", normalizedData);
    console.log("Items enviados:", items);
    console.log("Soma dos items:", totalItems);
    console.log("Payload enviado para BrutalCash:", payload);

    const client = brutalClient();
    const response = await client.post("/v1/payment-transaction/create", payload);
    console.log("Status BrutalCash:", response.status);
    console.log("Resposta BrutalCash completa:", JSON.stringify(response.data, null, 2));

    const parsed = extractPixData(response.data);

    if (!parsed.pixCode && !parsed.pixQrCode && !parsed.pixUrl) {
      console.error("[BrutalCash] Resposta sem dados de PIX", response.data);
      return res.status(200).json({
        success: false,
        message: "Transação criada, mas a API não retornou QR Code ou Pix copia e cola.",
        raw: response.data,
      });
    }

    const txId = String(parsed.transactionId || "").trim();
    if (txId && UTMIFY_TOKEN) {
      const createdAt = toUtcSql(new Date());
      const utmPayload = buildUtmifyPayload({
        orderId: txId,
        status: "waiting_payment",
        createdAt,
        approvedDate: null,
        customer: {
          name: normalizedData.name,
          email: normalizedData.email,
          phone: cleanPhone,
          document: cleanCpf,
          ip: clientIp(req),
        },
        lineItems: items.map((it) => ({
          title: it.title,
          unit_price: it.unit_price,
          quantity: it.quantity || 1,
          external_ref: it.external_ref,
        })),
        amountCents,
        utms: normalizedData.utms,
      });
      await sendUtmify(utmPayload);
      const pending = readPendingUtmify();
      pending.push({ transactionId: txId, createdAt, utmPayload });
      writePendingUtmify(pending);
    }

    return res.json({
      success: true,
      transactionId: String(parsed.transactionId || ""),
      status: String(parsed.status || "PENDING").toUpperCase(),
      amount: amountCents,
      pixCode: parsed.pixCode || "",
      pixQrCode: parsed.pixQrCode || "",
      pixUrl: parsed.pixUrl || "",
    });
  } catch (error) {
    console.error("Erro BrutalCash status:", error.response?.status);
    console.error("Erro BrutalCash data:", error.response?.data);
    console.error("Erro BrutalCash message:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erro ao gerar Pix na BrutalCash",
      debug: {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      },
    });
  }
});

app.get("/api/pix/status/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ success: false, message: "ID inválido." });

  const now = Date.now();
  const cached = pixStatusCache.get(id);
  if (cached && now - cached.at < PIX_STATUS_TTL_MS) {
    const st = cached.status;
    if (st === "PAID") finalizeUtmifyPaid(id).catch(() => {});
    return res.json({ success: true, status: st, cached: true });
  }

  try {
    const client = brutalClient();
    const response = await client.get(`/v1/payment-transaction/info/${encodeURIComponent(id)}`);

    const status = firstDefined(
      response.data?.status,
      response.data?.data?.status,
      response.data?.data?.[0]?.status,
      response.data?.data?.data?.[0]?.status,
      "PENDING",
    );

    const st = String(status).toUpperCase();
    pixStatusCache.set(id, { at: now, status: st });
    if (st === "PAID") finalizeUtmifyPaid(id).catch(() => {});

    return res.json({ success: true, status: st });
  } catch (error) {
    const httpStatus = error.response?.status;
    console.error("[api/pix/status] erro", {
      message: error.message,
      status: httpStatus,
      data: error.response?.data,
    });

    if (httpStatus === 429 && cached && now - cached.at < PIX_STATUS_STALE_MS) {
      const st = cached.status;
      if (st === "PAID") finalizeUtmifyPaid(id).catch(() => {});
      return res.json({ success: true, status: st, stale: true, rateLimited: true });
    }

    if (httpStatus === 429) {
      return res.json({
        success: true,
        status: "PENDING",
        rateLimited: true,
        message: "Consulta temporariamente limitada; tente novamente em instantes.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Erro ao consultar status do pagamento.",
    });
  }
});

function sendCheckoutHtml(res) {
  res.sendFile(path.join(__dirname, "index.html"));
}

app.use(`${STATIC_BASE}/_nuxt`, express.static(path.join(__dirname, "_nuxt")));
app.use(`${STATIC_BASE}/_i18n`, express.static(path.join(__dirname, "_i18n")));
app.use(`${STATIC_BASE}/images`, express.static(path.join(__dirname, "images")));

app.get("/", (_req, res) => res.redirect(302, `${STATIC_BASE}/`));
app.get(`${STATIC_BASE}`, (_req, res) => res.redirect(302, `${STATIC_BASE}/`));
app.get(`${STATIC_BASE}/`, (_req, res) => sendCheckoutHtml(res));
app.get(`${STATIC_BASE}/index.html`, (_req, res) => sendCheckoutHtml(res));
app.get("/pix-brutalcash.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "pix-brutalcash.html"));
});

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const p = req.path;
  if (!p.startsWith(`${STATIC_BASE}/`)) return next();
  if (p === `${STATIC_BASE}/` || p === `${STATIC_BASE}/index.html`) return next();
  if (path.extname(p)) return next();
  return sendCheckoutHtml(res);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`App em http://127.0.0.1:${PORT}${STATIC_BASE}/ (checkout + API /api/*)`);
  if (UTMIFY_TOKEN) {
    console.log(
      `[Utmify] Ativo (${utmifyAuth.envKey}, ${UTMIFY_TOKEN.length} chars) — pedidos Pix serão enviados (waiting_payment + paid)`,
    );
    if (!process.env.BRUTALCASH_POSTBACK_URL) {
      console.warn("[Utmify] BRUTALCASH_POSTBACK_URL não definido — configure .../api/webhook-brutalcash para confirmação via webhook; paid também tenta via /api/pix/status");
    }
  } else {
    console.warn("[Utmify] Defina UTMIFY_API_TOKEN ou UTMIFY_TOKEN no .env — integração desligada");
  }
});
