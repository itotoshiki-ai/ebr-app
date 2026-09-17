# ebr-app

電子帳簿保存法対応: 証憑画像(領収書・請求書等)をOneDriveに保存し、Google Cloud Vision API(OCR)で読み取った
「取引年月日」「取引先」「取引金額」をファイルのプロパティとして自動付与するローカルWebアプリです。

## できること

1. ブラウザで領収書・請求書の画像(JPEG/PNG)またはPDFをアップロード
2. Google Cloud Vision API (OCR) + 正規表現ベースの解析で取引年月日・取引先・取引金額を自動抽出
   (無料枠: 月1000ユニットまで無料。OCRテキストからのヒューリスティック抽出のため、レイアウトによっては
   精度が不安定です。次のステップで必ず内容を確認してください)
3. 内容を画面上で確認・修正。あわせて以下の項目も手入力できます(自動抽出はされません)
   - 授受区分・書類種別・開始日または締日・授受手段(必須)
   - 支払方法・支払日・仕訳状況・備考(任意項目。未入力のまま保存可能。支払方法・仕訳状況の
     選択肢はOneDrive側の列設定から取得し、仕訳状況は選択肢の先頭を初期値にします)
   - ファイル名(未入力の場合は `取引先_取引年月日` を自動生成。拡張子は自動付与)
4. 「OneDriveに保存」を押すと、サインインしたアカウントのOneDrive(または選択した共有フォルダ)の
   指定フォルダにアップロードし、あわせて以下にも情報を書き込みます
   - OneDriveアイテムの `description` プロパティ(最も確実にOneDrive上で確認可能)
   - JPEGの場合: EXIFのタイトル/件名/コメント/撮影日時
   - PDFの場合: PDF文書プロパティのタイトル/作成者/サブジェクト/キーワード

### 技術的な注意点

個人用OneDriveには、SharePointのようなカスタム列(自由な追加プロパティ)を作成するAPIがありません。
そのため「プロパティ値」は、OneDriveアイテム自体の `description` プロパティと、ファイル内部に埋め込む
メタデータ(EXIF/PDFプロパティ)で表現しています。PNGはファイル内メタデータ埋め込みに対応していないため、
`description` プロパティとファイル名のみで情報を保持します。

## セットアップ

### 1. 依存パッケージのインストール

```
npm install
```

Node.js 18以上が必要です(組み込みの `fetch` を使用します)。

### 2. Azure ADアプリの登録 (OneDriveアクセス用)

1. https://portal.azure.com/ にアクセスし、Microsoftアカウントでサインイン
   (OneDriveでアクセスしたいアカウントと同じである必要はありません。Azureサブスクリプションが
   なくても、個人アカウントには既定のMicrosoft Entra IDディレクトリが自動的に用意されています)
2. 上部の検索バーで「アプリの登録」を検索、または左メニュー「Microsoft Entra ID」→「アプリの登録」
3. 「+ 新規登録」をクリックし、以下を入力
   - 名前: 任意 (例: ebr-app)
   - サポートされているアカウントの種類: 用途に応じて選択(下表参照)
   - リダイレクト URI: プラットフォーム「Web」、URIに `http://localhost:3000/auth/callback`
   - 「登録」をクリック
4. 「概要」画面の**「アプリケーション (クライアント) ID」**をコピー → `.env` の `AZURE_CLIENT_ID`
5. 左メニュー「証明書とシークレット」→「クライアント シークレット」タブ→「+ 新しいクライアント シークレット」
   - 説明・有効期限は任意で作成
   - 作成直後に表示される**「値」列**の文字列をすぐコピー(**このページを離れると二度と表示されません**。
     見逃した場合はシークレットを作り直してください。「シークレットID」ではなく「値」が必要です)
   - → `.env` の `AZURE_CLIENT_SECRET`
6. 左メニュー「APIのアクセス許可」→「+ アクセス許可の追加」→「Microsoft Graph」→
   「委任されたアクセス許可」を選び、検索して以下を追加:
   - `Files.ReadWrite`
   - `offline_access`
   (`User.Read` は既定で追加済み。組織テナントによってはユーザー本人が同意できず、
   テナント管理者による「管理者の同意を与える」操作が必要な場合があります)
