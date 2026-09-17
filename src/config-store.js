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

function saveHistory(session, list) {
  const sorted = list
    .slice(0, MAX_HISTORY)
    .sort((a, b) => historySortLabel(a).localeCompare(historySortLabel(b), 'ja'));
  session.targetFolderHistory = sorted;
  return sorted;
}

// 同じ保存先(mode+driveId+itemId)が既に記憶されていれば、その項目を残したまま
// 内容(columnMappingなど)だけ更新して先頭に繰り上げる。新規かつ空きがあれば先頭に追加する。
// 新規かつMAX_HISTORY件で満杯の場合は、追い出す項目を決められないので何もしない
// (呼び出し側でどれと入れ替えるか分かっている場合はaddOrReplaceHistoryを使う)。
function recordHistory(session, entry) {
  const list = loadHistory(session);
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx >= 0) {
    const merged = { ...list[idx], ...entry };
    list.splice(idx, 1);
    list.unshift(merged);
    return saveHistory(session, list);
  }
  if (list.length < MAX_HISTORY) {
    list.unshift(entry);
    return saveHistory(session, list);
  }
  return list;
}

// 保存先を新しく切り替えるときに使う。履歴に空きがあれば単に追加するが、
// 満杯(MAX_HISTORY件)の場合は「切り替える直前まで選択されていた保存先」(previousEntry)を
// 追い出して代わりにentryを記憶する。ユーザーがどのフォルダから別のフォルダへ切り替えたかで
// 入れ替え対象が自然に決まるため、追加の確認UIなしで直感的な挙動になる。
function addOrReplaceHistory(session, entry, previousEntry) {
  const list = loadHistory(session);
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx >= 0) {
    const merged = { ...list[idx], ...entry };
    list.splice(idx, 1);
    list.unshift(merged);
    return saveHistory(session, list);
  }
  if (list.length < MAX_HISTORY) {
    list.unshift(entry);
    return saveHistory(session, list);
  }
  const prevKey = previousEntry ? historyKey(previousEntry) : null;
  const prevIdx = prevKey ? list.findIndex((e) => historyKey(e) === prevKey) : -1;
  if (prevIdx >= 0) {
    list.splice(prevIdx, 1);
  } else {
    list.pop(); // 直前の保存先が見つからない場合のフォールバック: いずれか1件を外す(表示順はsaveHistoryで昇順に整列される)
  }
  list.unshift(entry);
  const capped = list.slice(0, MAX_HISTORY);
  return saveHistory(session, capped);
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
