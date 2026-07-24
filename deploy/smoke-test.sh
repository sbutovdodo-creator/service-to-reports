#!/usr/bin/env bash
set -euo pipefail

set -a
. /etc/riklab-report.env
set +a

headers="$(mktemp)"
login_body="$(python3 -c 'import os,json; print(json.dumps({"login": os.environ["APP_AUTH_LOGIN"], "password": os.environ["APP_AUTH_PASSWORD"]}))')"
login_code="$(curl -sS -D "$headers" -o /tmp/riklab-login-response.json -w '%{http_code}' \
  -H 'Content-Type: application/json' -d "$login_body" \
  http://127.0.0.1:3000/api/auth/login)"
cookie="$(awk 'BEGIN{IGNORECASE=1} /^set-cookie:/{print $2}' "$headers" | cut -d';' -f1)"
echo "LOGIN=$login_code COOKIE_BYTES=${#cookie}"

for kind in pdf docx; do
  code="$(curl -sS -o "/tmp/riklab-act.$kind" -w '%{http_code}' \
    -H "Cookie: $cookie" -H 'Content-Type: application/json' \
    --data-binary @/tmp/qa-act-payload.json \
    "http://127.0.0.1:3000/api/oven-act/$kind")"
  echo "ACT_${kind^^}=$code BYTES=$(stat -c%s "/tmp/riklab-act.$kind")"
done

file /tmp/riklab-act.pdf /tmp/riklab-act.docx

report_args=(-H "Cookie: $cookie" -F "metadata=</tmp/qa-report-russian.json")
while IFS= read -r photo_key; do
  report_args+=(-F "photo:$photo_key=@/tmp/riklab-sample.png;type=image/png")
done < <(python3 -c 'import json; print("\n".join(p["key"] for p in json.load(open("/tmp/qa-report-russian.json", encoding="utf-8"))["photos"]))')

for kind in pdf docx; do
  code="$(curl -sS -o "/tmp/riklab-report.$kind" -w '%{http_code}' \
    "${report_args[@]}" "http://127.0.0.1:3000/api/oven-report/$kind")"
  echo "REPORT_${kind^^}=$code BYTES=$(stat -c%s "/tmp/riklab-report.$kind")"
done

file /tmp/riklab-report.pdf /tmp/riklab-report.docx

if [[ "${SEND_EMAIL_TEST:-0}" == "1" ]]; then
  package_id="smoke-$(date +%s)-$(openssl rand -hex 6)"
  for kind in act-pdf act-docx; do
    code="$(curl -sS -o "/tmp/riklab-package-$kind.json" -w '%{http_code}' \
      -H "Cookie: $cookie" \
      -F "packageId=$package_id" -F "kind=$kind" \
      -F "actPayload=</tmp/qa-act-payload.json" \
      http://127.0.0.1:3000/api/oven-package/part)"
    echo "PACKAGE_${kind^^}=$code"
  done
  for kind in report-pdf report-docx; do
    code="$(curl -sS -o "/tmp/riklab-package-$kind.json" -w '%{http_code}' \
      "${report_args[@]}" -F "packageId=$package_id" -F "kind=$kind" \
      http://127.0.0.1:3000/api/oven-package/part)"
    echo "PACKAGE_${kind^^}=$code"
  done
  finalize_body="$(python3 -c 'import json; a=json.load(open("/tmp/qa-report-russian.json", encoding="utf-8"))["act"]; print(json.dumps({"packageId": "'"$package_id"'", "metadata": a}, ensure_ascii=False))')"
  finalize_code="$(curl -sS -o /tmp/riklab-package.zip -w '%{http_code}' \
    -H "Cookie: $cookie" -H 'Content-Type: application/json' \
    -d "$finalize_body" http://127.0.0.1:3000/api/oven-package/finalize)"
  echo "PACKAGE_FINALIZE=$finalize_code BYTES=$(stat -c%s /tmp/riklab-package.zip)"
  file /tmp/riklab-package.zip
fi
