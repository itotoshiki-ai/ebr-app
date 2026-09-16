const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'msal-token-cache.json');

// MSAL Nodeのトークンキャッシュ(リフレッシュトークンを含む)をJSONファイルへ永続化する。
// これが無いと、サーバーを再起動するたびにプロセス内メモリのキャッシュが消え、
// acquireTokenSilentが常に失敗して毎回サインインし直しになってしまう。
const cachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    try {
      const data = fs.readFileSync(CACHE_PATH, 'utf8');
      cacheContext.tokenCache.deserialize(data);
    } catch (err) {
      // キャッシュファイルがまだ存在しない(初回サインイン前)場合は何もしない
    }
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, cacheContext.tokenCache.serialize(), 'utf8');
    }
  },
};

module.exports = { cachePlugin };
