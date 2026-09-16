// Google Cloud Vision API (無料枠: 月1000ユニットまで無料) でOCRし、
// 得られたテキストを正規表現ベースのヒューリスティックで解析して
// 取引日付・取引先名・取引金額を推定する。
// 精度はClaude Vision(旧実装)より劣る可能性がある。抽出結果は必ずユーザーが
// 画面上で確認・修正できるようにすること。

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function assertSupportedMime(mimeType) {
  if (mimeType !== 'application/pdf' && !SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error(`UNSUPPORTED_MIME_TYPE:${mimeType}`);
  }
}

async function callVisionApi(body) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_VISION_API_KEY が設定されていません');
  }

  const isFileRequest = 'inputConfig' in (body.requests?.[0] || {});
  const path = isFileRequest ? 'files:annotate' : 'images:annotate';

  const res = await fetch(`${VISION_ENDPOINT}/${path}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    const message = json?.error?.message || `Vision APIエラー (HTTP ${res.status})`;
    throw new Error(message);
  }
  return json;
}

async function ocrImage(base64Data) {
  const json = await callVisionApi({
    requests: [
      {
        image: { content: base64Data },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      },
    ],
  });

  const response = json.responses?.[0];
  if (response?.error) {
    throw new Error(response.error.message || 'Vision APIがエラーを返しました');
  }
  return response?.fullTextAnnotation?.text || '';
}

async function ocrPdf(base64Data) {
  const json = await callVisionApi({
    requests: [
      {
        inputConfig: { mimeType: 'application/pdf', content: base64Data },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        // 同期リクエストは最大5ページまで(領収書PDFは通常1ページのため十分)
        pages: [1, 2, 3, 4, 5],
      },
    ],
  });

  const fileResponse = json.responses?.[0];
  if (fileResponse?.error) {
    throw new Error(fileResponse.error.message || 'Vision APIがエラーを返しました');
  }
  const pageTexts = (fileResponse?.responses || [])
    .map((r) => r.fullTextAnnotation?.text || '')
    .filter(Boolean);
  return pageTexts.join('\n');
}

const KANJI_DIGITS = '〇一二三四五六七八九';
const ERA_START_YEAR = {
  令和: 2018, // 令和1年 = 2019
  平成: 1988, // 平成1年 = 1989
  昭和: 1925, // 昭和1年 = 1926
};

// 各書式のパターンを文書全体から探し、電話番号や伝票番号がたまたま日付と同じ桁の並びに
// マッチしても月や日の値が不正(13より大きい月など)であれば候補にしない。
// 有効な候補を書式の種類に関係なく文書中での出現位置順に並べ、最も先に出現したものを
// 採用する(以前は「和暦→西暦(漢字)→スラッシュ区切り→年が末尾」という書式の優先順位で
// 選んでいたため、実際には後方にある書式が先に見つかり、文書内で本来先に出てくる
// 日付より優先されてしまうことがあった)。
// 既に採用した候補と範囲が重なる場合は追加しない(同じ文字列を複数の書式で二重に
// 拾わないようにするため。呼び出し順が優先順位になる)。
function collectDateCandidates(text, candidates, pattern, toDate) {
  for (const m of text.matchAll(pattern)) {
    const formatted = toDate(m);
    if (!formatted) continue;
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = candidates.some((c) => start < c.end && end > c.start);
    if (!overlaps) candidates.push({ start, end, date: formatted });
  }
}

function extractDate(text) {
  const candidates = [];

  // 和暦: 令和6年3月1日
  collectDateCandidates(
    text,
    candidates,
    /(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
    ([, eraName, yearStr, month, day]) => {
      const eraYear = yearStr === '元' ? 1 : parseInt(yearStr, 10);
      return formatDate(ERA_START_YEAR[eraName] + eraYear, month, day);
    }
  );

  // 西暦: 2026年3月1日 / 2026年03月01日
  collectDateCandidates(
    text,
    candidates,
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
    ([, year, month, day]) => formatDate(year, month, day)
  );

  // 2026/03/01, 2026-03-01, 2026.03.01
  collectDateCandidates(
    text,
    candidates,
    /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/g,
    ([, year, month, day]) => formatDate(year, month, day)
  );

  // 03/01/2026 のような日本以外でよくある並び順(年が末尾)にも一応対応
  collectDateCandidates(
    text,
    candidates,
    /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/g,
    ([, month, day, year]) => formatDate(year, month, day)
  );

  // ラベル・区切り記号なしで「2014 06 03」のように空白区切りだけの表記にも対応する。
  // 他の書式より誤検出しやすいため、優先度は最も低く(重なる場合は他の書式を優先)し、
  // 改行をまたがない(同じ行内の)半角スペース/タブ区切りのみを対象にする。
  collectDateCandidates(
    text,
    candidates,
    /(\d{4})[ \t]+(\d{1,2})[ \t]+(\d{1,2})(?!\d)/g,
    ([, year, month, day]) => formatDate(year, month, day)
  );

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0].date;
}

function formatDate(year, month, day) {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${m}-${d}`;
}

