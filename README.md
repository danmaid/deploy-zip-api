# deploy-zip-api

Node.js + TypeScript（実行時依存ゼロ）で動く、ZIPベースの簡易デプロイAPIです。

- `POST /content` : SharePoint等の「フォルダ一括DL」ZIPを受け取り、`/var/www/html` を atomic に差し替えます。
  - 置換前のディレクトリは `/var/www/archive/<id>/` として展開済みのまま保管します。
  - 受信中に `deflate+DD` のエントリはストリーミングで展開しつつCRC/サイズを検証します。
  - `STORE+DD` などストリーミングで境界確定できないものは、受信後に Central Directory を読み、spool からフォールバック展開します。
- `GET /content` : `/var/www/html` を ZIP（DD付き、Zip64対応）としてストリーミング返却します。
- `GET /archive` : `/var/www/archive` の履歴ディレクトリ一覧を返却します。
- `GET /archive/:id` : `/var/www/archive/:id` を ZIP としてストリーミング返却します。

> 注意: 認証はありません。既存APIサーバ側で必ず制御してください。

## Setup

```bash
npm i
npm run build
PORT=8080 npm start
```

## Testing

Edge cases and error handling scenarios are covered by automated tests:

```bash
npm test              # Run tests in watch mode
npm run test -- --run # Run tests once and exit
```

The test suite covers:
- File system edge cases (EEXIST, ENOTDIR errors)
- Directory creation with multiple concurrent calls
- File/directory name collisions in ZIP archives
- Safe path joining and validation

## API Docs

- `docs/APIDOCS.md`
- `openapi.yaml` / `openapi.json`
- `examples/*.sh`

## Environment variables

- `PORT` (default: 8080)
- `HOST` (default: 0.0.0.0)
- `HTML_DIR` (default: /var/www/html)
- `ARCHIVE_DIR` (default: /var/www/archive)
- `TMP_BASE` (default: /var/www/.tmp-deploy)
- `ZIP_OUT_ROOT` (default: site)  … GETで返すZIPのトップフォルダ名

Limits（バイト）
- `MAX_ZIP_BYTES` (default: 1GiB)
- `MAX_TOTAL_BYTES` (default: 2GiB)
- `MAX_FILE_BYTES` (default: 512MiB)
- `MAX_ENTRIES` (default: 20000)

## Built-in doc routes

- `GET /docs` (markdown)
- `GET /openapi.yaml`
- `GET /openapi.json`

## Web UI

ブラウザで試す: `http://localhost:8080/ui`（または `/`）

