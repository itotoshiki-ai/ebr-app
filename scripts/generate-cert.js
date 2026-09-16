// 常時稼働サーバー用の自己署名TLS証明書を生成する。
// 使い方: node scripts/generate-cert.js <ホスト名またはIP> [追加のホスト名/IP...]
// 例:     node scripts/generate-cert.js ebr-server 192.168.1.50
//
// 生成された certs/cert.pem を各クライアント端末の「信頼されたルート証明機関」に
// インストールすると、ブラウザの警告なしにアクセスできる(詳細はREADME参照)。
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('使い方: node scripts/generate-cert.js <ホスト名またはIP> [追加のホスト名/IP...]');
    process.exit(1);
  }

  const ipPattern = /^\d{1,3}(\.\d{1,3}){3}$/;
  const altNames = names.map((name) =>
    ipPattern.test(name) ? { type: 7, ip: name } : { type: 2, value: name }
  );

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const attrs = [{ name: 'commonName', value: names[0] }];
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  const certDir = path.join(__dirname, '..', 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
  fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);

  console.log(`証明書を生成しました: ${certDir}`);
  console.log(`対象ホスト名/IP: ${names.join(', ')}`);
  console.log('サーバーを再起動するとHTTPSで待ち受けます。');
  console.log('クライアント端末でブラウザの警告を出したくない場合は certs/cert.pem を');
  console.log('各端末の「信頼されたルート証明機関」にインポートしてください。');
}

main().catch((err) => {
  console.error('証明書の生成に失敗しました:', err);
  process.exit(1);
});
