# 🌿 Casamento F & P — Guia de Deploy

## Pré-requisitos
- Node.js 18+
- Firebase CLI: `npm install -g firebase-tools`
- Conta no Mercado Pago (obter Public Key e Access Token)

---

## 1. Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com
2. Clique em **Adicionar projeto** → dê um nome (ex: `casamento-fp`)
3. Ative o **Firestore Database** (modo produção)
4. Ative o **Firebase Authentication** → método **E-mail/senha**
5. Ative o **Firebase Storage**
6. Ative o **Firebase Hosting**

---

## 2. Configurar as credenciais

### No `.firebaserc`
Substitua `SEU_PROJECT_ID_AQUI` pelo seu Project ID real:
```json
{ "projects": { "default": "casamento-fp" } }
```

### No `public/index.html` e `public/admin/index.html`
Vá em **Firebase Console → Configurações do Projeto → Seus apps → </> Web**
Copie o objeto `firebaseConfig` e substitua nas duas linhas marcadas com `COLE_SUA_API_KEY`.

Também substitua `COLE_SUA_PUBLIC_KEY_MP` em `public/index.html`
pela sua **Public Key** do Mercado Pago (começa com `APP_USR-…` ou `TEST-…`).

---

## 3. Configurar os Secrets do Cloud Functions

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
# Cole seu Access Token do Mercado Pago quando pedido

firebase functions:secrets:set MP_WEBHOOK_SECRET
# Cole a chave secreta de webhook do MP (configurada no painel MP)

firebase functions:secrets:set ADMIN_EMAIL
# Cole o e-mail que será o administrador do site (ex: voce@gmail.com)
```

### No `functions/index.js`
Substitua as duas URLs:
- `https://SEU_DOMINIO.com.br` → domínio real (Firebase Hosting ou domínio próprio)
- `https://SEU_REGIAO-SEU_PROJETO.cloudfunctions.net/mpWebhook` → URL da função (obtida após o primeiro deploy)

---

## 4. Criar o usuário admin

```bash
# Faça login no Firebase
firebase login

# Abra o Firebase Console → Authentication → Usuários → Adicionar usuário
# Use o mesmo e-mail configurado em ADMIN_EMAIL
```

O trigger `setAdminClaim` define automaticamente `admin: true` para esse e-mail.
Se o usuário já existia ANTES de você configurar o secret, adicione o claim manualmente:
```bash
# Via Admin SDK ou Firebase CLI (extensão ou script)
node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.auth().getUserByEmail('seu@email.com')
  .then(u => admin.auth().setCustomUserClaims(u.uid, {admin:true}))
  .then(() => console.log('Done'))
"
```

---

## 5. Instalar dependências e fazer deploy

```bash
cd functions
npm install
cd ..

# Primeiro deploy completo
firebase deploy

# Ou separadamente:
firebase deploy --only hosting
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only storage
firebase deploy --only functions
```

---

## 6. Configurar webhook no Mercado Pago

Após o deploy das functions, pegue a URL do webhook:
```
https://REGIAO-SEU_PROJETO.cloudfunctions.net/mpWebhook
```

No painel do Mercado Pago:
- Acesse **Sua conta → Webhooks/IPN**
- Adicione a URL acima
- Selecione eventos: **payment**
- Copie a **chave secreta** gerada e configure como `MP_WEBHOOK_SECRET`

---

## 7. Configurar conteúdo inicial

Acesse `https://SEU_PROJETO.web.app/admin` → faça login → aba **Conteúdo**
e preencha:
- Data do evento
- Horário
- Local
- Chave PIX
- Prazo para RSVP

---

## Estrutura do projeto

```
wedding-ph/
├── firebase.json          # Config do Firebase Hosting, Firestore, Storage, Functions
├── .firebaserc            # Projeto Firebase
├── firestore.rules        # Regras de segurança Firestore
├── firestore.indexes.json # Índices compostos
├── storage.rules          # Regras Firebase Storage
├── functions/
│   ├── package.json       # Dependências Node.js
│   └── index.js           # Cloud Functions (MP, Auth trigger)
└── public/
    ├── index.html         # Site principal (casamento)
    └── admin/
        └── index.html     # Painel administrativo
```

---

## Segurança implementada

✅ **Firebase Auth** com custom claim `admin:true` — sem login/senha hardcoded
✅ **Firestore Rules** — RSVP somente create (campo a campo validado), payments write:false para clientes
✅ **Storage Rules** — upload somente admin, somente imagens, máx 10MB
✅ **Cloud Functions** — Access Token MP nunca exposto ao cliente
✅ **Webhook HMAC-SHA256** — assinatura verificada antes de processar
✅ **CSP separado** — admin sem domínios MP, main site com MP apenas
✅ **Secrets Manager** — tokens fora do código
