// Google Cloud Vision API (無料枠: 月1000ユニットまで無料) でOCRし、
// 得られたテキストを正規表現ベースのヒューリスティックで解析して
// 取引日付・取引先名・取引金額を推定する。
// 精度はClaude Vision(旧実装)より劣る可能性がある。抽出結果は必ずユーザーが
// 画面上で確認・修正できるようにすること。

const path = require('path');
const { isInvoiceLookupEnabled, findRegistrationNumbers, lookupRegisteredNames } = require('./invoice-registry');

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
  return pageTexts;
}

// PDFに埋め込まれているテキストレイヤーを取り出す(PDF.jsを使用)。
// 日本語フォントを埋め込まずに出力されたPDFは、Vision APIが画像化した時点で
// 日本語が描画されず消えてしまう(印影の文字だけが読み取られる等)が、
// テキストレイヤーには文字データが残っているため、OCRの代わりに使えるようにする。
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDF_TEXT_LAYER_MAX_PAGES = 5; // OCR(ocrPdf)と同じページ数に揃える
let pdfjsPromise = null;

async function extractPdfTextLayer(base64Data) {
  // pdfjs-distはESMのみ提供のため動的importで読み込む
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(Buffer.from(base64Data, 'base64')),
      // 日本語フォント(Adobe-Japan1等)の文字コード変換にCMapが必要
      cMapUrl: path.join(PDFJS_DIR, 'cmaps') + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(PDFJS_DIR, 'standard_fonts') + path.sep,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch {
    // パスワード付き・破損PDF等はテキストレイヤー無しとして扱い、OCR結果だけを使う
    return [];
  }
  try {
    const pageTexts = [];
    for (let p = 1; p <= Math.min(doc.numPages, PDF_TEXT_LAYER_MAX_PAGES); p += 1) {
      const { items } = await (await doc.getPage(p)).getTextContent();
      pageTexts.push(layoutTextItems(items));
    }
    return pageTexts;
  } finally {
    await doc.destroy();
  }
}

// 同じ行とみなす縦位置のずれ、および別の行(段)に分ける横方向の間隔(いずれも文字の高さに対する倍率)
const LAYOUT_SAME_LINE_TOLERANCE = 0.5;
const LAYOUT_SEGMENT_GAP = 2;
const LAYOUT_WORD_GAP = 0.2;

