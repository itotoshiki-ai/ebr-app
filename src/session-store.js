const fs = require('fs');
const path = require('path');
const session = require('express-session');

const STORE_PATH = path.join(__dirname, '..', 'data', 'sessions.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveAll(sessions) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(sessions, null, 2), 'utf8');
}

// express-sessionの標準Storeインターフェースの実装。単一ユーザーで使うローカルツール
// という前提で、外部DBを使わずJSONファイルへ素朴に永続化する。これによりサーバーを
// 再起動してもサインイン状態(セッション)が失われなくなる。
class FileSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const entry = loadAll()[sid];
      if (!entry) return callback(null, null);
      if (entry.expires && new Date(entry.expires).getTime() < Date.now()) {
        return this.destroy(sid, () => callback(null, null));
      }
      callback(null, entry.data);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const sessions = loadAll();
      const expires = (sessionData.cookie && sessionData.cookie.expires) || null;
      sessions[sid] = { data: sessionData, expires };
      saveAll(sessions);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      const sessions = loadAll();
      delete sessions[sid];
      saveAll(sessions);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }
}

module.exports = FileSessionStore;