7. 左メニュー「認証」で、「Web」プラットフォームの下に `http://localhost:3000/auth/callback` が
   登録されていることを確認(ポート番号・末尾スラッシュまで `.env` の `REDIRECT_URI` と完全一致させること)

**サポートされているアカウントの種類 と `.env` の対応**

| ログインを許可したい対象 | Azure Portalでの選択 | `AZURE_AUTHORITY_HOST` |
|---|---|---|
| 個人用Microsoftアカウントのみ | 個人の Microsoft アカウントのみ | `https://login.microsoftonline.com/consumers` |
| 自社のMicrosoft 365テナントのみ | このディレクトリのみに含まれるアカウント (シングル テナント) | `https://login.microsoftonline.com/<自社ドメイン or テナントID>`<br>例: `https://login.microsoftonline.com/contoso.onmicrosoft.com` |
| 任意の組織のMicrosoft 365アカウント | 任意の組織ディレクトリ内のアカウント | `https://login.microsoftonline.com/organizations` |
| 個人・組織アカウントどちらも | 任意の組織ディレクトリと個人のMicrosoftアカウント | `https://login.microsoftonline.com/common` |

既存アプリの種類を後から変更したい場合は、左メニュー「認証」の「サポートされているアカウントの種類」から変更できます(変更できない場合はアプリを登録し直してください)。

**よくあるエラー**

| エラー | 原因 |
|---|---|
| AADSTS700016 (invalid client) | クライアントIDの誤り、または削除済みアプリのID |
| AADSTS50011 (redirect URI mismatch) | Azure側の登録URIと `.env` の `REDIRECT_URI` が不一致 |
| AADSTS50020 | 「サポートされているアカウントの種類」と `AZURE_AUTHORITY_HOST` の不一致(例: シングルテナント登録なのに `common` を指定している) |
| AADSTS65001 (consent required) / 管理者の同意が必要 | 組織テナットのアクセス許可ポリシーでユーザー本人の同意が禁止されている。テナント管理者に「管理者の同意を与える」を実行してもらう |

### 3. Google Cloud Vision APIキーの取得(無料枠: 月1000ユニットまで無料)

1. https://console.cloud.google.com/ でプロジェクトを作成(または既存のものを選択)
2. 左メニュー「APIとサービス」→「ライブラリ」で「Cloud Vision API」を検索し「有効にする」
3. 「APIとサービス」→「認証情報」→「+ 認証情報を作成」→「APIキー」で発行し、`.env` の
   `GOOGLE_VISION_API_KEY` に設定
   (無料枠超過による課金を避けたい場合は、作成したAPIキーの「制限」で「Cloud Vision API」のみに
   使用を制限し、Google Cloudの予算アラートを設定することを推奨します)

### 4. 環境変数の設定

```
copy .env.example .env
```

`.env` を開き、`GOOGLE_VISION_API_KEY` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` を入力してください。

### 5. 起動

```
npm start
```

http://localhost:3000 を開き、「OneDriveにサインイン」→証憑ファイルをアップロード、の順で利用します。

## 常時稼働サーバーへのデプロイ(社内の他PC/スマホからアクセスする場合)

自分のPC以外の常時電源オンの専用マシンでこのアプリを稼働させ、社内の他端末からアクセスできる
ようにする場合の手順です。以下はすべて**サーバー機(常時稼働させる専用PC)側**での作業です。
開発機での追加作業はありません。

### 1. サーバー機にGitとNode.jsをインストール

WindowsにはGit・Node.jsは標準搭載されていないため、事前にインストールします。

- Git: https://git-scm.com/download/win からインストーラーをダウンロードして実行(既定設定でOK)
- Node.js: https://nodejs.org/ からLTS版(18以上)をダウンロードして実行

インストール後、**新しくPowerShellを開き直して**(既存ウィンドウはPATH未反映のため)以下で認識されることを確認します。

```
git --version
node --version
```

### 2. リポジトリをclone

```
git clone https://github.com/itotoshiki-ai/ebr-app.git C:\apps\ebr-app
cd C:\apps\ebr-app
```

(このリポジトリはPublicのため、clone時にGitHubの認証は不要です)

### 3. 依存パッケージをインストール

```
npm install
```

### 4. `.env`を作成して値を設定

```
copy .env.example .env
```

`.env`を開き、稼働中の環境と同じ`GOOGLE_VISION_API_KEY` / `OWN_COMPANY_NAME` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET` / `AZURE_AUTHORITY_HOST`を設定します。`REDIRECT_URI`はこの時点では
`http://localhost:3000/auth/callback`のままでかまいません(手順7でサーバー用に変更します)。

