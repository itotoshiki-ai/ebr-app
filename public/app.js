const authStatus = document.getElementById('authStatus');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const statusArea = document.getElementById('statusArea');
const reviewArea = document.getElementById('reviewArea');
const previewArea = document.getElementById('previewArea');
const previewImg = document.getElementById('previewImg');
const previewPdf = document.getElementById('previewPdf');
const previewPdfEmbed = document.getElementById('previewPdfEmbed');
const pdfName = document.getElementById('pdfName');
const reviewForm = document.getElementById('reviewForm');
const fieldDate = document.getElementById('fieldDate');
const fieldVendor = document.getElementById('fieldVendor');
const fieldVendorSelect = document.getElementById('fieldVendorSelect');
const vendorChoicesList = document.getElementById('vendorChoicesList');
const vendorNoMatchHint = document.getElementById('vendorNoMatchHint');
const refreshVendorListBtn = document.getElementById('refreshVendorListBtn');
const fieldAmount = document.getElementById('fieldAmount');
const fieldExchangeType = document.getElementById('fieldExchangeType');
const fieldExchangeTypeSelect = document.getElementById('fieldExchangeTypeSelect');
const exchangeTypeChoicesList = document.getElementById('exchangeTypeChoicesList');
const exchangeTypeNoMatchHint = document.getElementById('exchangeTypeNoMatchHint');
const fieldDocumentType = document.getElementById('fieldDocumentType');
const fieldDocumentTypeSelect = document.getElementById('fieldDocumentTypeSelect');
const documentTypeChoicesList = document.getElementById('documentTypeChoicesList');
const documentTypeNoMatchHint = document.getElementById('documentTypeNoMatchHint');
const fieldPeriodDate = document.getElementById('fieldPeriodDate');
const fieldExchangeMethod = document.getElementById('fieldExchangeMethod');
const fieldExchangeMethodSelect = document.getElementById('fieldExchangeMethodSelect');
const exchangeMethodChoicesList = document.getElementById('exchangeMethodChoicesList');
const exchangeMethodNoMatchHint = document.getElementById('exchangeMethodNoMatchHint');
const fieldPaymentMethod = document.getElementById('fieldPaymentMethod');
const fieldPaymentMethodSelect = document.getElementById('fieldPaymentMethodSelect');
const paymentMethodChoicesList = document.getElementById('paymentMethodChoicesList');
const paymentMethodNoMatchHint = document.getElementById('paymentMethodNoMatchHint');
const fieldPaymentDate = document.getElementById('fieldPaymentDate');
const fieldJournalStatus = document.getElementById('fieldJournalStatus');
const fieldJournalStatusSelect = document.getElementById('fieldJournalStatusSelect');
const journalStatusChoicesList = document.getElementById('journalStatusChoicesList');
const journalStatusNoMatchHint = document.getElementById('journalStatusNoMatchHint');
const fieldRemarks = document.getElementById('fieldRemarks');
const fieldFileName = document.getElementById('fieldFileName');
const cancelBtn = document.getElementById('cancelBtn');
const resultArea = document.getElementById('resultArea');
const resultFileNameText = document.getElementById('resultFileNameText');
const copyFileNameBtn = document.getElementById('copyFileNameBtn');
const resultLink = document.getElementById('resultLink');
const resultLinkText = document.getElementById('resultLinkText');
const copyResultLinkBtn = document.getElementById('copyResultLinkBtn');
const propertiesLinkRow = document.getElementById('propertiesLinkRow');
const propertiesLink = document.getElementById('propertiesLink');
const propertiesLinkText = document.getElementById('propertiesLinkText');
const copyPropertiesLinkBtn = document.getElementById('copyPropertiesLinkBtn');
const savedDescriptionText = document.getElementById('savedDescriptionText');
const resetBtn = document.getElementById('resetBtn');
const targetFolderLabel = document.getElementById('targetFolderLabel');
const changeTargetBtn = document.getElementById('changeTargetBtn');
const targetFolderHistory = document.getElementById('targetFolderHistory');
const folderPickerArea = document.getElementById('folderPickerArea');
const folderPickerList = document.getElementById('folderPickerList');
const useOwnDriveBtn = document.getElementById('useOwnDriveBtn');
const closePickerBtn = document.getElementById('closePickerBtn');
const shareLinkInput = document.getElementById('shareLinkInput');
const useShareLinkBtn = document.getElementById('useShareLinkBtn');
const loadSharedListBtn = document.getElementById('loadSharedListBtn');
const skipExtractCheckbox = document.getElementById('skipExtractCheckbox');
const columnMappingStatus = document.getElementById('columnMappingStatus');
const columnsWrittenText = document.getElementById('columnsWrittenText');
const versionsResetText = document.getElementById('versionsResetText');

