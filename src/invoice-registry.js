// 国税庁「適格請求書発行事業者公表システム」のWeb-API機能で、登録番号(T+13桁)から
// 適格請求書発行事業者の「氏名又は名称」を取得する。
// 利用にはアプリケーションID(国税庁に届け出て発行を受ける)が必要で、.envのINVOICE_API_APP_IDが
// 未設定の場合は照会しない(OCRで推定した取引先をそのまま使う)。
// 利用規約により、このWeb-APIで取得した情報を使うサービスには出典の表示が必要(画面下部に表示している)。

const fs = require('fs');
const path = require('path');

// 公表情報を取得した利用者を把握するための照会記録(1行1件のJSON。日時・利用者・登録番号・取得した名称)
const LOOKUP_LOG_PATH = path.join(__dirname, '..', 'data', 'invoice-lookup-log.jsonl');

const INVOICE_API_ENDPOINT ='https://web-api.invoice-kohyo.nta.go.jp/1/num';
// 1回のリクエストで指定できる登録番号の最大件数(Web-APIの仕様)
const MAX_NUMBERS_PER_REQUEST = 10;
const REQUEST_TIMEOUT_MS = 5000;
// 事業者処理区分: 01 新規登録 / 02 公表内容の変更 のみ有効(03 失効 / 04 取消 は使わない)
const ACTIVE_PROCESS_CODES = ['01', '02'];

function isInvoiceLookupEnabled() {
  return Boolean(process.env.INVOICE_API_APP_ID);
}

// 登録番号(T+13桁)を出現順・重複なしで取り出す。OCRが「T 3100001002833」「T-3100001002833」のように
// Tの後に空白やハイフンを入れることがあるため許容する(改行をまたいだ数字は別の番号の可能性があるため連結しない)
function findRegistrationNumbers(text) {
  const numbers = [...text.matchAll(/(?<![A-Za-z0-9])[TＴ][ \-]?(\d{13})(?!\d)/g)].map((m) => `T${m[1]}`);
  return [...new Set(numbers)];
}

// 登録番号の一覧を照会し、{ 登録番号: 氏名又は名称 } を返す(登録が有効な最新情報のみ)。
// Web-APIのエラーや通信障害の場合は空のオブジェクトを返し、取込処理は止めない。
async function lookupRegisteredNames(numbers) {
  const appId = process.env.INVOICE_API_APP_ID;
  if (!appId || numbers.length === 0) return {};

  const url = new URL(INVOICE_API_ENDPOINT);
  url.searchParams.set('id', appId);
  url.searchParams.set('number', numbers.slice(0, MAX_NUMBERS_PER_REQUEST).join(','));
  url.searchParams.set('type', '21'); // JSON形式
  url.searchParams.set('history', '0'); // 履歴情報なし(最新情報のみ)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      // アプリケーションIDをログに出さないよう、URLは出力しない
      console.warn(`インボイスWeb-APIの照会に失敗しました (HTTP ${res.status})`);
      return {};
    }
    const json = await res.json();
    const names = {};
    for (const a of json.announcement || []) {
      if (a.latest !== '1' || !ACTIVE_PROCESS_CODES.includes(a.process) || !a.name) continue;
      names[a.registratedNumber] = a.name;
    }
    return names;
  } catch (err) {
    console.warn('インボイスWeb-APIの照会に失敗しました', err.name === 'TimeoutError' ? 'タイムアウト' : err.message);
    return {};
  }
}

// 照会で取得した名称を誰に表示したかを記録する。記録に失敗しても取込処理は止めない
function recordLookup({ username, registrationNumber, name }) {
  const entry = { at: new Date().toISOString(), username, registrationNumber, name };
  try {
    fs.mkdirSync(path.dirname(LOOKUP_LOG_PATH), { recursive: true });
    fs.appendFileSync(LOOKUP_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('登録番号の照会記録を書き込めませんでした', err.message);
  }
}

module.exports = { isInvoiceLookupEnabled, findRegistrationNumbers, lookupRegisteredNames, recordLookup };
