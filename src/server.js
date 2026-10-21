require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const { registerAuthRoutes, getAccessToken } = require('./auth');
const FileSessionStore = require('./session-store');
const { extractReceiptData, EMPTY_EXTRACTION } = require('./extract');
const { recordLookup } = require('./invoice-registry');
const { embedMetadata, buildSummary } = require('./metadata');
const {
  ensureFolderPath,
  getItemFullPath,
  findItemByPath,
  uploadFile,
  setDescription,
  listSharedFolders,
  getSharedWithMeRaw,
  resolveSharingUrl,
  getListColumns,
  guessColumnMapping,
  setListItemFields,
  resetVersionHistory,
  getFolderItem,
  getItemById,
  deleteItem,
  copyItemAndWait,
  getListItemPropertiesUrl,
  buildFileOpenUrl,
} = require('./graph');
const {
  loadTargetFolder,
  saveTargetFolder,
  clearTargetFolder,
  saveColumnMapping,
  loadHistory,
  recordHistory,
  addOrReplaceHistory,
} = require('./config-store');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// certs/cert.pem・certs/key.pem が存在すればHTTPSで待ち受ける(scripts/generate-cert.js参照)。
// 社内の他端末からアクセスする場合、Entra ID(Azure AD)のredirect_uriはlocalhost以外だと
// HTTPS必須のため、常時稼働サーバーとして使う場合はこの証明書生成が必要になる。
const CERT_PATH = path.join(__dirname, '..', 'certs', 'cert.pem');
const KEY_PATH = path.join(__dirname, '..', 'certs', 'key.pem');
const useHttps = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);

// アップロード直後の抽出結果を、ユーザーが確認・修正してから保存するまで一時保持する
const pendingUploads = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingUploads) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingUploads.delete(id);
  }
}, 5 * 60 * 1000).unref();