let currentUploadId = null;
// ファイル名欄が「自動生成された初期値のまま」かどうか。trueの間は取引年月日・取引先の
// 変更に追従してファイル名を再生成する。ユーザーがファイル名を一度でも手入力したら
// falseにし、それ以降は上書きしない。
let fileNameIsDefault = true;

// SharePoint側の設定に応じて、入力欄を「選択式(自由入力不可)」「候補付き自由入力」
// 「素の自由入力」に切り替える汎用ヘルパー。取引先・授受区分・書類種別・授受手段・
// 支払方法・仕訳状況で共通利用する。
// required: falseにすると必須入力にしない(任意項目用)。
// defaultToFirstChoice: trueだと、値が空の状態で選択肢が取得できた時に先頭の選択肢を初期値にする。
function createChoiceField({ selectEl, textEl, datalistEl, noMatchHintEl, required = true, defaultToFirstChoice = false }) {
  let choices = [];
  let allowsFreeText = null; // null = 選択肢列ではない(自由入力の文字列項目 or 未検出)

  function isStrictSelect() {
    return choices.length > 0 && allowsFreeText === false;
  }

  function apply() {
    datalistEl.innerHTML = '';
    for (const choice of choices) {
      const opt = document.createElement('option');
      opt.value = choice;
      datalistEl.appendChild(opt);
    }

    const strictSelect = isStrictSelect();
    selectEl.hidden = !strictSelect;
    textEl.hidden = strictSelect;
    // hidden属性だけでは非表示側が入力必須チェックから除外されず、
    // 「非表示かつrequiredで空」の要素があるとブラウザがフォーカスできずに
    // 検証全体が失敗する(reportValidityがfalseのまま何も起きなくなる)ため、
    // 表示されている方にだけrequiredを付け替える。
    selectEl.required = required && strictSelect;
    textEl.required = required && !strictSelect;

    if (strictSelect) {
      selectEl.innerHTML = '';
      const blankOpt = document.createElement('option');
      blankOpt.value = '';
      blankOpt.textContent = '(選択してください)';
      selectEl.appendChild(blankOpt);
      for (const choice of choices) {
        const opt = document.createElement('option');
        opt.value = choice;
        opt.textContent = choice;
        selectEl.appendChild(opt);
      }
    }
  }

  function setChoices(newChoices, newAllowsFreeText) {
    // 選択肢の入れ替え(保存先フォルダの切り替え等)で、入力済みの値が消えないよう
    // 一旦退避してから、新しい選択肢構成に合わせて入力欄へ戻す。
    const previousValue = getValue();
    choices = newChoices || [];
    allowsFreeText = newAllowsFreeText != null ? newAllowsFreeText : null;
    apply();
    if (previousValue) {
      setValue(previousValue);
    } else if (defaultToFirstChoice && choices.length > 0) {
      setValue(choices[0]);
    }
  }

  function setValue(value) {
    if (noMatchHintEl) noMatchHintEl.hidden = true;
    if (isStrictSelect()) {
      const match = choices.find((c) => c === value) || choices.find((c) => c.toLowerCase() === (value || '').toLowerCase());
      selectEl.value = match || '';
      if (value && !match && noMatchHintEl) noMatchHintEl.hidden = false;
    } else {
      textEl.value = value || '';
    }
  }

  // アップロードのリセット時に使う。defaultToFirstChoiceが有効なら先頭の選択肢に戻し、
  // それ以外は空にする。
  function resetValue() {
    setValue(defaultToFirstChoice && choices.length > 0 ? choices[0] : '');
  }

  function getValue() {
    return isStrictSelect() ? selectEl.value : textEl.value;
  }

  function hasChoices() {
    return choices.length > 0;
  }

  return { setChoices, setValue, getValue, hasChoices, resetValue };
}

