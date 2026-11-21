# app — 실제 앱 코드

서버 없는 정적 웹 앱(PWA). GitHub Pages로 배포해 휴대폰 브라우저에서 씀. 예정 구조:

```
app/
├─ index.html       화면 전체(단일 페이지, 프로토타입 디자인 이식)
├─ app.js           화면 동작
├─ gemini.js        Gemini API 호출(유튜브 링크 정리)
├─ youtube.js       링크 → 영상 ID, YouTube Data API(설명란·댓글), IFrame 플레이어 구간 재생
├─ store.js         IndexedDB 저장, 백업 내보내기·가져오기
├─ style.css
├─ manifest.json    PWA(홈 화면 아이콘)
└─ sw.js            오프라인 보기(서비스 워커)
```

## 지금 있는 파일(2026-11-21)
- `test.html`: 1단계 정리 시험실(링크 → Gemini 정리, 시간·토큰 측정, 구간 재생, 시각 정확도 표시).
- `youtube.js`: 링크 → 영상 ID, YouTube Data API(정보·설명란·채널 주인 댓글), 구간 재생 플레이어.
- `gemini.js`: 모델 목록, 프롬프트 읽기·채우기, 정리 요청·형식 검사(깨지면 1회 재요청).

- 프롬프트는 `../prompts/` 파일을 읽어 씀. 배포 때 `app/`과 `prompts/`를 함께 올림.
- PC에서 확인: 프로젝트 폴더에서 `python -m http.server 8000` 후 `http://localhost:8000/app/test.html`.
  - 파일을 더블클릭해 열면(file://) 프롬프트 읽기와 유튜브 플레이어가 안 됨. 반드시 서버로 열기.
  - 같은 와이파이 휴대폰: `http://PC주소:8000/app/test.html`(Windows 방화벽 허용 필요할 수 있음).
- 구조는 확정 아님. 바뀌면 이 파일과 `CLAUDE.md` 폴더 표를 같이 고침.
