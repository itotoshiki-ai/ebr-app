const msal = require('@azure/msal-node');
const { cachePlugin } = require('./msal-cache');

// Files.ReadWrite.All: 自分のOneDrive内のファイルに加えて、他人から共有されたファイル/フォルダへの
// アクセスもカバーするために .All 版を使用する(共有フォルダへの保存に必要)
const SCOPES = ['Files.ReadWrite.All', 'offline_access', 'User.Read'];

let msalClientSingleton = null;

function getMsalClient() {
  if (!msalClientSingleton) {
    const authority = process.env.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com/consumers';
    msalClientSingleton = new msal.ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        authority,
      },
      // リフレッシュトークンを含むキャッシュをファイルに永続化し、サーバー再起動後も
      // acquireTokenSilentでサインイン状態を復元できるようにする
      cache: { cachePlugin },
    });
  }
  return msalClientSingleton;
}

function registerAuthRoutes(app) {
  const msalClient = getMsalClient();
  const redirectUri = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

  app.get('/auth/login', async (req, res) => {
    try {
      const url = await msalClient.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri,
        // ブラウザにMicrosoftのSSOセッションが残っていても毎回アカウント選択画面を表示し、
        // 別アカウントへの切り替えをしやすくする
        prompt: 'select_account',
      });
      res.redirect(url);
    } catch (err) {
      console.error('auth/login error', err);
      res.status(500).send('認証URLの生成に失敗しました: ' + err.message);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const tokenResponse = await msalClient.acquireTokenByCode({
        code: req.query.code,
        scopes: SCOPES,
        redirectUri,
      });
      req.session.account = tokenResponse.account;
      req.session.accessToken = tokenResponse.accessToken;
      req.session.expiresOn = tokenResponse.expiresOn;
      res.redirect('/');
    } catch (err) {
      console.error('auth/callback error', err);
      res.status(500).send('サインインに失敗しました: ' + err.message);
    }
  });

  app.get('/auth/logout', async (req, res) => {
    // アプリ内のトークンキャッシュからも当該アカウントを削除し、
    // 別アカウントへの切り替え後に古い資格情報が使われないようにする
    if (req.session.account) {
      try {
        await msalClient.getTokenCache().removeAccount(req.session.account);
      } catch (err) {
        console.warn('トークンキャッシュからのアカウント削除に失敗しました:', err.message);
      }
    }
    req.session.destroy(() => res.redirect('/'));
  });

  app.get('/api/session', (req, res) => {
    if (req.session.account) {
      res.json({ signedIn: true, username: req.session.account.username });
    } else {
      res.json({ signedIn: false });
    }
  });
}

async function getAccessToken(req) {
  const msalClient = getMsalClient();

  if (!req.session.account) {
    throw new Error('NOT_SIGNED_IN');
  }

  // Refresh silently using the cached account if the token is close to expiring.
  const expiresOn = req.session.expiresOn ? new Date(req.session.expiresOn) : null;
  if (expiresOn && expiresOn.getTime() - Date.now() > 60_000) {
    return req.session.accessToken;
  }

  try {
    const result = await msalClient.acquireTokenSilent({
      account: req.session.account,
      scopes: SCOPES,
    });
    req.session.accessToken = result.accessToken;
    req.session.expiresOn = result.expiresOn;
    return result.accessToken;
  } catch (err) {
    throw new Error('NOT_SIGNED_IN');
  }
}

module.exports = { registerAuthRoutes, getAccessToken };