const vendorField = createChoiceField({
  selectEl: fieldVendorSelect,
  textEl: fieldVendor,
  datalistEl: vendorChoicesList,
  noMatchHintEl: vendorNoMatchHint,
});
const exchangeTypeField = createChoiceField({
  selectEl: fieldExchangeTypeSelect,
  textEl: fieldExchangeType,
  datalistEl: exchangeTypeChoicesList,
  noMatchHintEl: exchangeTypeNoMatchHint,
});
const documentTypeField = createChoiceField({
  selectEl: fieldDocumentTypeSelect,
  textEl: fieldDocumentType,
  datalistEl: documentTypeChoicesList,
  noMatchHintEl: documentTypeNoMatchHint,
});
const exchangeMethodField = createChoiceField({
  selectEl: fieldExchangeMethodSelect,
  textEl: fieldExchangeMethod,
  datalistEl: exchangeMethodChoicesList,
  noMatchHintEl: exchangeMethodNoMatchHint,
});
const paymentMethodField = createChoiceField({
  selectEl: fieldPaymentMethodSelect,
  textEl: fieldPaymentMethod,
  datalistEl: paymentMethodChoicesList,
  noMatchHintEl: paymentMethodNoMatchHint,
  required: false,
});
const journalStatusField = createChoiceField({
  selectEl: fieldJournalStatusSelect,
  textEl: fieldJournalStatus,
  datalistEl: journalStatusChoicesList,
  noMatchHintEl: journalStatusNoMatchHint,
  required: false,
  defaultToFirstChoice: true,
});

function showStatus(message, isError = false) {
  statusArea.hidden = false;
  statusArea.textContent = message;
  statusArea.classList.toggle('error', isError);
}

function clearStatus() {
  statusArea.hidden = true;
  statusArea.textContent = '';
}

async function refreshAuthStatus() {
  const res = await fetch('/api/session');
  const data = await res.json();
  if (data.signedIn) {
    authStatus.textContent = `サインイン中: ${data.username}`;
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
  } else {
    authStatus.textContent = '未サインイン';
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
  }
}

// SharePoint側はdriveItemのdescriptionプロパティをHTMLとして扱っており、
// ":"などの記号を"&#58;"のようなHTML実体参照に変換して保存・返却してくる。
// 表示用に元の文字に戻す(textContentへの代入なのでスクリプト実行のおそれはない)。
function decodeHtmlEntities(str) {
  if (!str) return str;
  const tmp = document.createElement('textarea');
  tmp.innerHTML = str;
  return tmp.value;
}

async function copyTextToClipboard(text, button) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
    }
    const original = button.textContent;
    button.textContent = 'コピーしました';
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch (err) {
    console.error('clipboard copy error', err);
    button.textContent = 'コピー失敗';
    setTimeout(() => {
      button.textContent = 'コピー';
    }, 1500);
  }
}

copyFileNameBtn.addEventListener('click', () => copyTextToClipboard(resultFileNameText.value, copyFileNameBtn));
copyResultLinkBtn.addEventListener('click', () => copyTextToClipboard(resultLinkText.value, copyResultLinkBtn));
copyPropertiesLinkBtn.addEventListener('click', () => copyTextToClipboard(propertiesLinkText.value, copyPropertiesLinkBtn));

function resetToDropZone() {
  currentUploadId = null;
  reviewArea.hidden = true;
  resultArea.hidden = true;
  previewArea.hidden = true;
  dropZone.hidden = false;
  clearStatus();
  fileInput.value = '';
  exchangeTypeField.setValue('');
  documentTypeField.setValue('');
  fieldPeriodDate.value = '';
  exchangeMethodField.setValue('');
  paymentMethodField.setValue('');
  fieldPaymentDate.value = '';
  journalStatusField.resetValue();
  fieldRemarks.value = '';
  fieldFileName.value = '';
  fileNameIsDefault = true;
}