// 取引金額は消費税抜きの金額を優先して採用する。そのため「税抜」「小計」「合計金額」
// (見積書等で税抜の内訳合計として使われることが多い)を、税込である可能性が高い
// 「ご請求金額」「御見積金額」「合計」等より先に検索する。
const AMOUNT_KEYWORDS = [
  '税抜', '本体価格',
  '小計', '見積合計金額', '合計金額',
  'ご請求金額', '御請求金額', '請求金額',
  '御見積金額', 'お見積金額', '見積金額',
  'お買い上げ合計', 'お買上げ合計', 'ご利用合計', '現計',
  'お会計', '合計', 'ご利用金額', '総額', 'お支払金額', '支払金額', 'お支払い', 'お支払',
  '税込合計', '決済金額',
];

// 桁区切りの数字本体。OCRが「5, 770,000」のようにカンマの直後にだけ余分な
// 半角スペースを入れることがあるため、その場合に限定して許容する
// (カンマの直後という条件を付けないと、離れた場所にある無関係な数字同士が
// 改行をまたいで連結してしまう重大なバグになるため、範囲を狭く限定している)。
const NUMBER_BODY = '\\d(?:[\\d,]|(?<=,) (?=\\d))*\\d';

// 通貨記号(¥/円/JPY)付きの金額を優先対象とし、数量・伝票番号・電話番号等の
// 無関係な数字を誤って金額と判定しないようにする。JPYは英語表記の帳票や、
// 「金額」欄の直後に改行して単独で書かれるケースがあるため\sで改行もまたぐ。
const CURRENCY_TOKEN_PATTERN = new RegExp(`[¥￥]\\s*(${NUMBER_BODY})|(${NUMBER_BODY})\\s*(?:円|JPY)`);
const BARE_NUMBER_PATTERN = new RegExp(`(${NUMBER_BODY})`);

// 「126,000 (税抜)」のように、金額の直後に税抜であることを示す注記が
// 括弧書きで付いているケース。ラベル→金額の順とは逆(金額→注記の順)になるため、
// 他のキーワード探索より先に、これを最優先で確認する。
const AMOUNT_BEFORE_TAX_EXCLUDED_PATTERN = new RegExp(`(${NUMBER_BODY})\\s*円?\\s*[(（]\\s*税抜\\s*[)）]`);

