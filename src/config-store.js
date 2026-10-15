const MAX_HISTORY = 6;

// 保存先フォルダの設定・履歴は利用者(サインインセッション)ごとに独立させるため、
// express-sessionのセッションオブジェクトに直接読み書きする。セッション自体は
// FileSessionStore(src/session-store.js)によりdata/sessions.jsonへ永続化されるため、
// サーバー再起動を挟んでも利用者ごとの設定は保持される。

// null => 自分のOneDrive直下 (ONEDRIVE_TARGET_FOLDER) を使う
// { driveId, itemId, name } => 指定した共有フォルダ配下 (ONEDRIVE_TARGET_FOLDERはその中の相対パスとして扱う)
function loadTargetFolder(session) {
  return session.targetFolder || null;
}

function saveTargetFolder(session, target) {
  session.targetFolder = target;
}

function clearTargetFolder(session) {
  delete session.targetFolder;
}

// columnMapping: { date, vendor, amount, ... } (SharePointライブラリの列の内部名)。
// 対象が共有フォルダ(SharePointライブラリ)でない場合は何もしない。
function saveColumnMapping(session, columnMapping) {
  const current = loadTargetFolder(session);
  if (!current) return;
  saveTargetFolder(session, { ...current, columnMapping });
}

// 過去に選択した保存先(最大MAX_HISTORY件)を記憶し、ラジオボタンでの素早い切り替えに使う。
// 表示順は選択状況に関わらずフォルダ名の昇順で固定(saveHistory参照)。
// entry: { mode: 'own' } または { mode: 'shared', driveId, itemId, name, columnMapping }
// 各項目には初めて記憶した時刻(registeredAt)を持たせ、満杯時に追い出す項目の判定に使う。
function historyKey(entry) {
  return entry.mode === 'own' ? 'own' : `${entry.driveId}:${entry.itemId}`;
}

function loadHistory(session) {
  return Array.isArray(session.targetFolderHistory) ? session.targetFolderHistory : [];
}

// ラジオボタンでの表示順は選択状況に関わらず、上位フォルダ名を含むフルパスの昇順で
// 固定する(「自分のOneDrive」もこの並びに含める)。fullPathが未取得(未サインイン等)の
// 間はフォルダ名単体でソートし、後から取得できた時点で並びも入れ替わる。
function historySortLabel(entry) {
  return entry.mode === 'own' ? '自分のOneDrive' : entry.fullPath || entry.name || '';
}

// 同一ミリ秒内に続けて登録しても順序が判定できるよう、既存項目より必ず大きい値にする
function nextRegisteredAt(list) {
  const latest = list.reduce((max, e) => Math.max(max, e.registeredAt || 0), 0);
  return Math.max(Date.now(), latest + 1);
}

function saveHistory(session, list) {
  const sorted = list
    .slice(0, MAX_HISTORY)
    .sort((a, b) => historySortLabel(a).localeCompare(historySortLabel(b), 'ja'));
  session.targetFolderHistory = sorted;
  return sorted;
}

// 同じ保存先(mode+driveId+itemId)が既に記憶されていれば、その項目を残したまま
// 内容(columnMappingなど)だけ更新する(registeredAtは最初に記憶した時刻のまま維持)。
// 記憶されていなければ何もしない(新規追加はaddOrReplaceHistoryを使う)。
function recordHistory(session, entry) {
  const list = loadHistory(session);
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx < 0) {
    if (list.length < MAX_HISTORY) {
      list.push({ ...entry, registeredAt: nextRegisteredAt(list) });
      return saveHistory(session, list);
    }
    return list;
  }
  list[idx] = { ...list[idx], ...entry, registeredAt: list[idx].registeredAt };
  return saveHistory(session, list);
}

// 保存先を新しく切り替えるときに使う。既に記憶済みなら内容だけ更新し、
// 新規で空きがあれば追加する。満杯(MAX_HISTORY件)の場合は、登録が最も古い項目
// (registeredAtが最小のもの)を追い出して代わりにentryを記憶する。
// registeredAtを持たない旧形式の項目は最も古いものとして扱う。
function addOrReplaceHistory(session, entry) {
  const list = loadHistory(session);
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry, registeredAt: list[idx].registeredAt };
    return saveHistory(session, list);
  }
  if (list.length >= MAX_HISTORY) {
    let oldestIdx = 0;
    list.forEach((e, i) => {
      if ((e.registeredAt || 0) < (list[oldestIdx].registeredAt || 0)) oldestIdx = i;
    });
    list.splice(oldestIdx, 1);
  }
  list.push({ ...entry, registeredAt: nextRegisteredAt(list) });
  return saveHistory(session, list);
}

module.exports = {
  loadTargetFolder,
  saveTargetFolder,
  clearTargetFolder,
  saveColumnMapping,
  loadHistory,
  recordHistory,
  addOrReplaceHistory,
};
