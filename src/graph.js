const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024; // Graphの単純アップロードAPIの上限

function encodePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

async function graphFetch(accessToken, path, options = {}) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  return res;
}

// target: null/undefined => 自分のOneDriveのルート。
// { driveId, itemId } => 他のユーザーが共有してくれたフォルダ(そのフォルダをルートとして扱う)
function basePath(target) {
  if (target && target.driveId && target.itemId) {
    return `/drives/${target.driveId}/items/${target.itemId}`;
  }
  return '/me/drive/root';
}

// 保存先フォルダの上位階層を含むフルパスを画面表示用に組み立てる。
// GraphのparentReference.pathは "/drives/{id}/root:/親フォルダ/さらに親" のような形式で
// 返るため、"root:"より後ろの部分を取り出し、自身のフォルダ名と連結する。
// 取得に失敗した場合はnullを返す(呼び出し側でフォルダ名のみの表示にフォールバックする)。
async function getItemFullPath(accessToken, driveId, itemId) {
  const res = await graphFetch(accessToken, `/drives/${driveId}/items/${itemId}?$select=name,parentReference`, {
    method: 'GET',
  });
  if (!res.ok) return null;

  const item = await res.json();
  const rawPath = item.parentReference && item.parentReference.path;
  const marker = 'root:';
  const idx = rawPath ? rawPath.indexOf(marker) : -1;
  const parentPath = idx >= 0 ? decodeURIComponent(rawPath.slice(idx + marker.length)) : '';
  const segments = parentPath.split('/').filter(Boolean);
  segments.push(item.name);
  return segments.join(' / ');
}