function parseAmountToken(token) {
  const cleaned = token.replace(/[¥￥,\s円]|JPY/gi, '');
  const num = Number(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function matchAmountIn(str, pattern) {
  if (!str) return null;
  const m = str.match(pattern);
  if (!m) return null;
  return parseAmountToken(m[1] || m[2] || m[0]);
}

// キーワードが見つかった行について、そのキーワードより後ろの部分から金額を探す。
// 「小計 ¥500 消費税 ¥50 合計 ¥550」のように1行に複数の金額が並ぶ場合に、
// キーワードより前にある無関係な金額を誤って拾わないようにするため。
// 表形式のレイアウトで「ラベル行→金額行」が改行を挟んで並ぶ場合にも対応する。
function findAmountNear(lines, index, keyword) {
  const line = lines[index];
  const idx = line.indexOf(keyword);
  const after = idx !== -1 ? line.slice(idx + keyword.length) : line;
  const nextLine = lines[index + 1] || '';

  // 優先度1: 通貨記号(¥/円)付きの金額(キーワードと同じ行→次の行の順)
  for (const candidate of [after, nextLine]) {
    const amount = matchAmountIn(candidate, CURRENCY_TOKEN_PATTERN);
    if (amount !== null) return amount;
  }
  // 優先度2: 通貨記号が無い場合でも、キーワード直後や次の行の数字は金額として採用する
  // (OCRが「円」を読み取れず記号が欠落するケースがあるため)
  for (const candidate of [after, nextLine]) {
    const amount = matchAmountIn(candidate, BARE_NUMBER_PATTERN);
    if (amount !== null) return amount;
  }
  return null;
}

function extractAmount(text) {
  // 「126,000 (税抜)」のように金額の直後に税抜の注記が付いている場合は最優先で採用する
  const beforeTaxMatch = text.match(AMOUNT_BEFORE_TAX_EXCLUDED_PATTERN);
  if (beforeTaxMatch) {
    const amount = parseAmountToken(beforeTaxMatch[1]);
    if (amount !== null) return amount;
  }

  const lines = text.split('\n');

  // キーワードを優先度順に走査し、最初に見つかった行の金額を採用する
  for (const keyword of AMOUNT_KEYWORDS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(keyword)) continue;
      const amount = findAmountNear(lines, i, keyword);
      if (amount !== null) return amount;
    }
  }

  // キーワードが見つからない場合は、¥/円が付いた金額のうち最大値を採用
  const withCurrency = [...text.matchAll(new RegExp(CURRENCY_TOKEN_PATTERN, 'g'))]
    .map((m) => parseAmountToken(m[1] || m[2]))
    .filter((n) => n !== null);
  if (withCurrency.length > 0) {
    return Math.max(...withCurrency);
  }

  return null;
}

const VENDOR_HINT_PATTERN =
  /(株式会社|有限会社|合同会社|\(株\)|（株）|\(有\)|（有）|㈱|㈲|商店|薬局|クリニック|病院|ストア|マート)/;

// 「販売元」「発行元」等、取引先名の直前に付くことが多いラベル。存在する場合は
// これを最優先の手がかりとする(請求書には自社・決済代行会社・実際の販売元など
// 複数の会社名が登場することが多く、単純な最初/最長一致では取り違えやすいため)。
const VENDOR_LABEL_KEYWORDS = ['販売元', '発行元', '差出人', 'お支払い先'];

// 取引先名の末尾に付く敬称(御中/様/殿/各位)を除去する
const HONORIFIC_SUFFIX_PATTERN = /\s*(御中|様|殿|各位)\s*$/;

