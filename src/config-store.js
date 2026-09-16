const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'target-folder.json');

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

module.exports = { loadTargetFolder, saveTargetFolder, clearTargetFolder, saveColumnMapping };