// テキストレイヤーの文字列は書かれた順(帳票のテンプレート→差し込みデータ等)に並んでおり、
// 見た目の順序とは限らないため、座標からOCR結果と同じような行の並びを組み立てる:
//   - 縦位置が近い文字列を1行にまとめ、上の行から順に左から右へ並べる
//   - 同じ行でも横に大きく離れた文字列(左右の段に分かれた宛先と発行元等)は別の行にする
//   - 「2026」「年」「09」「月」のように隣接する文字列は区切らずに連結する
function layoutTextItems(items) {
  const boxes = items
    .filter((item) => item.str?.trim())
    .map((item) => ({
      str: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height || 1,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const box of boxes) {
    const row = rows.find((r) => Math.abs(r.y - box.y) <= Math.min(r.height, box.height) * LAYOUT_SAME_LINE_TOLERANCE);
    if (row) row.boxes.push(box);
    else rows.push({ y: box.y, height: box.height, boxes: [box] });
  }

  const lines = [];
  for (const row of rows) {
    const sorted = row.boxes.sort((a, b) => a.x - b.x);
    let line = sorted[0].str;
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const gap = sorted[i].x - (prev.x + prev.width);
      if (gap > row.height * LAYOUT_SEGMENT_GAP) {
        lines.push(line);
        line = sorted[i].str;
      } else {
        line += (gap > row.height * LAYOUT_WORD_GAP ? ' ' : '') + sorted[i].str;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// テキストレイヤーの日本語(かな・漢字)の文字数がOCR結果のこの倍率以上あれば、
// OCRで日本語が欠落したとみなしてテキストレイヤーを採用する。通常のPDFでは
// OCR結果を使い続ける(既存の抽出ルールはOCRの行の並びを前提に調整しているため)。
const TEXT_LAYER_PREFERRED_RATIO = 2;
const TEXT_LAYER_MIN_JAPANESE_CHARS = 20;

function countJapaneseChars(text) {
  return (text.match(/[぀-ヿ一-鿿]/g) || []).length;
}

// ページごとのテキストを返す(登録番号を1ページ目だけから探すため、ページの区切りを残す)
async function readPdfPages(base64Data) {
  const [ocrPages, layerPages] = await Promise.all([ocrPdf(base64Data), extractPdfTextLayer(base64Data)]);
  const layerJapanese = countJapaneseChars(layerPages.join('\n'));
  const ocrJapanese = countJapaneseChars(ocrPages.join('\n'));
  if (layerJapanese >= TEXT_LAYER_MIN_JAPANESE_CHARS && layerJapanese >= ocrJapanese * TEXT_LAYER_PREFERRED_RATIO) {
    return layerPages;
  }
  return ocrPages;
}

const KANJI_DIGITS = '〇一二三四五六七八九';
const ERA_START_YEAR = {
  令和: 2018, // 令和1年 = 2019
  平成: 1988, // 平成1年 = 1989
  昭和: 1925, // 昭和1年 = 1926
};
const ERA_LETTERS = { R: '令和', H: '平成', S: '昭和' };

// 各書式のパターンを文書全体から探し、電話番号や伝票番号がたまたま日付と同じ桁の並びに
// マッチしても月や日の値が不正(13より大きい月など)であれば候補にしない。
// 有効な候補を書式の種類に関係なく文書中での出現位置順に並べ、最も先に出現したものを
// 採用する(以前は「和暦→西暦(漢字)→スラッシュ区切り→年が末尾」という書式の優先順位で
// 選んでいたため、実際には後方にある書式が先に見つかり、文書内で本来先に出てくる
// 日付より優先されてしまうことがあった)。
// 既に採用した候補と範囲が重なる場合は追加しない(同じ文字列を複数の書式で二重に
// 拾わないようにするため。呼び出し順が優先順位になる)。
// 海外の請求書で使われる英語の月名(先頭3文字で判定。Sept/Septemberなども可)
const EN_MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function englishMonthNumber(name) {
  return EN_MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

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
  const candidates = collectDates(text);
  return candidates.length === 0 ? null : candidates[0].date;
}

// 文書中の日付を、書式の種類に関係なく出現位置順に並べて返す({ start, end, date })
function collectDates(text) {
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

  // 英語表記: October 18, 2026 / Oct. 18th 2026
  collectDateCandidates(
    text,
    candidates,
    new RegExp(`\\b${EN_MONTH}[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'gi'),
    ([, month, day, year]) => formatDate(year, englishMonthNumber(month), day)
  );

  // 英語表記(日が先): 18 October 2026 / 18 Oct, 2026
  collectDateCandidates(
    text,
    candidates,
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${EN_MONTH}[a-z]*\\.?,?\\s+(\\d{4})(?!\\d)`, 'gi'),
    ([, day, month, year]) => formatDate(year, englishMonthNumber(month), day)
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

  // 銀行の帳票等で使われる和暦の略記: R08.08.28 / R080828 (R=令和, H=平成, S=昭和)。
  // 製品コード等の英字+数字と区別するため、英数字の直後に続くものは対象外にし、
  // 区切り記号は年月日で揃っているか、6桁の数字だけの場合に限る
  const eraLetterToDate = ([, letter, year, month, day]) =>
    formatDate(ERA_START_YEAR[ERA_LETTERS[letter]] + parseInt(year, 10), month, day);
  collectDateCandidates(text, candidates, /(?<![A-Za-z0-9])([RHS])\s?(\d{2})([./-])(\d{2})\3(\d{2})(?!\d)/g,
    ([all, letter, year, , month, day]) => eraLetterToDate([all, letter, year, month, day]));
  collectDateCandidates(text, candidates, /(?<![A-Za-z0-9])([RHS])(\d{2})(\d{2})(\d{2})(?!\d)/g, eraLetterToDate);

  // ラベル・区切り記号なしで「2014 06 03」のように空白区切りだけの表記にも対応する。
  // 他の書式より誤検出しやすいため、優先度は最も低く(重なる場合は他の書式を優先)し、
  // 改行をまたがない(同じ行内の)半角スペース/タブ区切りのみを対象にする。
  collectDateCandidates(
    text,
    candidates,
    /(\d{4})[ \t]+(\d{1,2})[ \t]+(\d{1,2})(?!\d)/g,
    ([, year, month, day]) => formatDate(year, month, day)
  );

  return candidates.sort((a, b) => a.start - b.start);
}

// 請求期間・利用期間・契約期間など、書類に書かれた期間(開始日と終了日)を探す。
// 「2024年4月1日 - 2024年4月29日」「2026/10/01 ～ 2026/10/30」のように2つの日付が
// 区切り記号で結ばれているものを期間とみなす。帳票のレイアウトによっては「～」の後に
// 別の欄の文字が数行挟まって終了日が続くことや、OCRで「～」だけが単独の行になる
// (「2026年10月14日 / ~ / 2028年10月13日」)ことがあるため、「～」「から」の場合に限り
// 前後の改行と数行先までを許容する
// (「-」は日付以外にも多用されるため、同じ行で日付同士が結ばれている場合だけにする)。
const PERIOD_SAME_LINE_SEPARATOR = /^[ \t]*(?:[-－–—]|to)[ \t]*$/i;
const PERIOD_MULTILINE_SEPARATOR = /^\s*(?:[～〜~]|から)[^\n]*(?:\n[^\n]*){0,3}$/;
// 期間として妥当な最大日数(無関係な日付同士を期間と誤認しないため)。
// 複数年のレンタル・リース契約や保守契約もあるため5年までとする
const PERIOD_MAX_DAYS = 366 * 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function extractPeriod(text) {
  const english = extractEnglishPeriod(text) ?? extractYearlessStartPeriod(text);
  const dates = collectDates(text);
  for (let i = 0; i + 1 < dates.length; i += 1) {
    const start = dates[i];
    const end = dates[i + 1];
    const between = text.slice(start.end, end.start);
    if (!PERIOD_SAME_LINE_SEPARATOR.test(between) && !PERIOD_MULTILINE_SEPARATOR.test(between)) continue;
    const days = (Date.parse(end.date) - Date.parse(start.date)) / DAY_MS;
    if (days < 0 || days > PERIOD_MAX_DAYS) continue;
    // 英語表記の期間の方が先に書かれていれば、そちらを優先する
    if (english && english.index < start.start) break;
    return { start: start.date, end: end.date };
  }
  return english ? { start: english.start, end: english.end } : null;
}

// 英語の請求書の「September 1 - September 30, 2026」のように、年が終了日側にしか書かれていない期間
function extractEnglishPeriod(text) {
  const pattern = new RegExp(
    `\\b${EN_MONTH}[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[ \\t]*[-–—][ \\t]*${EN_MONTH}[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`,
    'i'
  );
  const m = text.match(pattern);
  if (!m) return null;
  const [, startMonth, startDay, endMonth, endDay, endYear] = m;
  const startMonthNum = englishMonthNumber(startMonth);
  const endMonthNum = englishMonthNumber(endMonth);
  // 「December 1 - January 31, 2027」のように年をまたぐ場合は開始日が前年
  const startYear = startMonthNum > endMonthNum ? Number(endYear) - 1 : Number(endYear);
  const start = formatDate(startYear, startMonthNum, startDay);
  const end = formatDate(endYear, endMonthNum, endDay);
  return start && end ? { index: m.index, start, end } : null;
}

// AWSの請求書の「2月1日 - 2023年2月28日」のように、開始日側の年が省略された日本語の期間
function extractYearlessStartPeriod(text) {
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日[ \t]*[-－–—～〜~][ \t]*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  const [, startMonth, startDay, endYear, endMonth, endDay] = m;
  const startYear = Number(startMonth) > Number(endMonth) ? Number(endYear) - 1 : Number(endYear);
  const start = formatDate(startYear, startMonth, startDay);
  const end = formatDate(endYear, endMonth, endDay);
  return start && end ? { index: m.index, start, end } : null;
}

// 締日を探す。「締日: 2026年9月30日」のようにラベルの後に書かれている場合と、
// 「2026年9月30日締め」「9/30〆」のように日付の後ろに付く場合がある
// (「締切日」は提出・支払の期限であり締日ではないため対象外)。
const CLOSING_DATE_LABEL_PATTERN = /締め?日|〆日/g;
const CLOSING_DATE_LOOKAHEAD_LINES = 1;
const CLOSING_DATE_SUFFIX_PATTERN = /^\s*(?:締め?(?!切)|〆(?!切))/;

// 「締日 11月末日」のように年の無い月末指定。年は取引年月日(発行日)に最も近くなるよう補う
const CLOSING_MONTH_END_PATTERN = /^[\s:：]*(\d{1,2})\s*月\s*末/;

function extractClosingDate(text, issueDate) {
  const labeled = findDateAfterLabel(text, CLOSING_DATE_LABEL_PATTERN, CLOSING_DATE_LOOKAHEAD_LINES);
  if (labeled) return labeled;
  const suffixed = collectDates(text).find((d) => CLOSING_DATE_SUFFIX_PATTERN.test(text.slice(d.end)));
  if (suffixed) return suffixed.date;
  if (!issueDate) return null;
  for (const m of text.matchAll(CLOSING_DATE_LABEL_PATTERN)) {
    const monthEnd = text.slice(m.index + m[0].length).match(CLOSING_MONTH_END_PATTERN);
    if (monthEnd) return nearestMonthEnd(Number(monthEnd[1]), issueDate);
  }
  return null;
}

// 指定した月の末日のうち、基準日に最も近い年のものを返す(前年・同年・翌年から選ぶ)
function nearestMonthEnd(month, baseDate) {
  if (month < 1 || month > 12) return null;
  const baseYear = Number(baseDate.slice(0, 4));
  const base = Date.parse(baseDate);
  const candidates = [baseYear - 1, baseYear, baseYear + 1].map((year) => {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return formatDate(year, month, lastDay);
  });
  return candidates.reduce((best, c) =>
    Math.abs(Date.parse(c) - base) < Math.abs(Date.parse(best) - base) ? c : best
  );
}

// 支払期限(請求書の「お支払期限」「振込期限」等)を探す。ファイル名の日付に優先的に使うため、
// 取引年月日とは別に抽出する。ラベルの直後(同じ行の残り+次の2行)にある最初の有効な日付を採用し、
// ラベルが無い・ラベル付近に日付が無い場合はnullを返す(呼び出し側で取引年月日にフォールバック)。
// 英語の請求書の「Date due」「Due date」「$22.00 USD due October 18, 2026」等にも対応する。
const DUE_DATE_LABEL_PATTERN = /(?:お?支払い?|お?振込み?)\s*(?:期限|期日)|\bdue\b/gi;
const DUE_DATE_LOOKAHEAD_LINES = 2;

function extractDueDate(text) {
  return findDateAfterLabel(text, DUE_DATE_LABEL_PATTERN, DUE_DATE_LOOKAHEAD_LINES);
}

function findDateAfterLabel(text, labelPattern, lookaheadLines) {
  for (const m of text.matchAll(labelPattern)) {
    const after = text.slice(m.index + m[0].length);
    const nearby = after.split('\n').slice(0, lookaheadLines + 1).join('\n');
    const date = extractDate(nearby);
    if (date) return date;
  }
  return null;
}

// 取引年月日には書類の発行日を使う。請求書には請求期間・サービス期間などの日付も並ぶため、
// 単純に最初に出てくる日付を取ると期間の日付になることがある(AWSの請求書など)。
// 発行日のラベルが無い・付近に日付が無い場合は、文書中で最初に出てくる日付にフォールバックする。
// 英語の請求書は「Invoice number / Date of issue / Date due」の見出しの後に値がまとめて
// 並ぶことがあるため、見出しの後3行まで見る。
const ISSUE_DATE_LABEL_PATTERN =
  /発行年?月?日|発行済み請求書|ご?請求日|請求書日付|Date\s+of\s+issue|Issue\s+date|Invoice\s+date|Date\s+issued/gi;
const ISSUE_DATE_LOOKAHEAD_LINES = 3;

function extractIssueDate(text) {
  return findDateAfterLabel(text, ISSUE_DATE_LABEL_PATTERN, ISSUE_DATE_LOOKAHEAD_LINES) ?? extractDate(text) ?? extractEralessLabeledDate(text);
}

// 銀行の帳票では「納期限 08.09.10」「領収日 08-03-09」のように元号を省いた和暦(令和)だけが書かれていることがある。
// 年が2桁だけの日付は他の数字と紛れやすいため、見出しと同じ行の後ろか直後(2行以内)の「YY.MM.DD」「YY-MM-DD」だけを対象にする
const ERALESS_DATE_LABEL_PATTERN = /納\s*期\s*限|納付期限|領収日/;
const ERALESS_DATE_PATTERN = /^(\d{2})([.\-/])(\d{2})\2(\d{2})$/;

function extractEralessLabeledDate(text) {
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const label = lines[i].match(ERALESS_DATE_LABEL_PATTERN);
    if (!label) continue;
    const sameLine = lines[i].slice(label.index + label[0].length).trim();
    for (const candidate of [sameLine, ...lines.slice(i + 1, i + 3)]) {
      const m = candidate.match(ERALESS_DATE_PATTERN);
      if (m) return formatDate(ERA_START_YEAR.令和 + parseInt(m[1], 10), m[3], m[4]);
    }
  }
  return null;
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
// 融資の返済予定表等では、融資金額(借入額)を取引金額とする(償還額・利息額等より優先)。
const AMOUNT_KEYWORDS = [
  '融資金額',
  '税抜', '本体価格',
  '小計', '見積合計金額', '合計金額',
  'ご請求金額', '御請求金額', '請求金額',
  '御見積金額', 'お見積金額', '見積金額',
  'お買い上げ合計', 'お買上げ合計', 'ご利用合計', '現計',
  'お会計', '合計', 'ご利用金額', '総額', 'お支払金額', '支払金額', 'お支払い', 'お支払',
  '税込合計', '決済金額',
  // 海外の請求書(英語)。日本語のキーワードが見つからない場合のみ使われる。大文字小文字は区別しない
  'Total excluding tax', 'Subtotal', 'Sub-total', 'Sub total',
  'Amount due', 'Balance due', 'Total due', 'Grand total', 'Total',
];

// 桁区切りの数字本体。OCRが「5, 770,000」のようにカンマの直後にだけ余分な
// 半角スペースを入れることがあるため、その場合に限定して許容する
// (カンマの直後という条件を付けないと、離れた場所にある無関係な数字同士が
// 改行をまたいで連結してしまう重大なバグになるため、範囲を狭く限定している)。
// 海外の請求書の「$20.00」のような小数点以下2桁までの金額にも対応する。
const NUMBER_BODY = '\\d(?:[\\d,]|(?<=,) (?=\\d))*\\d(?:\\.\\d{1,2}(?!\\d))?';

// 通貨記号(¥/円/JPY)付きの金額を優先対象とし、数量・伝票番号・電話番号等の
// 無関係な数字を誤って金額と判定しないようにする。JPYは英語表記の帳票や、
// 「金額」欄の直後に改行して単独で書かれるケースがあるため\sで改行もまたぐ。
// 海外の請求書向けに$/€/£とUSD/EUR/GBPも通貨記号として扱う。「JPY 24,123」「USD 152.73」のように
// 通貨コードが数字の前に付く書き方にも対応する。
// 通貨が数字の後ろに付く書き方では、「1 USD = 157.9378088618 JPY」の「9378088618」のように
// 長い数字の途中から一部だけを切り出して金額と誤認しないよう、数字の途中から始まる一致を除外する。
// 通貨記号が付いていれば数量等と取り違えるおそれが無いため、「JPY 2」「$5」のような1桁の金額も認める
// (末尾のカンマは金額に含めない)。
const CURRENCY_NUMBER_BODY = '\\d(?:[\\d,]|(?<=,) (?=\\d))*(?<!,)(?:\\.\\d{1,2}(?!\\d))?';
const TRAILING_CURRENCY_NUMBER = `(?<![\\d.,])(${CURRENCY_NUMBER_BODY})`;
const CURRENCY_TOKEN_PATTERN = new RegExp(`(?:[¥￥$€£]|JPY|USD|EUR|GBP)\\s*(${CURRENCY_NUMBER_BODY})|${TRAILING_CURRENCY_NUMBER}\\s*(?:円|JPY|USD|EUR|GBP)`);
const YEN_TOKEN_PATTERN = new RegExp(`(?:[¥￥]|JPY)\\s*(${CURRENCY_NUMBER_BODY})|${TRAILING_CURRENCY_NUMBER}\\s*(?:円|JPY)`);
// 「消費税 (10%)」の税率のような%付きの数字は金額ではないため除外する
// (前後の数字の途中から一部だけを切り出して%の判定をすり抜けないよう、前後に数字が続く位置も除外する)
const BARE_NUMBER_PATTERN = new RegExp(`(?<![\\d,.])(${NUMBER_BODY})(?![\\d,.]|\\s*[%％])`);

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
// yenOnlyの場合は円(¥/円/JPY)付きの金額だけを対象にし、通貨記号の無い数字は採用しない。
const YEN_AMOUNT_LOOKAHEAD_LINES = 4;
function findAmountNear(lines, index, keyword, yenOnly) {
  const line = lines[index];
  const idx = line.toLowerCase().indexOf(keyword.toLowerCase());
  const after = idx !== -1 ? line.slice(idx + keyword.length) : line;
  const nextLine = lines[index + 1] || '';

  // 優先度1: 通貨記号(¥/円)付きの金額(キーワードと同じ行→次の行の順)
  for (const candidate of [after, nextLine]) {
    // 「1 USD = 150.5 JPY」のような換算レートの行は円の金額ではない
    if (yenOnly && /rate|レート/i.test(candidate)) continue;
    const amount = matchAmountIn(candidate, yenOnly ? YEN_TOKEN_PATTERN : CURRENCY_TOKEN_PATTERN);
    if (amount !== null) return amount;
  }
  if (yenOnly) {
    // 外資系の請求書(AWSのTax Invoice等)は「TOTAL AMOUNT / 請求書番号 / 日付 / JPY 2」のように
    // 見出しと円の金額の間に別の項目の値や外貨の金額が挟まることがあるため、数行先まで円の金額を探す
    for (let i = index + 2; i <= index + YEN_AMOUNT_LOOKAHEAD_LINES && i < lines.length; i += 1) {
      if (/rate|レート/i.test(lines[i])) continue;
      const amount = matchAmountIn(lines[i], YEN_TOKEN_PATTERN);
      if (amount !== null) return amount;
    }
    return null;
  }
  // 優先度2: 通貨記号が無い場合でも、キーワード直後や次の行の数字は金額として採用する
  // (OCRが「円」を読み取れず記号が欠落するケースがあるため)
  for (const candidate of [after, nextLine]) {
    const amount = matchAmountIn(candidate, BARE_NUMBER_PATTERN);
    if (amount !== null) return amount;
  }
  return null;
}

// 消費税率(8%/10%、混在含む)として妥当な「消費税額÷税抜金額」の範囲
const TAX_RATIO_MIN = 0.075;
const TAX_RATIO_MAX = 0.105;

// 見つかった金額が税込だった場合に、文書中に実際に書かれている税抜金額を探す。
// 表形式の請求書では「税抜金額 / 消費税額 / 税込金額」のラベル列と数値列がOCR上で
// 離れてしまい、ラベル直後に数値が無いためキーワード探索では税込金額しか拾えないことがある。
// そこで「税抜N + 消費税X = 税込T」となるN・Xが両方とも文書中に存在し、X/Nが消費税率として
// 妥当な場合にNを税抜金額とみなす(計算で作った値ではなく、文書に書かれている数値だけを使う)。
function findTaxExcludedAmount(text, total) {
  const numbers = new Set(
    [...text.matchAll(new RegExp(NUMBER_BODY, 'g'))]
      .map((m) => parseAmountToken(m[0]))
      .filter((n) => n !== null)
  );
  let best = null;
  for (const n of numbers) {
    if (n >= total) continue;
    // 小数(ドル等)の引き算の誤差で numbers.has が外れないようセント単位に丸める
    const tax = Math.round((total - n) * 100) / 100;
    const ratio = tax / n;
    if (ratio < TAX_RATIO_MIN || ratio > TAX_RATIO_MAX) continue;
    if (!numbers.has(tax)) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

// 「税抜金額 / 消費税額 / 税込金額」の表で、数値が見出しから離れて「255,198 / 25,519 / 280,717」のように
// 連続した行に並んでいる場合の税抜金額と消費税額。
// 税抜+消費税=税込が成り立ち、消費税率として妥当な行だけを採用する(複数あれば最大の税抜金額)。
function findTaxBreakdownRow(text) {
  if (!text.includes('税抜')) return null;
  const values = text.split('\n').map((line) => {
    const m = line.trim().match(new RegExp(`^${NUMBER_BODY}$`));
    return m ? parseAmountToken(m[0]) : null;
  });
  let best = null;
  for (let i = 0; i + 2 < values.length; i += 1) {
    const [n, tax, total] = values.slice(i, i + 3);
    if (n === null || tax === null || total === null) continue;
    if (Math.round((n + tax) * 100) !== Math.round(total * 100)) continue;
    const ratio = tax / n;
    if (ratio < TAX_RATIO_MIN || ratio > TAX_RATIO_MAX) continue;
    if (best === null || n > best.n) best = { n, tax };
  }
  return best;
}

// 「合計 ¥1,100 (税込) / うち消費税(10%) ¥100」のように、税込金額と内税の消費税額だけが書かれていて
// 税抜金額そのものは書かれていない場合に、税込金額から消費税額を引いた税抜金額を返す。
// ゴルフ場の領収書のように、消費税の見出しと金額の間に別の項目(利用税 ¥0 等)の金額が挟まることがあるため、
// 見出しの後ろ数行の円の金額から、税率として妥当なものを探す。
// 内税の書類であることを示す語が無い場合や、「税込金額+消費税額」が文書中にある場合
// (=見つけた金額は税抜で、消費税は外税)は対象外とする。
const INCLUDED_TAX_MARKER_PATTERN = /内税|(?:うち|内)\s*消費税|税込|消費税込/;
const CONSUMPTION_TAX_LABEL_PATTERN = /消費税/;
const INCLUDED_TAX_LOOKAHEAD_LINES = 3;

function findAmountExcludingIncludedTax(text, total) {
  if (!INCLUDED_TAX_MARKER_PATTERN.test(text)) return null;
  const numbers = new Set(
    [...text.matchAll(new RegExp(NUMBER_BODY, 'g'))].map((m) => parseAmountToken(m[0])).filter((n) => n !== null)
  );
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(CONSUMPTION_TAX_LABEL_PATTERN);
    // 「金額(消費税込)」「(税込・消費税 10%対象)」のような税込の注記は消費税額の見出しではない
    if (!m || /税込|消費税込/.test(lines[i])) continue;
    const candidates = [lines[i].slice(m.index + m[0].length), ...lines.slice(i + 1, i + 1 + INCLUDED_TAX_LOOKAHEAD_LINES)];
    for (const candidate of candidates) {
      const tax = matchAmountIn(candidate, YEN_TOKEN_PATTERN);
      if (tax === null || tax >= total || numbers.has(total + tax)) continue;
      const ratio = tax / (total - tax);
      if (ratio >= TAX_RATIO_MIN && ratio <= TAX_RATIO_MAX) return total - tax;
    }
  }
  return null;
}

const BILLED_AMOUNT_KEYWORDS =['ご請求金額', '御請求金額', '請求金額'];

// 表の税抜金額に、非課税分(立替経費の入湯税等)を含めた金額を返す。
// ご請求金額が税抜+消費税より大きければ、差額は非課税分なので「ご請求金額 - 消費税額」とする。
function amountFromTaxBreakdown(text, breakdown) {
  const lines = text.split('\n');
  for (const keyword of BILLED_AMOUNT_KEYWORDS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(keyword)) continue;
      const billed = findAmountNear(lines, i, keyword, false);
      if (billed !== null && billed > breakdown.n + breakdown.tax) return billed - breakdown.tax;
      if (billed !== null) return breakdown.n;
    }
  }
  return breakdown.n;
}

// 銀行経由で税金を納付する「納付明細」の取引金額(合計 − 取扱手数料)。
// 表の見出しが縦書きのため、OCRで「合」「計」が別々の行になる。最後の「合計」の後ろ数行の数字のうち最大のものを合計とし、
// 「取扱手数料」の金額(円付き)があれば差し引く
const TAX_PAYMENT_DOCUMENT_PATTERN = /納付明細/;
const TAX_PAYMENT_TOTAL_LOOKAHEAD_LINES = 6;

function findTaxPaymentAmount(text) {
  if (!TAX_PAYMENT_DOCUMENT_PATTERN.test(text)) return null;
  const totalLabels = [...text.matchAll(/合[ \t]*\n?[ \t]*計/g)];
  if (totalLabels.length === 0) return null;
  const last = totalLabels.at(-1);
  const after = text.slice(last.index + last[0].length).split('\n').slice(1, 1 + TAX_PAYMENT_TOTAL_LOOKAHEAD_LINES);
  const totals = after
    .map((line) => line.trim().match(new RegExp(`^(${NUMBER_BODY})`)))
    .filter(Boolean)
    .map((m) => parseAmountToken(m[1]))
    .filter((n) => n !== null);
  if (totals.length === 0) return null;
  const total = Math.max(...totals);

  const lines = text.split('\n');
  const feeIndex = lines.findIndex((l) => l.includes('取扱手数料'));
  const fee = feeIndex === -1 ? null : findAmountNear(lines, feeIndex, '取扱手数料', true);
  return fee !== null && fee < total ? total - fee : total;
}

function extractAmount(text) {
  // 「126,000 (税抜)」のように金額の直後に税抜の注記が付いている場合は最優先で採用する
  const beforeTaxMatch = text.match(AMOUNT_BEFORE_TAX_EXCLUDED_PATTERN);
  if (beforeTaxMatch) {
    const amount = parseAmountToken(beforeTaxMatch[1]);
    if (amount !== null) return amount;
  }

  const breakdown = findTaxBreakdownRow(text);
  if (breakdown !== null) return amountFromTaxBreakdown(text, breakdown);

  const taxPayment = findTaxPaymentAmount(text);
  if (taxPayment !== null) return taxPayment;

  // 外資系の日本法人の請求書などで円と外貨の両方が書かれている場合は、円の金額を優先する
  if (text.search(FOREIGN_CURRENCY_TOKEN_PATTERN) !== -1) {
    const yenAmount = extractAmountByKeyword(text, true);
    if (yenAmount !== null) return findTaxExcludedAmount(text, yenAmount) ?? yenAmount;
  }

  const amount = extractAmountByKeyword(text, false);
  if (amount === null) return isZeroAmountDocument(text) ? 0 : null;
  const taxExcluded = findTaxExcludedAmount(text, amount) ?? findAmountExcludingIncludedTax(text, amount);
  return convertForeignAmountToYen(text, taxExcluded ?? amount);
}

// 利用が無かった月の請求書(合計¥0)のように、通貨記号付きの金額がすべて0の場合は0円とする
// (parseAmountTokenは0を金額として扱わないため、金額の探索では見つからない)。
function isZeroAmountDocument(text) {
  const values = [...text.matchAll(new RegExp(CURRENCY_TOKEN_PATTERN.source, 'g'))]
    .map((m) => Number((m[1] || m[2]).replace(/[,\s]/g, '')));
  return values.length > 0 && values.every((v) => v === 0);
}

// 外貨(ドル等)の金額として文書中に書かれている数値の一覧
const FOREIGN_CURRENCY_TOKEN_PATTERN = new RegExp(`(?:[$€£]|USD|EUR|GBP)\\s*(${CURRENCY_NUMBER_BODY})|${TRAILING_CURRENCY_NUMBER}\\s*(?:USD|EUR|GBP)`, 'g');

// 請求書に記載された円への換算レート。海外事業者の請求書には
// 「JCT amount in JPY: ¥316 using a conversion rate of 158.19.」
// 「Exchange rate: 1 USD = 158.19 JPY」「換算レート 158.19」のように書かれていることがある。
const EXCHANGE_RATE_PATTERNS = [
  /(?:conversion|exchange)\s+rate\s*(?:of|is|:)?\s*(?:1\s*(?:USD|EUR|GBP|[$€£])\s*=\s*)?(?:JPY|[¥￥])?\s*(\d+(?:\.\d+)?)/i,
  /\b1\s*(?:USD|EUR|GBP|[$€£])\s*=\s*(?:JPY|[¥￥])?\s*(\d+(?:\.\d+)?)/i,
  /(?:換算|為替|適用)\s*レート\s*[:：]?\s*(\d+(?:\.\d+)?)/,
];
// 外貨1単位あたりの円として妥当な範囲(他通貨間のレート 1.08 等を誤って使わないため)
const EXCHANGE_RATE_MIN = 10;
const EXCHANGE_RATE_MAX = 1000;

function findExchangeRateToYen(text) {
  for (const pattern of EXCHANGE_RATE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const rate = Number(m[1]);
    if (rate >= EXCHANGE_RATE_MIN && rate <= EXCHANGE_RATE_MAX) return rate;
  }
  return null;
}

// 金額が外貨で書かれていて、請求書に換算レートの記載があれば円に換算する(1円未満は四捨五入)。
// レートの記載が無い場合は換算せず、外貨の数値のまま返す(ネット上のレートは使わない方針)。
function convertForeignAmountToYen(text, amount) {
  const foreignAmounts = [...text.matchAll(FOREIGN_CURRENCY_TOKEN_PATTERN)]
    .map((m) => parseAmountToken(m[1] || m[2]));
  if (!foreignAmounts.includes(amount)) return amount;
  const rate = findExchangeRateToYen(text);
  return rate === null ? amount : Math.round(amount * rate);
}

// yenOnlyの場合は円付きの金額だけを探し、キーワードで見つからなくても最大値での代用はしない
// (「JCT amount in JPY: ¥316」のような消費税額だけの円表記を取引金額と誤認しないため)。
function extractAmountByKeyword(text, yenOnly) {
  const lines = text.split('\n');

  // キーワードを優先度順に走査し、最初に見つかった行の金額を採用する
  for (const keyword of AMOUNT_KEYWORDS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(keyword.toLowerCase())) continue;
      const amount = findAmountNear(lines, i, keyword, yenOnly);
      if (amount !== null) return amount;
    }
  }
  if (yenOnly) return null;

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
  /(株式会社|有限会社|合同会社|\(株\)|（株）|\(有\)|（有）|㈱|㈲|商店|薬局|クリニック|病院|ゴルフ(?:クラブ|倶楽部)|カントリー(?:クラブ|倶楽部)|ストア|マート|(?<![A-Za-z])(?:Inc|LLC|Ltd|Limited|PBC|Corp|Corporation|GmbH|PLC|LLP|Pty|Pte)\b\.?|(?<![A-Za-z])[GK]\.\s?K\.|(?<![A-Za-z])GK\b)/;

// 「販売元」「発行元」等、取引先名の直前に付くことが多いラベル。存在する場合は
// これを最優先の手がかりとする(請求書には自社・決済代行会社・実際の販売元など
// 複数の会社名が登場することが多く、単純な最初/最長一致では取り違えやすいため)。
// 外資系(AWS等)の請求書の「サービスプロバイダー」「Service Provider」「Seller」も同様に扱う。
// Amazonビジネスの適格請求書の「発行者 アマゾンジャパン合同会社」の「発行者」も同様に扱う。
const VENDOR_LABEL_KEYWORDS = ['販売元', '発行元', '発行者', '差出人', 'お支払い先', 'サービスプロバイダー', 'Service Provider', 'Seller'];
// ラベルと取引先名が同じ行に書かれている場合に、取引先名からラベル部分を取り除くためのパターン
const VENDOR_LABEL_PREFIX_PATTERN = new RegExp(
  `^(?:${VENDOR_LABEL_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:：]?\\s*`,
  'i'
);

// 取引先名の末尾に付く敬称(御中/様/殿/各位)を除去する
// (OCRが「様」を異体字の「樣」と読むことがあるため、以降の敬称の判定ではどちらも扱う)
const HONORIFIC_SUFFIX_PATTERN = /\s*(御中|様|樣|殿|各位)\s*$/;

function stripHonorific(name) {
  return name.replace(HONORIFIC_SUFFIX_PATTERN, '').trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 自社名(.envのOWN_COMPANY_NAME)を含む行は「取引先」候補から除外する。
// 請求書の宛先(自社)を取引先として誤って採用しないようにするため。
// OCRが「株式会社 ユリーカ」のように法人格と名前の間に空白を入れることがあるため、空白を無視して比べる。
function isOwnCompany(line) {
  const ownName = process.env.OWN_COMPANY_NAME;
  if (!ownName) return false;
  const removeSpaces = (s) => s.replace(/[\s　]/g, '');
  return removeSpaces(line).includes(removeSpaces(ownName));
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
  // メールアドレス・URLの行(support@example.inc 等)は会社名ではない
  if (/@|https?:|www\./i.test(line)) return false;
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

// 郵便番号だけの行。OCRが「〒」を「T」「+」と読み違えることがあるため、それらも許容する
const POSTAL_CODE_LINE_PATTERN = /^[〒T+]?\s*\d{3}-?\d{4}$/;
// 個人の氏名らしい行(漢字の姓 + 空白任意 + 漢字・かなの名、例: 「武田 正利」)
const PERSON_NAME_PATTERN = /^[一-鿿々]{1,4}[\s　]?[一-鿿々ぁ-んァ-ヶ]{1,4}$/;
// 氏名と同じ字数の漢字だけでできた項目名(「作成基準日」「請求書」「登録番号」等)は氏名ではない
const ITEM_LABEL_PATTERN = /[日表書]$|基準|番号|金額|住所|所在地|担当/;

function findIndividualIssuer(lines) {
  for (let i = 1; i < lines.length; i += 1) {
    if (!POSTAL_CODE_LINE_PATTERN.test(lines[i])) continue;
    const name = lines[i - 1];
    // 姓と名の間の空白は、書類によって有無が異なるため取り除いて「武田正利」に揃える
    if (PERSON_NAME_PATTERN.test(name) && !ITEM_LABEL_PATTERN.test(name) && !isOwnCompany(name)) {
      return name.replace(/[\s　]/g, '');
    }
  }
  return null;
}

// 社印や罫線に重なった「株式会社」をOCRが「*社」のように記号と断片で読んだもの(名称の前に付いた場合)
const GARBLED_LEGAL_ENTITY_PREFIX_PATTERN = /^[*＊]+\s*(?:株?式?会?社)?\s*/;
const BANK_NAME_PATTERN = /銀行|信用金庫|信用組合|労働金庫/;
// 「〒100-8792 日本郵便株式会社」のように、発行元の郵便番号と名称が同じ行に読み取られた場合の先頭の郵便番号
const LEADING_POSTAL_CODE_PATTERN = /^(?:〒\s*\d{3}-?\d{4}|\d{3}-\d{4})\s+/;

function extractVendor(text) {
  const lines = text
    .split('\n')
    .map((l) => stripHonorific(l.trim()))
    .filter(Boolean);
  const toVendorName = (line) =>
    line
      .replace(VENDOR_LABEL_PREFIX_PATTERN, '')
      .replace(LEADING_POSTAL_CODE_PATTERN, '')
      .replace(GARBLED_LEGAL_ENTITY_PREFIX_PATTERN, '')
      .slice(0, 60);

  // 「販売元」等のラベルが明示されていれば、それを最優先で採用する
  const labeled = findVendorNearLabel(lines);
  if (labeled) return toVendorName(labeled);

  // ラベルが無い場合は、条件を満たす最初のヒント一致行を採用する
  const hinted = lines.find(isValidVendorCandidate);
  if (hinted) return toVendorName(hinted);

  // 個人事業主の請求書は「株式会社」等の手がかりが無いため、発行者欄の「氏名 → 郵便番号 → 住所」の並びから氏名を探す
  const individual = findIndividualIssuer(lines);
  if (individual) return individual;

  // 銀行等の金融機関が発行した領収書(手数料等)。請求書の振込先の銀行名を取引先と取り違えないよう、
  // 会社名の手がかりが他に無い場合だけ使い、支店名や振込の案内が付いた行は除く
  const bank = lines.find(
    (l) => BANK_NAME_PATTERN.test(l) && !/支店|出張所|営業部|振込|口座/.test(l) && l.length <= 20 && !isOwnCompany(l)
  );
  if (bank) return toVendorName(bank);

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
  { label: '返済予定表', pattern: /返済予定表/ },
  { label: '見積書', pattern: /見積書|Quotation|Estimate/i },
  { label: '納品書', pattern: /納品書|Delivery\s*Note|Packing\s*(?:Slip|List)/i },
  // 税金の納付明細・納付書(銀行経由で納付する住民税等)も支払を求める書類として請求書に分類する
  { label: '請求書', pattern: /請求書|Invoice|納付明細|納付書/i },
  { label: '領収書', pattern: /領収書|レシート|Receipt/i },
  { label: '契約書', pattern: /契約書/ },
  { label: '注文書', pattern: /注文書|発注書|Purchase\s*Order/i },
  { label: '検収書', pattern: /検収書/ },
];

// 「請求書番号」「品目・納品書番号」「Invoice number」のような項目名の一部は書類種別の判定に使わない
const DOCUMENT_TYPE_COMPOUND_SUFFIX = /^\s*(?:番号|No|NO|№)|^\s+(?:number|no\.?|#|date|id)\b/i;

// 書類種別を判定する。1枚の書類に複数の種別名が登場すること(請求書の明細列に
// 「納品書番号」がある等)があるため、パターンの並び順ではなく次の順で決める:
//   1. 種別名だけが書かれた行(=書類のタイトル。「請 求 書」「御請求書」も可)
//   2. 項目名の一部(〜番号等)を除き、文書中で最も先に登場する種別名
//   3. どれにも該当しなければ「その他」(SharePointの書類種別の選択肢にある)
function extractDocumentType(text) {
  for (const line of text.split('\n')) {
    const title = line.replace(/[\s　]/g, '').replace(/^[御ご]/, '');
    const found = DOCUMENT_TYPE_PATTERNS.find(({ pattern }) => {
      const m = title.match(pattern);
      return m && m[0] === title;
    });
    if (found) return found.label;
  }

  let earliest = null;
  for (const { label, pattern } of DOCUMENT_TYPE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
      if (DOCUMENT_TYPE_COMPOUND_SUFFIX.test(text.slice(m.index + m[0].length))) continue;
      if (earliest === null || m.index < earliest.index) earliest = { index: m.index, label };
      break;
    }
  }
  return earliest ? earliest.label : 'その他';
}

// 授受区分(受領/発行)を、自社名(.envのOWN_COMPANY_NAME)の書かれ方だけで判定する
// (文書中の「受領」「発行」等の文言は判定に使わない):
//   - 自社名が無い                                  → 受領(相手が発行した書類)
//   - 自社名のどれかが宛先として書かれている          → 受領
//     (「御中/様/殿/各位」の敬称付き、または英語の請求書の「Bill to」等の宛先欄の直後)
//   - 「発行者」「販売元」等の発行者欄に自社以外の会社が書かれている → 受領
//   - 自社名はあるが、宛先として書かれた箇所が無い    → 発行
const HONORIFIC_AFTER_NAME_PATTERN = /御中|様|樣|殿|各位/;
// 英語の請求書は宛先に敬称を付けないため、宛先欄の見出しの直後(2行以内)にあることで宛先と判断する
// (AWSのTax Invoiceは宛先欄の見出しが「Address:」、Google Cloudの請求書は「請求先」の後に担当者名・自社名が続く。
//  Amazonビジネスの適格請求書は「購入者住所」)
const RECIPIENT_FIELD_PATTERN = /Bill(?:ed)?\s*to|Sold\s*to|Invoice\s*to|^Address\s*:|^請求先$|^ご?購入者(?:住所|情報)?$|^お届け先(?:住所)?$/im;
const RECIPIENT_FIELD_LOOKBACK_LINES = 2;
// 「株式会社ユリーカ / 部署名 / 担当者名 様」のように、宛名の敬称が自社名の数行後(担当者名の後ろ)に
// 付くことがあるため、敬称で始まる行を自社名の後ろこの行数まで探す(左右の段の行が交互に並ぶ分も含む)
const RECIPIENT_HONORIFIC_LOOKAHEAD_LINES = 4;
const LEGAL_ENTITY_IN_NAME_PATTERN = /株式会社|有限会社|合同会社|[(（][株有][)）]|[㈱㈲]/g;

function extractExchangeType(text) {
  const ownName = process.env.OWN_COMPANY_NAME;
  if (!ownName) return null;
  // 「(株)ユリーカ」「ユリーカ御中」のように法人格の書き方が違っても見つけられるよう、法人格を除いた名前で探す
  const coreName = ownName.replace(LEGAL_ENTITY_IN_NAME_PATTERN, '').trim() || ownName;
  const lines = text.split('\n').map((l) => l.trim());

  const ownIndexes = lines.map((l, i) => (l.includes(coreName) ? i : -1)).filter((i) => i !== -1);
  if (ownIndexes.length === 0) return '受領';

  const isAddressedToOwn = (i) => {
    // 敬称は自社名と同じ行の後ろか、OCRで改行された後の行の先頭に付く
    // (間に別の会社名の行が現れたら、その敬称は別の会社の宛名なので探索をやめる)
    const rest = lines[i].slice(lines[i].indexOf(coreName) + coreName.length);
    if (HONORIFIC_AFTER_NAME_PATTERN.test(rest)) return true;
    for (let j = i + 1; j <= i + RECIPIENT_HONORIFIC_LOOKAHEAD_LINES && j < lines.length; j += 1) {
      // OCRが敬称の前に1文字余分に読むこと(「力樣」等)があるため、3文字以内の短い行なら敬称を含むだけでよい
      if (/^(?:御中|様|樣|殿|各位)/.test(lines[j]) || (lines[j].length <= 3 && HONORIFIC_AFTER_NAME_PATTERN.test(lines[j]))) {
        return true;
      }
      if (VENDOR_HINT_PATTERN.test(lines[j])) break;
    }
    const before = lines.slice(Math.max(0, i - RECIPIENT_FIELD_LOOKBACK_LINES), i).join('\n');
    return RECIPIENT_FIELD_PATTERN.test(before);
  };
  if (ownIndexes.some(isAddressedToOwn)) return '受領';
  return isIssuedByOtherCompany(lines, coreName) ? '受領' : '発行';
}

// 発行者欄の見出し(同じ行または直後2行)に書かれた会社が自社以外であれば、相手が発行した書類とみなす。
// 自社の宛名に敬称や宛先欄の見出しが付いていない書類(Amazonビジネスの適格請求書等)を受領と判定するため。
const ISSUER_LABEL_PATTERN = /発行者|発行元|販売元|Seller|Issued\s+by/i;
const ISSUER_LOOKAHEAD_LINES = 2;

function isIssuedByOtherCompany(lines, ownCoreName) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!ISSUER_LABEL_PATTERN.test(lines[i])) continue;
    for (let j = i; j <= i + ISSUER_LOOKAHEAD_LINES && j < lines.length; j += 1) {
      if (!VENDOR_HINT_PATTERN.test(lines[j])) continue;
      if (!lines[j].includes(ownCoreName)) return true;
      break; // 発行者欄に自社名が書かれている(自社が発行した書類)
    }
  }
  return false;
}

// OCR結果に全角数字・全角カンマが含まれることがあるため、金額・日付の数値解析の前に半角へ統一する。
// また、OCRが「税」を異体字の「稅」と読むことがあるため(「消費稅」等)、キーワードの判定前に統一する
function normalizeOcrText(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',')
    .replace(/稅/g, '税');
}

// 抽出できなかった(文字が無い・抽出をスキップした)場合の結果
const EMPTY_EXTRACTION = Object.freeze({
  date: null,
  dueDate: null,
  vendor: null,
  amount: null,
  documentType: null,
  exchangeType: null,
  periodStart: null,
  periodEnd: null,
  closingDate: null,
  // 取引先を登録番号からインボイスWeb-APIで取得した場合はその登録番号(画面に出典として表示する)
  vendorRegistrationNumber: null,
});

// 1ページ目に書かれた登録番号を照会し、自社以外で登録が有効な事業者の名称を、書類中の出現順で最初のものを返す。
// 2ページ目以降は添付の領収書(宿泊先等)の登録番号であることが多いため使わない。
async function findVendorByRegistrationNumber(firstPageText) {
  if (!isInvoiceLookupEnabled()) return null;
  const numbers = findRegistrationNumbers(firstPageText);
  if (numbers.length === 0) return null;
  const names = await lookupRegisteredNames(numbers);
  const number = numbers.find((n) => names[n] && !isOwnCompany(names[n]));
  return number ? { name: names[number], number } : null;
}

// allowRegistryLookup: 登録番号の照会(インボイスWeb-API)を行うか。公表情報の利用者を社員に限り、
// 照会した人を記録できるよう、サインイン済みの利用者のときだけtrueにする
async function extractReceiptData({ base64Data, mimeType, allowRegistryLookup = false }) {
  assertSupportedMime(mimeType);

  const pages = (mimeType === 'application/pdf'
    ? await readPdfPages(base64Data)
    : [await ocrImage(base64Data)]
  ).map(normalizeOcrText);
  const text = pages.filter(Boolean).join('\n');

  if (!text) {
    return { ...EMPTY_EXTRACTION };
  }

  const period = extractPeriod(text);
  const issueDate = extractIssueDate(text);
  const registered = allowRegistryLookup ? await findVendorByRegistrationNumber(pages[0]) : null;
  const result = {
    date: issueDate,
    dueDate: extractDueDate(text),
    vendor: registered?.name ?? extractVendor(text),
    vendorRegistrationNumber: registered?.number ?? null,
    amount: extractAmount(text),
    documentType: extractDocumentType(text),
    exchangeType: extractExchangeType(text),
    // 開始日・締日のどちらを使うかは書類種別で決まり、画面で書類種別を変更することもあるため、
    // ここでは候補となる日付だけを返し、選択と既定値(対象月の1日/末日)の補完は画面側で行う
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    closingDate: extractClosingDate(text, issueDate),
  };

  if (process.env.DEBUG_OCR === 'true') {
    console.log('--- [DEBUG_OCR] Vision APIのOCR結果(正規化後) ---');
    console.log(text);
    console.log('--- [DEBUG_OCR] 抽出結果 ---', result);
  }

  return result;
}

module.exports = { extractReceiptData, EMPTY_EXTRACTION };
