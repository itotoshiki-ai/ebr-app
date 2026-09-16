const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'target-folder.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'target-folder-history.json');
const MAX_HISTORY = 4;

// null => 自分のOneDrive直下 (ONEDRIVE_TARGET_FOLDER) を使う
// { driveId, itemId, name } => 指定した共有フォルダ配下 (ONEDRIVE_TARGET_FOLDERはその中の相対パスとして扱う)
function loadTargetFolder() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function saveTargetFolder(target) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(target, null, 2), 'utf8');
}

function clearTargetFolder() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch (err) {
    // 未設定の場合は何もしない
  }
}

// columnMapping: { date, vendor, amount } (SharePointライブラリの列の内部名)。
// 対象が共有フォルダ(SharePointライブラリ)でない場合は何もしない。
function saveColumnMapping(columnMapping) {
  const current = loadTargetFolder();
  if (!current) return;
  saveTargetFolder({ ...current, columnMapping });
}

// 過去に選択した保存先(最大4件)をMRU順で記憶し、ラジオボタンでの素早い切り替えに使う。
// entry: { mode: 'own' } または { mode: 'shared', driveId, itemId, name, columnMapping }
function historyKey(entry) {
  return entry.mode === 'own' ? 'own' : `${entry.driveId}:${entry.itemId}`;
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function saveHistory(list) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list.slice(0, MAX_HISTORY), null, 2), 'utf8');
}

// 同じ保存先(mode+driveId+itemId)が既に記憶されていれば、その項目を残したまま
// 内容(columnMappingなど)だけ更新して先頭に繰り上げる。新規かつ空きがあれば先頭に追加する。
// 新規かつMAX_HISTORY件で満杯の場合は、追い出す項目を決められないので何もしない
// (呼び出し側でどれと入れ替えるか分かっている場合はaddOrReplaceHistoryを使う)。
function recordHistory(entry) {
  const list = loadHistory();
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx >= 0) {
    const merged = { ...list[idx], ...entry };
    list.splice(idx, 1);
    list.unshift(merged);
    saveHistory(list);
    return list;
  }
  if (list.length < MAX_HISTORY) {
    list.unshift(entry);
    saveHistory(list);
    return list;
  }
  return list;
}

// 保存先を新しく切り替えるときに使う。履歴に空きがあれば単に追加するが、
// 満杯(MAX_HISTORY件)の場合は「切り替える直前まで選択されていた保存先」(previousEntry)を
// 追い出して代わりにentryを記憶する。ユーザーがどのフォルダから別のフォルダへ切り替えたかで
// 入れ替え対象が自然に決まるため、追加の確認UIなしで直感的な挙動になる。
function addOrReplaceHistory(entry, previousEntry) {
  const list = loadHistory();
  const key = historyKey(entry);
  const idx = list.findIndex((e) => historyKey(e) === key);
  if (idx >= 0) {
    const merged = { ...list[idx], ...entry };
    list.splice(idx, 1);
    list.unshift(merged);
    saveHistory(list);
    return list;
  }
  if (list.length < MAX_HISTORY) {
    list.unshift(entry);
    saveHistory(list);
    return list;
  }
  const prevKey = previousEntry ? historyKey(previousEntry) : null;
  const prevIdx = prevKey ? list.findIndex((e) => historyKey(e) === prevKey) : -1;
  if (prevIdx >= 0) {
    list.splice(prevIdx, 1);
  } else {
    list.pop(); // 直前の保存先が見つからない場合のフォールバック: 最も古いものを外す
  }
  list.unshift(entry);
  const capped = list.slice(0, MAX_HISTORY);
  saveHistory(capped);
  return capped;
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