// サーバー側のファイル名自動生成(取引先_取引日付)と同じ規則で、
// ファイル名入力欄の初期値(ユーザーが後から自由に編集できる)を作る
function sanitizeFileNamePartForPreview(value, fallback) {
  const str = (value == null ? '' : String(value)).trim();
  const cleaned = str.replace(/[\\/:*?"<>| -]/g, '_');
  return cleaned || fallback;
}
function buildDefaultFileNameBase(date, vendor) {
  const vendorPart = sanitizeFileNamePartForPreview(vendor, '取引先不明');
  // sanitizeFileNamePartForPreviewは「-」を「_」に変換してしまうため、
  // 先にハイフンを除去してから渡す(YYYYMMDD形式にするため)
  const strippedDate = date == null ? date : String(date).replace(/-/g, '');
  const datePart = sanitizeFileNamePartForPreview(strippedDate, '日付不明');
  return `${vendorPart}_${datePart}`;
}

// ファイル名欄が自動生成の初期値のままであれば、取引年月日・取引先の現在の入力内容で
// 再生成する。ユーザーがファイル名を手入力していたら(fileNameIsDefault===false)何もしない。
function refreshDefaultFileNameIfUntouched() {
  if (!fileNameIsDefault) return;
  fieldFileName.value = buildDefaultFileNameBase(fieldDate.value, vendorField.getValue());
}

async function handleFile(file) {
  if (!file) return;
  clearStatus();
  dropZone.hidden = true;
  resultArea.hidden = true;
  const skipExtract = skipExtractCheckbox.checked;
  showStatus(
    skipExtract ? 'アップロード中...(AI抽出はスキップします)' : '画像を解析しています...(文字認識で取引年月日・取引先・取引金額を抽出中)'
  );

  // 前回のプレビュー用blob URLが残っていれば解放してから切り替える
  if (previewImg.src) URL.revokeObjectURL(previewImg.src);
  if (previewPdfEmbed.src) URL.revokeObjectURL(previewPdfEmbed.src);

  previewArea.hidden = false;
  if (file.type === 'application/pdf') {
    previewImg.hidden = true;
    previewImg.src = '';
    previewPdf.hidden = false;
    pdfName.textContent = file.name;
    previewPdfEmbed.src = URL.createObjectURL(file);
  } else {
    previewPdf.hidden = true;
    previewPdfEmbed.src = '';
    previewImg.hidden = false;
    previewImg.src = URL.createObjectURL(file);
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('skipExtract', skipExtract ? 'true' : 'false');

  try {
    const res = await fetch('/api/extract', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '抽出に失敗しました');

    currentUploadId = data.id;
    fieldDate.value = data.date || '';
    vendorField.setValue(data.vendor || '');
    fieldAmount.value = data.amount != null ? data.amount : '';
    exchangeTypeField.setValue('');
    documentTypeField.setValue(data.documentType || '');
    fieldPeriodDate.value = '';
    exchangeMethodField.setValue('');
    paymentMethodField.setValue('');
    fieldPaymentDate.value = '';
    journalStatusField.resetValue();
    fieldRemarks.value = '';
    fieldFileName.value = buildDefaultFileNameBase(data.date, data.vendor);
    fileNameIsDefault = true;

    clearStatus();
    reviewArea.hidden = false;
  } catch (err) {
    dropZone.hidden = false;
    showStatus(`エラー: ${err.message}`, true);
  }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  handleFile(file);
});
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

// 取引年月日・取引先を変更したとき、ファイル名欄がまだ自動生成の初期値のままなら
// 変更内容を反映して再生成する。ファイル名欄自体が編集されたら追従をやめる。
fieldDate.addEventListener('input', refreshDefaultFileNameIfUntouched);
fieldVendor.addEventListener('input', refreshDefaultFileNameIfUntouched);
fieldVendorSelect.addEventListener('change', refreshDefaultFileNameIfUntouched);
fieldFileName.addEventListener('input', () => {
  fileNameIsDefault = false;
});

cancelBtn.addEventListener('click', resetToDropZone);
resetBtn.addEventListener('click', resetToDropZone);

function buildSavePayload(overwrite) {
  return {
    id: currentUploadId,
    date: fieldDate.value,
    vendor: vendorField.getValue(),
    amount: fieldAmount.value,
    exchangeType: exchangeTypeField.getValue(),
    documentType: documentTypeField.getValue(),
    periodDate: fieldPeriodDate.value,
    exchangeMethod: exchangeMethodField.getValue(),
    paymentMethod: paymentMethodField.getValue(),
    paymentDate: fieldPaymentDate.value,
    journalStatus: journalStatusField.getValue(),
    remarks: fieldRemarks.value,
    fileName: fieldFileName.value,
    overwrite: !!overwrite,
  };
}

// overwrite: false(未指定)で送信し、保存先に同名ファイルが既にある場合はサーバーが
// 409 FILE_EXISTSを返す。その場合はユーザーに上書き可否を確認し、
// 「上書きする」を選んだ場合のみoverwrite:trueで再送信する。「しない」なら何もせず終了する。
async function performSave(overwrite) {
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSavePayload(overwrite)),
  });
  const data = await res.json();

  if (!res.ok) {
    if (data.error === 'FILE_EXISTS') {
      const shouldOverwrite = window.confirm(
        `OneDriveに既に同名のファイル「${data.fileName}」が存在します。上書きしますか?\n\n` +
          'OK: 上書きする / キャンセル: 何もしない(保存を中止する)'
      );
      if (shouldOverwrite) {
        showStatus('上書き保存しています...');
        return performSave(true);
      }
      clearStatus();
      return null;
    }
    if (data.error === 'NOT_SIGNED_IN') {
      throw new Error('Microsoft365にサインインしてください');
    }
    throw new Error(data.error || '保存に失敗しました');
  }

  return data;
}

reviewForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUploadId) return;

  clearStatus();
  showStatus('OneDriveに保存しています...');

  try {
    const data = await performSave(false);
    if (!data) return; // 上書きしない選択をしたので何もしない

    clearStatus();
    reviewArea.hidden = true;
    resultArea.hidden = false;
    resultFileNameText.value = data.name || '';
    resultLink.href = data.webUrl;
    resultLink.textContent = 'ファイルを開く';
    resultLinkText.value = data.webUrl || '';
    if (data.propertiesUrl) {
      propertiesLink.href = data.propertiesUrl;
      propertiesLinkText.value = data.propertiesUrl;
      propertiesLinkRow.hidden = false;
    } else {
      propertiesLinkRow.hidden = true;
    }
    savedDescriptionText.textContent = decodeHtmlEntities(data.savedDescription) || '(descriptionが空です。設定に失敗している可能性があります)';

    if (data.columnsError) {
      columnsWrittenText.hidden = false;
      columnsWrittenText.textContent = `SharePointライブラリの列への書き込みに失敗しました: ${data.columnsError}`;
    } else {
      columnsWrittenText.hidden = true;
    }

    versionsResetText.hidden = false;
    if (data.versionsReset) {
      versionsResetText.textContent = 'バージョン履歴を最新版のみに整理しました。';
    } else if (data.versionsError) {
      versionsResetText.textContent = `バージョン履歴の整理に失敗しました: ${data.versionsError}`;
    } else {
      versionsResetText.hidden = true;
    }
  } catch (err) {
    showStatus(`エラー: ${err.message}`, true);
  }
});

function renderTargetFolderHistory(history, current) {
  targetFolderHistory.innerHTML = '';
  if (!Array.isArray(history) || history.length < 2) {
    targetFolderHistory.hidden = true;
    return;
  }
  targetFolderHistory.hidden = false;
  for (const entry of history) {
    const label = document.createElement('label');
    label.className = 'target-folder-history-item';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'targetFolderHistory';
    radio.checked =
      entry.mode === 'own'
        ? current.mode === 'own'
        : current.mode === 'shared' && current.driveId === entry.driveId && current.itemId === entry.itemId;
    radio.addEventListener('change', () => selectHistoryTarget(entry));

    const span = document.createElement('span');
    span.textContent = entry.mode === 'own' ? '自分のOneDrive' : entry.fullPath || entry.name;

    label.appendChild(radio);
    label.appendChild(span);
    targetFolderHistory.appendChild(label);
  }
}