function stripHonorific(name) {
  return name.replace(HONORIFIC_SUFFIX_PATTERN, '').trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 自社名(.envのOWN_COMPANY_NAME)を含む行は「取引先」候補から除外する。
// 請求書の宛先(自社)を取引先として誤って採用しないようにするため。
function isOwnCompany(line) {
  const ownName = process.env.OWN_COMPANY_NAME;
  if (!ownName) return false;
  return new RegExp(escapeRegExp(ownName)).test(line);
}

// 会社/店舗を示す語(株式会社等)を含み、かつ以下のいずれにも該当しない行を
// 取引先名の候補として扱う:
// - 会社種別の単語だけの断片(例: 「株式会社」のみ。名称部分が伴っていない)
// - 「。」を含む、または長すぎる(会社名ではなく文章の一部である可能性が高い)
// - 自社名を含む(取引先ではなく請求書の宛先=自社である)
function isValidVendorCandidate(line) {
  if (!VENDOR_HINT_PATTERN.test(line)) return false;
  if (line.replace(VENDOR_HINT_PATTERN, '').trim().length < 2) return false;
  if (line.includes('。') || line.length > 40) return false;
  if (isOwnCompany(line)) return false;
  return true;
}

// 「販売元」等のラベル行が見つかった場合、その行自体または直後数行の中から
// 取引先名らしい行を探す(ラベルと名称が同じ行のことも、次の行のこともあるため)。
function findVendorNearLabel(lines) {
  for (const keyword of VENDOR_LABEL_KEYWORDS) {
    const idx = lines.findIndex((l) => l.includes(keyword));
    if (idx === -1) continue;
    for (let i = idx; i < Math.min(idx + 4, lines.length); i += 1) {
      if (isValidVendorCandidate(lines[i])) return lines[i];
    }
  }
  return null;
}

function extractVendor(text) {
  const lines = text
    .split('\n')
    .map((l) => stripHonorific(l.trim()))
    .filter(Boolean);

  // 「販売元」等のラベルが明示されていれば、それを最優先で採用する
  const labeled = findVendorNearLabel(lines);
  if (labeled) return labeled.slice(0, 60);

  // ラベルが無い場合は、条件を満たす最初のヒント一致行を採用する
  const hinted = lines.find(isValidVendorCandidate);
  if (hinted) return hinted.slice(0, 60);

  // それでも見つからなければ、レシート/請求書の先頭付近の行を採用(住所・電話番号などは除外)。
  // 日本国内の取引先名なら通常ひらがな・カタカナ・漢字のいずれかを含むはずなので、
  // それらを一切含まない行(伝票番号・"No."等の英数字の断片)は候補にしない。
  // また、会社種別の単語だけの断片・自社名もここで拾い直さないようにする。
  const excludePattern = /(領収書|請求書|レシート|お客様|様|〒|TEL|Tel|電話|http|www\.)/;
  const containsJapanese = /[぀-ヿ一-鿿]/;
  const isBareHintFragment = (l) => VENDOR_HINT_PATTERN.test(l) && l.replace(VENDOR_HINT_PATTERN, '').trim().length < 2;
  const firstMeaningful = lines.find(
    (l) =>
      l.length >= 2 &&
      !excludePattern.test(l) &&
      !/^\d+$/.test(l) &&
      containsJapanese.test(l) &&
      !isBareHintFragment(l) &&
      !isOwnCompany(l)
  );
  return firstMeaningful ? firstMeaningful.slice(0, 60) : null;
}

// 書類上部などに現れる典型的な書類名から書類種別を推定する。
// 複数該当しうる場合はより具体的なもの(見積書・納品書など)を優先する。
const DOCUMENT_TYPE_PATTERNS = [
  { label: '見積書', pattern: /見積書/ },
  { label: '納品書', pattern: /納品書/ },
  { label: '請求書', pattern: /請求書/ },
  { label: '領収書', pattern: /領収書|レシート/ },
  { label: '契約書', pattern: /契約書/ },
  { label: '注文書', pattern: /注文書|発注書/ },
  { label: '検収書', pattern: /検収書/ },
];

function extractDocumentType(text) {
  for (const { label, pattern } of DOCUMENT_TYPE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// OCR結果に全角数字・全角カンマが含まれることがあるため、金額・日付の数値解析の前に半角へ統一する
function normalizeOcrText(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',');
}

async function extractReceiptData({ base64Data, mimeType }) {
  assertSupportedMime(mimeType);

  const rawText = mimeType === 'application/pdf'
    ? await ocrPdf(base64Data)
    : await ocrImage(base64Data);
  const text = rawText ? normalizeOcrText(rawText) : '';

  if (!text) {
    return { date: null, vendor: null, amount: null, documentType: null };
  }

  const result = {
    date: extractDate(text),
    vendor: extractVendor(text),
    amount: extractAmount(text),
    documentType: extractDocumentType(text),
  };

  if (process.env.DEBUG_OCR === 'true') {
    console.log('--- [DEBUG_OCR] Vision APIのOCR結果(正規化後) ---');
    console.log(text);
    console.log('--- [DEBUG_OCR] 抽出結果 ---', result);
  }

  return result;
}

module.exports = { extractReceiptData };