### 5. サインイン・保存先フォルダは利用者ごとに個別(引き継ぎ不要)

サインイン状態と保存先フォルダの設定(履歴含む)は、サーバー全体で共有される設定ファイルではなく、
利用者(ブラウザ)ごとのセッションとして`data\sessions.json`に保存されます。ブラウザのCookieは
アクセス先のアドレス(ドメイン/ポート)ごとに別々に発行される仕組み上、`http://localhost:3000`で
使っていたセッションを`https://<サーバー>:3000`にそのまま引き継ぐことはできません。
サーバー機での利用開始時は、利用者ごとに改めてブラウザでサインイン・保存先フォルダの選択を
行ってください(他の利用者の設定に影響することはありません)。

### 6. 動作確認(まずHTTPのまま)

```
npm start
```

サーバー機のブラウザで`http://localhost:3000`を開き、正常に起動・サインインできることを確認したら
`Ctrl+C`で停止します。ここから先はHTTPS化と社内公開の設定です。

### 7. Entra ID(Azure AD)はHTTPS必須

リダイレクトURIに`localhost`以外を使う場合、Entra IDはHTTPSでないと登録を拒否します。
そのため社内の他端末からアクセスするには、サーバーをHTTPSで待ち受けさせる必要があります。

```
node scripts/generate-cert.js <サーバーのホスト名> <サーバーのIPアドレス>
# 例: node scripts/generate-cert.js ebr-server 192.168.1.50
```

`certs/cert.pem` / `certs/key.pem` が生成され、次回起動時から自動的にHTTPSで待ち受けます
(`src/server.js`が起動時にこの2ファイルの有無を見て切り替えます)。

自己署名証明書のため、各クライアント端末では初回アクセス時にブラウザの警告が出ます。
警告を出したくない場合は、生成された`certs/cert.pem`を各端末の「信頼されたルート証明機関」に
インポートしてください(社内のみで使う証明書なので、正規のCA証明書のように厳重な配布管理は
不要ですが、ファイル自体は秘密鍵〈`key.pem`〉と違い機密情報ではありません)。

### 8. `.env`の`REDIRECT_URI`とAzure Portal側を更新

`.env`の`REDIRECT_URI`を、サーバーの実際のアドレスに変更します。

```
REDIRECT_URI=https://<サーバーのホスト名またはIP>:3000/auth/callback
```

Azure Portal側([アプリの登録] > 対象アプリ > [認証])でも、上記と全く同じURIを
リダイレクトURIとして追加登録してください(1文字でも違うとサインインに失敗します)。

### 9. Windowsファイアウォールでポートを開放

サーバーPCで、PowerShellを管理者権限で実行します。

```
New-NetFirewallRule -DisplayName "ebr-app" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

### 10. Windowsサービスとして常時稼働させる

ユーザーがサインインしていなくても自動起動・クラッシュ時自動再起動するように、
[NSSM](https://nssm.cc/download)を使ってWindowsサービス化することを推奨します。

```
nssm install ebr-app "C:\Program Files\nodejs\node.exe" "C:\apps\ebr-app\src\server.js"
nssm set ebr-app AppDirectory "C:\apps\ebr-app"
nssm set ebr-app Start SERVICE_AUTO_START
nssm start ebr-app
```

サービスのログは既定でイベントログには出ないため、`nssm set ebr-app AppStdout`/`AppStderr`で
ログファイルの出力先を指定しておくとトラブルシュートしやすくなります。

### 補足: サインイン状態はサーバー再起動をまたいで保持される

サインインセッション(`data/sessions.json`)とMicrosoftのトークンキャッシュ
(`data/msal-token-cache.json`)はどちらもファイルに永続化されるため、サービスの再起動や
サーバーの再起動をまたいでもサインインし直す必要はありません(リフレッシュトークンの
有効期限が切れない限り)。

## 制限事項 (V1)

- アップロード可能なファイルサイズは4MBまで(Microsoft Graphの単純アップロードAPIの上限)
- 対応形式: JPEG / PNG / PDF