app.use(express.json());
app.use(
  session({
    store: new FileSessionStore(),
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    // サーバー再起動を挟んでもサインイン状態を維持できるよう、セッション(≒サインイン)を
    // 長期間(30日)有効にする。実際のMicrosoft365サインインの有効期限はMSALのリフレッシュ
    // トークンキャッシュ(msal-cache.js)側に依存する。
    cookie: { httpOnly: true, secure: useHttps, maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
);
app.use(express.static(path.join(__dirname, '..', 'public')));

registerAuthRoutes(app);

function sanitizeFileNamePart(value, fallback) {
  const str = (value == null ? '' : String(value)).trim();
  const cleaned = str.replace(/[\\/:*?"<>| -]/g, '_');
  return cleaned || fallback;
}

// ファイル名の自動生成では取引先名から法人格(株式会社・(株)等)を除外する。
// 取引先プロパティ(SharePoint列)には法人格付きのまま書き込むため、ファイル名専用の整形。
const LEGAL_ENTITY_PATTERN =
  /株式会社|有限会社|合同会社|合資会社|合名会社|(?:一般|公益)(?:社団|財団)法人|特定非営利活動法人|NPO法人|医療法人(?:社団|財団)?|社会福祉法人|学校法人|宗教法人|地方独立行政法人|独立行政法人|国立大学法人|税理士法人|弁護士法人|監査法人|司法書士法人|行政書士法人|社会保険労務士法人|[(（](?:株|有|同|合|資|名|社|財|医|福|学|特非)[)）]|[㈱㈲㈳㈶]|,?\s*(?:Co\.,?\s*Ltd\.?|Inc\.?|Corp\.?|Corporation|LLC|Ltd\.?|Limited|PBC|PLC|LLP|GmbH|[GK]\.\s?K\.)$/gi;
function stripLegalEntity(name) {
  if (name == null) return name;
  const original = String(name);
  const stripped = original.replace(LEGAL_ENTITY_PATTERN, '').replace(/^[\s　]+|[\s　]+$/g, '');
  // 法人格だけの名前(除去すると空になる)は元のまま使う
  return stripped || original;
}

// ファイル名用に日付「YYYY-MM-DD」を「yymmdd」形式(西暦下2桁・区切り文字なし)にする。
// sanitizeFileNamePartは「-」を「_」に変換してしまうため、先にハイフンを除去してから渡す。
function formatDateForFileName(date) {
  const stripped = date == null ? date : String(date).replace(/-/g, '').replace(/^\d{2}(?=\d{6}$)/, '');
  return sanitizeFileNamePart(stripped, '日付不明');
}

// customBase(ユーザーが手入力したファイル名)が指定されていればそれを優先し、
// 未指定の場合のみ取引先(法人格を除く)_日付から自動生成する。日付は支払期限があればそれを、
// 無ければ取引年月日を使う。拡張子は常に自動付与。
function buildFileName({ date, dueDate, vendor }, ext, customBase) {
  if (customBase && customBase.trim()) {
    return `${sanitizeFileNamePart(customBase, 'ファイル名不明')}${ext}`;
  }
  const vendorPart = sanitizeFileNamePart(stripLegalEntity(vendor), '取引先不明');
  const datePart = formatDateForFileName(dueDate || date);
  return `${vendorPart}_${datePart}${ext}`;
}

function buildColumnPayload(columnMapping, fields) {
  if (!columnMapping) return {};
  const payload = {};
  if (columnMapping.date && fields.date) {
    payload[columnMapping.date] = `${fields.date}T00:00:00Z`;
  }
  if (columnMapping.vendor && fields.vendor) {
    payload[columnMapping.vendor] = fields.vendor;
  }
  if (columnMapping.amount && fields.amount != null) {
    payload[columnMapping.amount] = fields.amount;
  }
  if (columnMapping.exchangeType && fields.exchangeType) {
    payload[columnMapping.exchangeType] = fields.exchangeType;
  }
  if (columnMapping.documentType && fields.documentType) {
    payload[columnMapping.documentType] = fields.documentType;
  }
  if (columnMapping.periodDate && fields.periodDate) {
    payload[columnMapping.periodDate] = `${fields.periodDate}T00:00:00Z`;
  }
  if (columnMapping.exchangeMethod && fields.exchangeMethod) {
    payload[columnMapping.exchangeMethod] = fields.exchangeMethod;
  }
  if (columnMapping.paymentMethod && fields.paymentMethod) {
    payload[columnMapping.paymentMethod] = fields.paymentMethod;
  }
  if (columnMapping.paymentDate && fields.paymentDate) {
    payload[columnMapping.paymentDate] = `${fields.paymentDate}T00:00:00Z`;
  }
  if (columnMapping.journalStatus && fields.journalStatus) {
    payload[columnMapping.journalStatus] = fields.journalStatus;
  }
  if (columnMapping.remarks && fields.remarks) {
    payload[columnMapping.remarks] = fields.remarks;
  }
  return payload;
}

// SharePointドキュメントライブラリのカスタム列(取引日付/取引先/取引金額)に値を書き込む。
// 列が未設定(自分のOneDrive、または列の対応付けが完了していない共有フォルダ)の場合は何もしない。
async function writeLibraryColumns(accessToken, driveItem, columnMapping, fields) {
  if (!columnMapping) return { attempted: false };

  const payload = buildColumnPayload(columnMapping, fields);

  if (Object.keys(payload).length === 0) {
    return { attempted: false };
  }

  await setListItemFields(accessToken, driveItem, payload);
  return { attempted: true };
}

function extFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルが指定されていません' });
    }
    const { buffer, mimetype, originalname } = req.file;
    const skipExtract = req.body.skipExtract === 'true';
    const extracted = skipExtract
      ? { ...EMPTY_EXTRACTION }
      : await extractReceiptData({
          base64Data: buffer.toString('base64'),
          mimeType: mimetype,
          allowRegistryLookup: Boolean(req.session.account),
        });
    if (extracted.vendorRegistrationNumber) {
      recordLookup({
        username: req.session.account.username,
        registrationNumber: extracted.vendorRegistrationNumber,
        name: extracted.vendor,
      });
    }

    const id = crypto.randomUUID();
    pendingUploads.set(id, {
      buffer,
      mimeType: mimetype,
      originalName: originalname,
      createdAt: Date.now(),
    });

    res.json({ id, ...extracted, mimeType: mimetype });
  } catch (err) {
    console.error('extract error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  let accessToken;
  let stagedItem = null;
  try {
    const {
      id,
      date,
      vendor,
      amount,
      exchangeType,
      documentType,
      periodDate,
      exchangeMethod,
      paymentMethod,
      paymentDate,
      journalStatus,
      remarks,
      dueDate,
      fileName: customFileNameBase,
      overwrite,
    } = req.body;
    const entry = pendingUploads.get(id);
    if (!entry) {
      return res.status(400).json({ error: 'アップロード情報が見つかりません。もう一度画像を選択してください。' });
    }

    try {
      accessToken = await getAccessToken(req);
    } catch (err) {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }

    const amountNum = amount === '' || amount == null ? null : Number(amount);
    const fields = {
      date: date || null,
      vendor: vendor || null,
      amount: Number.isNaN(amountNum) ? null : amountNum,
      exchangeType: exchangeType || null,
      documentType: documentType || null,
      periodDate: periodDate || null,
      exchangeMethod: exchangeMethod || null,
      paymentMethod: paymentMethod || null,
      paymentDate: paymentDate || null,
      journalStatus: journalStatus || null,
      remarks: remarks || null,
    };

    const embeddedBuffer = await embedMetadata(entry.buffer, entry.mimeType, fields);
    const ext = extFromMime(entry.mimeType) || path.extname(entry.originalName) || '';
    const fileName = buildFileName({ ...fields, dueDate: dueDate || null }, ext, customFileNameBase);
    const subPath = process.env.ONEDRIVE_TARGET_FOLDER || '';
    const target = loadTargetFolder(req.session); // null = 自分のOneDrive / {driveId,itemId,name} = 共有フォルダ
    const summary = buildSummary(fields);
    const columnMapping = target && target.columnMapping;

    // 保存先に同名ファイルが既に存在する場合、overwriteが明示的に指定されていなければ
    // 何もせず確認を促す(フロント側でユーザーに上書き可否を確認してから再送信してもらう)。
    const existingItem = await findItemByPath(accessToken, target, subPath, fileName);
    if (existingItem && overwrite !== true) {
      return res.status(409).json({ error: 'FILE_EXISTS', fileName });
    }

    await ensureFolderPath(accessToken, subPath, target);

    let driveItem;
    let updatedItem;
    let columnsWritten = false;
    let columnsError = null;

    if (target && target.driveId) {
      // 共有フォルダ(SharePointドキュメントライブラリ)の場合:
      // 一時フォルダにアップロードしてdescription/列をすべて設定したあと、本番フォルダへ
      // 「コピー」する。コピー結果は新規アイテム扱いになりSharePointのバージョン履歴が
      // 1.0からやり直しになるため、最終的にバージョンが1.0のみになることを狙う。
      const stagingSubPath = `${subPath}/_staging`;
      await ensureFolderPath(accessToken, stagingSubPath, target);

      const tempName = `${crypto.randomUUID()}${ext}`;
      stagedItem = await uploadFile(accessToken, target, stagingSubPath, tempName, embeddedBuffer);
      const stagingDriveId = stagedItem.parentReference.driveId;

      await setDescription(accessToken, stagedItem, summary);
      try {
        await writeLibraryColumns(accessToken, stagedItem, columnMapping, fields);
      } catch (err) {
        console.error('list column write error (staging)', err);
      }

      const destFolder = await getFolderItem(accessToken, subPath, target);

      // コピーAPIは同名アイテムが既に存在すると失敗するため、上書きが確定している場合は
      // 先に既存アイテムを削除しておく(存在確認は上でfindItemByPathにより済んでいる)。
      if (existingItem) {
        await deleteItem(accessToken, existingItem.parentReference.driveId, existingItem.id);
      }

      const copiedItemId = await copyItemAndWait(accessToken, stagedItem, stagingDriveId, destFolder.id, fileName);
      driveItem = await getItemById(accessToken, stagingDriveId, copiedItemId);

      // コピーはdescription/列の値もそのまま引き継ぐため、コピー後に設定し直す必要はない
      // (引き継がれていることを確認済み。ここで再設定するとバージョンが2.0に増えてしまう)
      updatedItem = driveItem;
      columnsWritten = Object.keys(buildColumnPayload(columnMapping, fields)).length > 0;

      // 一時フォルダのファイルは不要なので削除する(失敗しても保存自体には影響しない)
      try {
        await deleteItem(accessToken, stagingDriveId, stagedItem.id);
      } catch (err) {
        console.error('staging item cleanup error', err);
      }
      stagedItem = null;
    } else {
      // 自分のOneDrive(個人用など): コピーの裏技は使わず、従来通り直接保存する
      driveItem = await uploadFile(accessToken, target, subPath, fileName, embeddedBuffer);
      updatedItem = await setDescription(accessToken, driveItem, summary);
      try {
        const result = await writeLibraryColumns(accessToken, driveItem, columnMapping, fields);
        columnsWritten = result.attempted;
      } catch (err) {
        console.error('list column write error', err);
        columnsError = err.message;
      }
    }

    // 念のため、最終アイテムに余分なバージョンが残っていれば削除しておく
    let versionsReset = false;
    let versionsError = null;
    try {
      const result = await resetVersionHistory(accessToken, driveItem);
      versionsReset = result.attempted;
    } catch (err) {
      console.error('reset version history error', err);
      versionsError = err.message;
    }

    pendingUploads.delete(id);

    // プロパティ(SharePointリストアイテム)編集画面へのリンクも取得する。
    // あくまで補助情報のため、失敗しても保存自体は成功として扱う(fail-soft)。
    let propertiesUrl = null;
    try {
      propertiesUrl = await getListItemPropertiesUrl(accessToken, driveItem);
    } catch (err) {
      console.error('get listItem webUrl error', err);
    }

    // ファイルを開くリンクは、保存先フォルダへのアクセス権を持つ人だけが開ける
    // OneDriveの標準プレビューURL形式を使う(クリックして開いたときと同じ挙動)。
    // ※createLinkによる共有リンクの新規作成はファイル単位で新たな閲覧権限を
    // 付与してしまう(フォルダのアクセス権が無い人でもリンクさえ知っていれば開けてしまう)ため、
    // 意図的に使わない方針とした。
    const openUrl = buildFileOpenUrl(driveItem);

    // 実際にOneDrive側に反映されたdescriptionの値をそのまま返し、
    // プロパティが本当に設定されたかをアプリ画面上で確認できるようにする
    res.json({
      webUrl: openUrl,
      propertiesUrl,
      name: driveItem.name,
      savedDescription: updatedItem.description || null,
      columnsWritten,
      columnsError,
      versionsReset,
      versionsError,
    });
  } catch (err) {
    console.error('save error', err);
    // 途中で失敗した場合、一時フォルダに残ったファイルを掃除しておく
    if (stagedItem && accessToken) {
      const stagingDriveId = stagedItem.parentReference && stagedItem.parentReference.driveId;
      if (stagingDriveId) {
        try {
          await deleteItem(accessToken, stagingDriveId, stagedItem.id);
        } catch (cleanupErr) {
          console.error('staging cleanup after error failed', cleanupErr);
        }
      }
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/target-folder', async (req, res) => {
  const target = loadTargetFolder(req.session);
  const history = loadHistory(req.session);
  if (!target) return res.json({ mode: 'own', history });

  // 上位フォルダ名まで含めた表示用のフルパスを取得する。あくまで表示の補助情報なので、
  // 未サインイン等で取得に失敗してもエラーにはせず、フォルダ名のみの表示にフォールバックする。
  let fullPath = null;
  try {
    const accessToken = await getAccessToken(req);
    fullPath = await getItemFullPath(accessToken, target.driveId, target.itemId);
    if (fullPath) {
      // ラジオボタンでの表示用に、履歴側のキャッシュも最新のフルパスへ更新しておく
      recordHistory(req.session, { mode: 'shared', driveId: target.driveId, itemId: target.itemId, name: target.name, fullPath });
    }
  } catch (err) {
    // NOT_SIGNED_IN等。fullPathはnullのままにする
  }

  res.json({ mode: 'shared', ...target, fullPath, history: loadHistory(req.session) });
});

// 保存先(共有フォルダ)がSharePointドキュメントライブラリの場合に、
// 取引日付/取引先/取引金額に対応しそうな列を自動検出し、対応付けを保存する
// 列が「選択肢」型の場合、SharePoint側に設定済みの選択肢一覧を取得してUIのドロップダウンに使う。
// 選択肢型でない(自由入力の文字列列)場合や列が未検出の場合はドロップダウン化しない。
function extractChoiceInfo(column) {
  const choices =
    column && column.type === 'choice' && column.details && Array.isArray(column.details.choices)
      ? column.details.choices
      : [];
  const allowsFreeText = column ? (column.type === 'choice' ? !!(column.details && column.details.allowTextEntry) : true) : null;
  return { choices, allowsFreeText };
}

app.post('/api/target-folder/detect-columns', async (req, res) => {
  try {
    const accessToken = await getAccessToken(req);
    const target = loadTargetFolder(req.session);
    if (!target || !target.driveId) {
      return res.status(400).json({ error: '共有フォルダが設定されていません' });
    }
    const columns = await getListColumns(accessToken, target.driveId);
    const {
      vendorColumn,
      exchangeTypeColumn,
      documentTypeColumn,
      exchangeMethodColumn,
      paymentMethodColumn,
      journalStatusColumn,
      ...mapping
    } = guessColumnMapping(columns);

    const vendorInfo = extractChoiceInfo(vendorColumn);
    const exchangeTypeInfo = extractChoiceInfo(exchangeTypeColumn);
    const documentTypeInfo = extractChoiceInfo(documentTypeColumn);
    const exchangeMethodInfo = extractChoiceInfo(exchangeMethodColumn);
    const paymentMethodInfo = extractChoiceInfo(paymentMethodColumn);
    const journalStatusInfo = extractChoiceInfo(journalStatusColumn);

    const fullMapping = {
      ...mapping,
      vendorChoices: vendorInfo.choices,
      vendorAllowsFreeText: vendorInfo.allowsFreeText,
      exchangeTypeChoices: exchangeTypeInfo.choices,
      exchangeTypeAllowsFreeText: exchangeTypeInfo.allowsFreeText,
      documentTypeChoices: documentTypeInfo.choices,
      documentTypeAllowsFreeText: documentTypeInfo.allowsFreeText,
      exchangeMethodChoices: exchangeMethodInfo.choices,
      exchangeMethodAllowsFreeText: exchangeMethodInfo.allowsFreeText,
      paymentMethodChoices: paymentMethodInfo.choices,
      paymentMethodAllowsFreeText: paymentMethodInfo.allowsFreeText,
      journalStatusChoices: journalStatusInfo.choices,
      journalStatusAllowsFreeText: journalStatusInfo.allowsFreeText,
    };
    saveColumnMapping(req.session, fullMapping);
    let fullPath = null;
    try {
      fullPath = await getItemFullPath(accessToken, target.driveId, target.itemId);
    } catch (err) {
      // 表示補助情報のため取得失敗は無視する
    }
    recordHistory(req.session, {
      mode: 'shared',
      driveId: target.driveId,
      itemId: target.itemId,
      name: target.name,
      columnMapping: fullMapping,
      ...(fullPath ? { fullPath } : {}),
    });
    res.json({ mapping: fullMapping, columns });
  } catch (err) {
    if (err.message === 'NOT_SIGNED_IN') {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }
    console.error('detect-columns error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shared-folders', async (req, res) => {
  try {
    const accessToken = await getAccessToken(req);
    const folders = await listSharedFolders(accessToken);
    res.json({ folders });
  } catch (err) {
    if (err.message === 'NOT_SIGNED_IN') {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }
    console.error('shared-folders error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/target-folder', async (req, res) => {
  const { driveId, itemId, name } = req.body;
  if (!driveId || !itemId) {
    return res.status(400).json({ error: 'driveIdとitemIdが必要です' });
  }
  saveTargetFolder(req.session, { driveId, itemId, name });
  let fullPath = null;
  try {
    const accessToken = await getAccessToken(req);
    fullPath = await getItemFullPath(accessToken, driveId, itemId);
  } catch (err) {
    // 表示補助情報のため取得失敗は無視する
  }
  // 履歴が満杯の場合、登録が最も古い保存先と入れ替える
  addOrReplaceHistory(req.session, { mode: 'shared', driveId, itemId, name, ...(fullPath ? { fullPath } : {}) });
  res.json({ mode: 'shared', driveId, itemId, name });
});

app.post('/api/target-folder/reset', (req, res) => {
  clearTargetFolder(req.session);
  addOrReplaceHistory(req.session, { mode: 'own' });
  res.json({ mode: 'own' });
});

app.post('/api/target-folder/from-link', async (req, res) => {
  try {
    const accessToken = await getAccessToken(req);
    const { url } = req.body;
    const resolved = await resolveSharingUrl(accessToken, url);
    saveTargetFolder(req.session, { driveId: resolved.driveId, itemId: resolved.itemId, name: resolved.name });
    let fullPath = null;
    try {
      fullPath = await getItemFullPath(accessToken, resolved.driveId, resolved.itemId);
    } catch (err) {
      // 表示補助情報のため取得失敗は無視する
    }
    addOrReplaceHistory(
      req.session,
      {
        mode: 'shared',
        driveId: resolved.driveId,
        itemId: resolved.itemId,
        name: resolved.name,
        ...(fullPath ? { fullPath } : {}),
      }
    );
    res.json({ mode: 'shared', ...resolved });
  } catch (err) {
    if (err.message === 'NOT_SIGNED_IN') {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }
    console.error('target-folder/from-link error', err);
    res.status(500).json({ error: err.message });
  }
});

// 記憶済みの保存先(最大MAX_HISTORY件)への即時切り替え。既にdriveId/itemId/columnMappingが
// history側にキャッシュされているため、Graph呼び出しなしで即座に切り替えられる。
app.post('/api/target-folder/select', (req, res) => {
  const { mode, driveId, itemId } = req.body;
  if (mode === 'own') {
    clearTargetFolder(req.session);
    recordHistory(req.session, { mode: 'own' });
    return res.json({ mode: 'own' });
  }
  if (mode !== 'shared' || !driveId || !itemId) {
    return res.status(400).json({ error: 'mode/driveId/itemIdが必要です' });
  }
  const entry = loadHistory(req.session).find((e) => e.mode === 'shared' && e.driveId === driveId && e.itemId === itemId);
  if (!entry) {
    return res.status(404).json({ error: '記憶されている保存先が見つかりません' });
  }
  saveTargetFolder(req.session, { driveId: entry.driveId, itemId: entry.itemId, name: entry.name, columnMapping: entry.columnMapping });
  recordHistory(req.session, entry);
  res.json({ mode: 'shared', ...entry });
});

// デバッグ用: Graphの/me/drive/sharedWithMeの生レスポンスをそのまま確認するためのエンドポイント
app.get('/api/debug/shared-with-me', async (req, res) => {
  try {
    const accessToken = await getAccessToken(req);
    const raw = await getSharedWithMeRaw(accessToken);
    res.json(raw);
  } catch (err) {
    if (err.message === 'NOT_SIGNED_IN') {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }
    res.status(500).json({ error: err.message });
  }
});

// デバッグ用: 現在の保存先(共有フォルダ)がSharePointドキュメントライブラリの場合に、
// そのライブラリに定義されている列(カスタムプロパティ)の一覧を確認するためのエンドポイント
app.get('/api/debug/list-columns', async (req, res) => {
  try {
    const accessToken = await getAccessToken(req);
    const target = loadTargetFolder(req.session);
    if (!target || !target.driveId) {
      return res.status(400).json({
        error: '共有フォルダが設定されていません。先に「変更」から共有フォルダを設定してください。',
      });
    }
    const columns = await getListColumns(accessToken, target.driveId);
    res.json({ driveId: target.driveId, columns });
  } catch (err) {
    if (err.message === 'NOT_SIGNED_IN') {
      return res.status(401).json({ error: 'NOT_SIGNED_IN' });
    }
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (useHttps) {
  const options = { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`ebr-app listening at https://localhost:${PORT} (HTTPS, certs/配下の証明書を使用)`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`ebr-app listening at http://localhost:${PORT}`);
  });
}
