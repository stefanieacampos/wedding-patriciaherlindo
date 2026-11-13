/**
 * Cloud Functions — Site de Casamento
 *
 * Funções:
 *   createPreference  — Callable: cria preferência de pagamento no Mercado Pago
 *   mpWebhook         — HTTP: recebe notificações do MP e salva no Firestore
 *   setAdminClaim     — Auth trigger (beforeCreate): define admin=true para o e-mail configurado
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { beforeUserCreated } = require("firebase-functions/v2/identity");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const axios = require("axios");

initializeApp();
const db = getFirestore();

// ── Secrets ────────────────────────────────────────────────────────────────
const MP_ACCESS_TOKEN   = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const ADMIN_EMAIL       = defineSecret("ADMIN_EMAIL");

// ══════════════════════════════════════════════════════════════════════════
// 1. createPreference — Callable (autenticação não obrigatória no lado cliente,
//    mas somente o nosso domínio pode chamar via SDK)
// ══════════════════════════════════════════════════════════════════════════
exports.createPreference = onCall(
  {
    secrets: [MP_ACCESS_TOKEN],
    // Restringe chamadas ao nosso domínio — ajuste para o seu Firebase Hosting URL
    // cors: ["https://SEU_PROJETO.web.app", "https://wedding-patriciaherlindo.web.app"],
  },
  async (request) => {
    const { amount, name, message } = request.data;

    // Validações básicas
    if (!amount || typeof amount !== "number" || amount <= 0 || amount > 50000) {
      throw new HttpsError("invalid-argument", "Valor inválido.");
    }
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      throw new HttpsError("invalid-argument", "Nome inválido.");
    }

    const token = MP_ACCESS_TOKEN.value();

    try {
      const response = await axios.post(
        "https://api.mercadopago.com/checkout/preferences",
        {
          items: [
            {
              id: "presente-casamento",
              title: "Presente de Casamento",
              description: `Presente de ${name.trim()}`,
              quantity: 1,
              currency_id: "BRL",
              unit_price: amount,
            },
          ],
          payer: {
            name: name.trim(),
          },
          metadata: {
            gifter_name: name.trim(),
            gifter_message: (message || "").slice(0, 500),
          },
          back_urls: {
            success: "https://wedding-patriciaherlindo.web.app/?pagamento=sucesso",
            failure: "https://wedding-patriciaherlindo.web.app/?pagamento=erro",
            pending: "https://wedding-patriciaherlindo.web.app/?pagamento=pendente",
          },
          auto_return: "approved",
          notification_url: "https://SEU_REGIAO-SEU_PROJETO.cloudfunctions.net/mpWebhook",
          statement_descriptor: "CASAMENTO",
          payment_methods: {
            excluded_payment_types: [],
            installments: 1,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      return {
        id: response.data.id,
        init_point: response.data.init_point,
      };
    } catch (err) {
      console.error("Erro ao criar preferência MP:", err?.response?.data || err.message);
      throw new HttpsError("internal", "Não foi possível criar a preferência de pagamento.");
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// 2. mpWebhook — HTTP (recebe notificações do Mercado Pago)
// ══════════════════════════════════════════════════════════════════════════
exports.mpWebhook = onRequest(
  {
    secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // ── Verificação de assinatura HMAC-SHA256 ──────────────────────────
    const secret = MP_WEBHOOK_SECRET.value();
    const sigHeader = req.headers["x-signature"] || "";
    const requestId = req.headers["x-request-id"] || "";

    const queryId = req.query?.["data.id"] || req.body?.data?.id || "";

    // Monta o manifesto para verificação
    const manifest = `id:${queryId};request-id:${requestId};ts:${extractTs(sigHeader)};`;
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(manifest)
      .digest("hex");

    const receivedSig = extractSigV1(sigHeader);

    if (!receivedSig || receivedSig !== expectedSig) {
      console.warn("Webhook: assinatura inválida", { sigHeader, manifest, expectedSig });
      return res.status(401).send("Unauthorized");
    }

    // ── Processa o evento ──────────────────────────────────────────────
    const topic = req.query.topic || req.body?.type;
    const dataId = queryId;

    if (!dataId || (topic !== "payment" && topic !== "payment_intent")) {
      return res.status(200).send("OK — evento ignorado");
    }

    try {
      const token = MP_ACCESS_TOKEN.value();
      const paymentRes = await axios.get(
        `https://api.mercadopago.com/v1/payments/${dataId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const p = paymentRes.data;
      const meta = p.metadata || {};

      await db.collection("payments").doc(String(p.id)).set({
        mpId: p.id,
        status: p.status,
        statusDetail: p.status_detail,
        amount: p.transaction_amount,
        currency: p.currency_id,
        gifterName: meta.gifter_name || p.payer?.first_name || "",
        gifterMessage: meta.gifter_message || "",
        paymentMethod: p.payment_type_id,
        createdAt: p.date_created,
        updatedAt: p.date_last_updated,
        raw: p,
        recordedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`Pagamento ${p.id} salvo com status ${p.status}`);
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Erro ao processar webhook:", err?.response?.data || err.message);
      return res.status(500).send("Internal Error");
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════
// 3. setAdminClaim — Trigger beforeCreate (Firebase Auth)
//    Define custom claim admin=true para o e-mail configurado como admin
// ══════════════════════════════════════════════════════════════════════════
exports.setAdminClaim = beforeUserCreated(
  { secrets: [ADMIN_EMAIL] },
  async (event) => {
    const adminEmail = ADMIN_EMAIL.value().trim().toLowerCase();
    const userEmail  = (event.data?.email || "").trim().toLowerCase();

    if (userEmail === adminEmail) {
      return {
        customClaims: { admin: true },
      };
    }
    // Não retornar nada = usuário criado sem claims especiais
    return {};
  }
);

// ── Helpers ────────────────────────────────────────────────────────────────

function extractTs(sigHeader) {
  // x-signature: ts=<timestamp>,v1=<hash>
  const match = sigHeader.match(/ts=(\d+)/);
  return match ? match[1] : "";
}

function extractSigV1(sigHeader) {
  const match = sigHeader.match(/v1=([a-f0-9]+)/);
  return match ? match[1] : "";
}
