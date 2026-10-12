#!/usr/bin/env sh
# 확장이 외부와 통신하거나 sync 저장소를 쓰는 코드가 없는지 검사한다.
set -eu
cd "$(dirname "$0")/.."

fail=0

if grep -rnE 'storage\.sync|fetch\(|XMLHttpRequest|WebSocket|sendBeacon' src/; then
  echo "FAIL: src/ 에 네트워크 또는 sync 사용 흔적" >&2
  fail=1
fi

if grep -q '"host_permissions"' manifest.json; then
  echo "FAIL: manifest.json 에 정적 host_permissions" >&2
  fail=1
fi

if [ -d dist ]; then
  # 허용: SVG/XML 네임스페이스(w3.org), 호스트 정규화용 템플릿 리터럴 `https://${...}` (host.ts, URL 파싱 전용)
  if grep -rhoE 'https?://[^"'"'"' )]+' dist/ | grep -vE '^https?://www\.w3\.org/|\$\{' | sort -u | grep .; then
    echo "FAIL: dist/ 에 외부 URL 문자열" >&2
    fail=1
  fi
else
  echo "참고: dist/ 없음. npm run build 후 다시 실행하면 산출물도 검사한다."
fi

if [ "$fail" -eq 0 ]; then echo "privacy check OK"; fi
exit "$fail"