async function ensureFolderPath(accessToken, folderPath, target) {
  const segments = (folderPath || '').split('/').filter(Boolean);
  let currentPath = '';
  for (const seg of segments) {
    const base = basePath(target);
    const childrenUrl = currentPath ? `${base}:/${encodePath(currentPath)}:/children` : `${base}/children`;

    const res = await graphFetch(accessToken, childrenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: seg,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (!res.ok && res.status !== 409) {
      const body = await res.text();
      throw new Error(`フォルダ作成に失敗しました (${res.status}): ${body}`);
    }

    currentPath = currentPath ? `${currentPath}/${seg}` : seg;
  }
}

// 指定パスに同名のアイテムが既に存在するか確認する。存在すればそのdriveItemを、
// 存在しなければnullを返す(保存前の上書き確認に使う)。
async function findItemByPath(accessToken, target, folderPath, fileName) {
  const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
  const base = basePath(target);
  const res = await graphFetch(accessToken, `${base}:/${encodePath(fullPath)}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`アイテムの存在確認に失敗しました (${res.status}): ${body}`);
  }
  return res.json();
}

async function uploadFile(accessToken, target, folderPath, fileName, buffer) {
  if (buffer.length > MAX_SIMPLE_UPLOAD_BYTES) {
    throw new Error('ファイルサイズが4MBを超えています。現在このアプリは4MB以下のファイルのみ対応しています。');
  }

  const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
  const base = basePath(target);
  const res = await graphFetch(accessToken, `${base}:/${encodePath(fullPath)}:/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneDriveへのアップロードに失敗しました (${res.status}): ${body}`);
  }

  return res.json();
}

async function setDescription(accessToken, driveItem, description) {
  const driveId = driveItem.parentReference && driveItem.parentReference.driveId;
  const path = driveId ? `/drives/${driveId}/items/${driveItem.id}` : `/me/drive/items/${driveItem.id}`;

  const res = await graphFetch(accessToken, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`プロパティ(description)の設定に失敗しました (${res.status}): ${body}`);
  }

  return res.json();
}

async function getSharedWithMeRaw(accessToken) {
  const res = await graphFetch(accessToken, '/me/drive/sharedWithMe', { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`共有アイテム一覧の取得に失敗しました (${res.status}): ${body}`);
  }
  return res.json();
}

// OneDriveの「共有」>「リンクをコピー」で取得したURLから、対象アイテム(driveId/itemId)を解決する。
// テナントによってはsharedWithMeが使えないため、こちらを確実な代替手段として提供する。
// 参考: https://learn.microsoft.com/en-us/graph/api/shares-get
function encodeSharingUrl(shareUrl) {
  const base64 = Buffer.from(shareUrl.trim(), 'utf8').toString('base64');
  const urlSafe = base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${urlSafe}`;
}

async function resolveSharingUrl(accessToken, shareUrl) {
  if (!shareUrl || !/^https?:\/\//i.test(shareUrl.trim())) {
    throw new Error('有効な共有リンク(URL)を指定してください');
  }
  const encoded = encodeSharingUrl(shareUrl);
  const res = await graphFetch(accessToken, `/shares/${encoded}/driveItem?$select=id,name,parentReference,folder,webUrl`, {
    method: 'GET',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`共有リンクの解決に失敗しました (${res.status}): ${body}`);
  }
  const item = await res.json();
  if (!item.folder) {
    throw new Error('指定されたリンクはフォルダではありません。フォルダの共有リンクを指定してください。');
  }
  const driveId = item.parentReference && item.parentReference.driveId;
  if (!driveId) {
    throw new Error('共有リンクからドライブ情報を取得できませんでした。');
  }
  return { driveId, itemId: item.id, name: item.name, webUrl: item.webUrl };
}

async function listSharedFolders(accessToken) {
  const data = await getSharedWithMeRaw(accessToken);
  return (data.value || [])
    .filter((item) => {
      const remote = item.remoteItem || item;
      return !!remote.folder;
    })
    .map((item) => {
      const remote = item.remoteItem || item;
      const driveId = (remote.parentReference && remote.parentReference.driveId) || null;
      return {
        name: item.name,
        driveId,
        itemId: remote.id,
        webUrl: item.webUrl,
        sharedBy:
          (remote.shared && remote.shared.sharedBy && remote.shared.sharedBy.user && remote.shared.sharedBy.user.displayName) ||
          null,
      };
    })
    .filter((f) => f.driveId && f.itemId);
}

const SP_COLUMN_TYPE_KEYS = ['text', 'number', 'dateTime', 'currency', 'choice', 'boolean', 'personOrGroup', 'lookup', 'hyperlinkOrPicture'];

// SharePoint(OneDrive for Business)がバックエンドのドライブの場合のみ有効。
// ドキュメントライブラリに定義されている列(カスタムプロパティ)の一覧を取得する。
async function getListColumns(accessToken, driveId) {
  const res = await graphFetch(accessToken, `/drives/${driveId}/list/columns`, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ライブラリの列情報の取得に失敗しました (${res.status}): ${body}`);
  }
  const data = await res.json();
  return (data.value || []).map((c) => {
    const type = SP_COLUMN_TYPE_KEYS.find((k) => c[k]) || null;
    return {
      name: c.name,
      displayName: c.displayName,
      hidden: !!c.hidden,
      readOnly: !!c.readOnly,
      type,
      details: type ? c[type] : null,
    };
  });
}

// 表示名のキーワードから、各項目に使う列をヒューリスティックに推定する
function guessColumnMapping(columns) {
  const usable = columns.filter((c) => !c.hidden && !c.readOnly);
  const findBy = (keywords, types) =>
    usable.find((c) => (!types || types.includes(c.type)) && keywords.some((k) => c.displayName.includes(k)));

  const dateCol = findBy(['取引年月日', '取引日', '年月日', '日付'], ['dateTime']);
  const vendorCol = findBy(['取引先', '仕入先', '支払先', '会社名', '相手先'], ['text', 'choice']);
  const amountCol = findBy(['取引金額', '金額'], ['currency', 'number']);
  const exchangeTypeCol = findBy(['授受区分'], ['text', 'choice']);
  const documentTypeCol = findBy(['書類種別', '書類の種類'], ['text', 'choice']);
  const periodDateCol = findBy(['開始日又は締日', '開始日または締日', '締日', '開始日'], ['dateTime']);
  const exchangeMethodCol = findBy(['授受手段'], ['text', 'choice']);
  const paymentMethodCol = findBy(['支払方法', '支払い方法'], ['text', 'choice']);
  const paymentDateCol = findBy(['支払日'], ['dateTime']);
  const journalStatusCol = findBy(['仕訳状況', '仕訳ステータス'], ['text', 'choice']);
  const remarksCol = findBy(['備考'], ['text']);

  return {
    date: dateCol ? dateCol.name : null,
    vendor: vendorCol ? vendorCol.name : null,
    amount: amountCol ? amountCol.name : null,
    exchangeType: exchangeTypeCol ? exchangeTypeCol.name : null,
    documentType: documentTypeCol ? documentTypeCol.name : null,
    periodDate: periodDateCol ? periodDateCol.name : null,
    exchangeMethod: exchangeMethodCol ? exchangeMethodCol.name : null,
    paymentMethod: paymentMethodCol ? paymentMethodCol.name : null,
    paymentDate: paymentDateCol ? paymentDateCol.name : null,
    journalStatus: journalStatusCol ? journalStatusCol.name : null,
    remarks: remarksCol ? remarksCol.name : null,
    vendorColumn: vendorCol || null,
    exchangeTypeColumn: exchangeTypeCol || null,
    documentTypeColumn: documentTypeCol || null,
    exchangeMethodColumn: exchangeMethodCol || null,
    paymentMethodColumn: paymentMethodCol || null,
    journalStatusColumn: journalStatusCol || null,
  };
}

// SharePointドキュメントライブラリのカスタム列に値を書き込む。
// fields: { 列の内部名: 値 } の形。
async function setListItemFields(accessToken, driveItem, fields) {
  const driveId = driveItem.parentReference && driveItem.parentReference.driveId;
  if (!driveId) {
    throw new Error('このアイテムのdriveIdが取得できないため、列への書き込みはできません。');
  }
  const res = await graphFetch(accessToken, `/drives/${driveId}/items/${driveItem.id}/listItem/fields`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ライブラリの列への書き込みに失敗しました (${res.status}): ${body}`);
  }

  return res.json();
}

// アップロード後の各種プロパティ更新(description, listItem/fields等)によって
// SharePoint側に積み上がった旧バージョンを削除し、最新版だけを残す。
// 個人用OneDrive(SharePointバックエンドでないドライブ)ではバージョン削除APIが
// 使えないため、その場合は何もしない。
// 参考: https://learn.microsoft.com/en-us/graph/api/driveitemversion-delete
// (現在の最新版は削除できない/削除の対象外なので、先頭以外を削除する)
async function resetVersionHistory(accessToken, driveItem) {
  const driveId = driveItem.parentReference && driveItem.parentReference.driveId;
  if (!driveId) return { attempted: false };

  const listRes = await graphFetch(accessToken, `/drives/${driveId}/items/${driveItem.id}/versions`, {
    method: 'GET',
  });
  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error(`バージョン一覧の取得に失敗しました (${listRes.status}): ${body}`);
  }

  const data = await listRes.json();
  const versions = data.value || [];
  if (versions.length <= 1) {
    return { attempted: true, deleted: 0, total: versions.length };
  }

  // versionsは新しい順に返るため、先頭(最新版)以外を削除する
  const [, ...older] = versions;
  let deleted = 0;
  for (const v of older) {
    const delRes = await graphFetch(accessToken, `/drives/${driveId}/items/${driveItem.id}/versions/${v.id}`, {
      method: 'DELETE',
    });
    if (delRes.ok) deleted += 1;
  }

  return { attempted: true, deleted, total: versions.length };
}