async function selectHistoryTarget(entry) {
  try {
    const body =
      entry.mode === 'own' ? { mode: 'own' } : { mode: 'shared', driveId: entry.driveId, itemId: entry.itemId };
    const res = await fetch('/api/target-folder/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '保存先の切り替えに失敗しました');
    }
    await refreshTargetFolder();
  } catch (err) {
    showStatus(`エラー: ${err.message}`, true);
  }
}

async function refreshTargetFolder() {
  try {
    const res = await fetch('/api/target-folder');
    const data = await res.json();
    const current = { mode: data.mode, driveId: data.driveId, itemId: data.itemId };
    renderTargetFolderHistory(data.history, current);
    if (data.mode === 'shared') {
      targetFolderLabel.textContent = `共有フォルダ「${data.fullPath || data.name}」`;
      const mapping = data.columnMapping;
      const found = mapping ? ['date', 'vendor', 'amount'].filter((k) => mapping[k]) : [];
      if (found.length === 3) {
        // 必要な列がすべて検出できている状態は正常なので、毎回の確認メッセージは表示しない
        columnMappingStatus.hidden = true;
      } else if (found.length > 0) {
        columnMappingStatus.hidden = false;
        columnMappingStatus.textContent = `SharePointライブラリの列を一部のみ検出しました(${found.length}/3)。「変更」から再検出できます。`;
      } else {
        columnMappingStatus.hidden = true;
      }

      vendorField.setChoices(mapping && mapping.vendorChoices, mapping && mapping.vendorAllowsFreeText);
      exchangeTypeField.setChoices(mapping && mapping.exchangeTypeChoices, mapping && mapping.exchangeTypeAllowsFreeText);
      documentTypeField.setChoices(mapping && mapping.documentTypeChoices, mapping && mapping.documentTypeAllowsFreeText);
      exchangeMethodField.setChoices(mapping && mapping.exchangeMethodChoices, mapping && mapping.exchangeMethodAllowsFreeText);
      paymentMethodField.setChoices(mapping && mapping.paymentMethodChoices, mapping && mapping.paymentMethodAllowsFreeText);
      journalStatusField.setChoices(mapping && mapping.journalStatusChoices, mapping && mapping.journalStatusAllowsFreeText);
      refreshVendorListBtn.hidden = !(
        vendorField.hasChoices() ||
        exchangeTypeField.hasChoices() ||
        documentTypeField.hasChoices() ||
        exchangeMethodField.hasChoices() ||
        paymentMethodField.hasChoices() ||
        journalStatusField.hasChoices()
      );
    } else {
      targetFolderLabel.textContent = '自分のOneDrive';
      columnMappingStatus.hidden = true;
      vendorField.setChoices([], null);
      exchangeTypeField.setChoices([], null);
      documentTypeField.setChoices([], null);
      exchangeMethodField.setChoices([], null);
      paymentMethodField.setChoices([], null);
      journalStatusField.setChoices([], null);
      refreshVendorListBtn.hidden = true;
    }
  } catch (err) {
    targetFolderLabel.textContent = '取得に失敗しました';
  }
}

async function detectColumns() {
  try {
    const res = await fetch('/api/target-folder/detect-columns', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return;
    const found = ['date', 'vendor', 'amount'].filter((k) => data.mapping[k]);
    const choiceCount = (data.mapping.vendorChoices || []).length;
    const extraChoiceCount =
      (data.mapping.exchangeTypeChoices || []).length +
      (data.mapping.documentTypeChoices || []).length +
      (data.mapping.exchangeMethodChoices || []).length +
      (data.mapping.paymentMethodChoices || []).length +
      (data.mapping.journalStatusChoices || []).length;
    if (found.length === 3 && choiceCount > 0) {
      showStatus(
        data.mapping.vendorAllowsFreeText === false
          ? `「取引先」列の選択肢を${choiceCount}件取得しました。取引先はプルダウンから選択してください。`
          : `「取引先」列の選択肢を${choiceCount}件取得しました。候補として入力欄に表示されます(自由入力も可能です)。`,
        false
      );
    } else if (extraChoiceCount > 0) {
      showStatus('追加項目の選択肢を取得しました。', false);
    }
  } catch (err) {
    // ライブラリでない(自分のOneDrive)場合などは静かに無視する
  }
}

function openFolderPicker() {
  folderPickerArea.hidden = false;
  shareLinkInput.value = '';
  folderPickerList.innerHTML = '';
}

async function loadSharedFolderList() {
  folderPickerList.innerHTML = '<p class="hint">共有フォルダを取得しています...</p>';

  try {
    const res = await fetch('/api/shared-folders');
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'NOT_SIGNED_IN') {
        throw new Error('先にMicrosoft365にサインインしてください');
      }
      throw new Error(data.error || '共有フォルダの取得に失敗しました');
    }

    if (!data.folders.length) {
      folderPickerList.innerHTML = '<p class="hint">自分に共有されているフォルダが見つかりませんでした。</p>';
      return;
    }

    folderPickerList.innerHTML = '';
    for (const folder of data.folders) {
      const row = document.createElement('div');
      row.className = 'folder-picker-item';

      const meta = document.createElement('div');
      meta.className = 'folder-meta';
      const nameEl = document.createElement('span');
      nameEl.textContent = folder.name;
      meta.appendChild(nameEl);
      if (folder.sharedBy) {
        const smallEl = document.createElement('small');
        smallEl.textContent = `共有元: ${folder.sharedBy}`;
        meta.appendChild(smallEl);
      }

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'btn';
      selectBtn.textContent = 'この場所に保存';
      selectBtn.addEventListener('click', () => selectTargetFolder(folder));

      row.appendChild(meta);
      row.appendChild(selectBtn);
      folderPickerList.appendChild(row);
    }
  } catch (err) {
    folderPickerList.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `エラー: ${err.message}`;
    folderPickerList.appendChild(p);
  }
}

async function selectTargetFolder(folder) {
  await fetch('/api/target-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driveId: folder.driveId, itemId: folder.itemId, name: folder.name }),
  });
  folderPickerArea.hidden = true;
  await refreshTargetFolder();
  await detectColumns();
  await refreshTargetFolder();
}

changeTargetBtn.addEventListener('click', openFolderPicker);
refreshVendorListBtn.addEventListener('click', async () => {
  refreshVendorListBtn.disabled = true;
  refreshVendorListBtn.textContent = '更新中...';
  try {
    await detectColumns();
    await refreshTargetFolder();
  } finally {
    refreshVendorListBtn.disabled = false;
    refreshVendorListBtn.textContent = '選択肢リストを更新';
  }
});
closePickerBtn.addEventListener('click', () => {
  folderPickerArea.hidden = true;
});
useOwnDriveBtn.addEventListener('click', async () => {
  await fetch('/api/target-folder/reset', { method: 'POST' });
  folderPickerArea.hidden = true;
  await refreshTargetFolder();
});
loadSharedListBtn.addEventListener('click', loadSharedFolderList);

useShareLinkBtn.addEventListener('click', async () => {
  const url = shareLinkInput.value.trim();
  if (!url) {
    showStatus('共有リンクのURLを入力してください', true);
    return;
  }
  clearStatus();
  useShareLinkBtn.disabled = true;
  useShareLinkBtn.textContent = '設定中...';
  try {
    const res = await fetch('/api/target-folder/from-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'NOT_SIGNED_IN') {
        throw new Error('先にMicrosoft365にサインインしてください');
      }
      throw new Error(data.error || '共有リンクの設定に失敗しました');
    }
    folderPickerArea.hidden = true;
    await refreshTargetFolder();
    await detectColumns();
    await refreshTargetFolder();
  } catch (err) {
    showStatus(`エラー: ${err.message}`, true);
  } finally {
    useShareLinkBtn.disabled = false;
    useShareLinkBtn.textContent = '設定';
  }
});

refreshAuthStatus();
refreshTargetFolder();