// フォルダ自体のdriveItem情報(id等)を取得する。コピー先フォルダの指定に使う。
async function getFolderItem(accessToken, folderPath, target) {
  const base = basePath(target);
  const path = folderPath ? `${base}:/${encodePath(folderPath)}` : base;
  const res = await graphFetch(accessToken, path, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`フォルダ情報の取得に失敗しました (${res.status}): ${body}`);
  }
  return res.json();
}

async function getItemById(accessToken, driveId, itemId) {
  const res = await graphFetch(accessToken, `/drives/${driveId}/items/${itemId}`, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`アイテム情報の取得に失敗しました (${res.status}): ${body}`);
  }
  return res.json();
}

async function deleteItem(accessToken, driveId, itemId) {
  const res = await graphFetch(accessToken, `/drives/${driveId}/items/${itemId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`アイテムの削除に失敗しました (${res.status}): ${body}`);
  }
}

// アイテムを別フォルダへコピーする。コピー結果は新規アイテムとして扱われ、
// SharePointのバージョン履歴は1.0からやり直しになる(=バージョンを1.0にリセットする裏技)。
// コピーは非同期処理のため、完了までモニターURLをポーリングして待つ。
// 参考: https://learn.microsoft.com/en-us/graph/api/driveitem-copy
async function copyItemAndWait(accessToken, sourceDriveItem, destDriveId, destFolderId, newName) {
  const sourceDriveId = sourceDriveItem.parentReference.driveId;
  const res = await graphFetch(accessToken, `/drives/${sourceDriveId}/items/${sourceDriveItem.id}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentReference: { driveId: destDriveId, id: destFolderId },
      name: newName,
    }),
  });

  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(`コピーの開始に失敗しました (${res.status}): ${body}`);
  }

  const monitorUrl = res.headers.get('Location');
  if (!monitorUrl) {
    throw new Error('コピーの進捗確認用URLが取得できませんでした');
  }

  // モニターURLは認証不要の署名付きURL(Graphのベースパスではないため直接fetchする)
  for (let i = 0; i < 30; i += 1) {
    const monitorRes = await fetch(monitorUrl);
    const monitorJson = await monitorRes.json();
    if (monitorJson.status === 'completed') {
      return monitorJson.resourceId;
    }
    if (monitorJson.status === 'failed' || monitorJson.status === 'deleteFailed') {
      throw new Error(`コピーに失敗しました: ${(monitorJson.error && monitorJson.error.message) || monitorJson.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('コピーの完了待ちがタイムアウトしました');
}

// アイテムに紐づくSharePointリストアイテムの「プロパティ(項目の表示)」画面のURLを取得する。
// listItemのwebUrlはドキュメントライブラリの場合ファイル自体のURLと同じ値になってしまい
// プロパティ画面を指さないため、ライブラリのURL(list.webUrl)とリストアイテムの番号(listItem.id)
// から、SharePoint標準のフォームのURLを組み立てる。デフォルトはDispForm.aspx(表示専用)だが、
// .envの`PROPERTIES_LINK_MODE=edit`でEditForm.aspx(値を直接編集して保存できるフォーム)に
// 切り替え可能。個人用OneDrive/SharePointいずれもバックエンドはSharePointリストのため
// 取得できるが、あくまで補助情報なので、取得に失敗しても保存自体は失敗させない
// (呼び出し側でnullを許容)。
async function getListItemPropertiesUrl(accessToken, driveItem) {
  const driveId = driveItem.parentReference && driveItem.parentReference.driveId;
  if (!driveId) return null;

  const [listRes, itemRes] = await Promise.all([
    graphFetch(accessToken, `/drives/${driveId}/list?$select=webUrl`, { method: 'GET' }),
    graphFetch(accessToken, `/drives/${driveId}/items/${driveItem.id}/listItem?$select=id`, { method: 'GET' }),
  ]);
  if (!listRes.ok || !itemRes.ok) return null;

  const list = await listRes.json();
  const listItem = await itemRes.json();
  if (!list.webUrl || !listItem.id) return null;

  const formName = process.env.PROPERTIES_LINK_MODE === 'edit' ? 'EditForm.aspx' : 'DispForm.aspx';
  return `${list.webUrl}/Forms/${formName}?ID=${listItem.id}`;
}

module.exports = {
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
};
