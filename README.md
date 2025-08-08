
# 📚 단어줍줍 – 정확도 모드 (AI 검토)

이미지에서 영어 단어와 (있다면) 한국어 뜻을 AI가 추출합니다.  
한글 뜻이 없을 때만 자동 사전으로 채울 수 있고, 신뢰도(confidence) 낮은 항목은 노란색으로 표시해 검토하세요.  
3분 이내 정확한 단어장을 PDF/CSV/인쇄로 뽑을 수 있습니다.

## 구성
- Frontend: `index.html`, `style.css`, `app.js`
- Backend(API): `api/analyze.js` (Vercel 서버리스 함수)
- 필요 환경변수: `OPENAI_API_KEY`

## 배포(Vercel 권장)
1. 이 폴더를 GitHub에 푸시
2. [Vercel](https://vercel.com) → New Project → GitHub 저장소 선택 → Deploy
3. Vercel 프로젝트 Settings → Environment Variables:
   - `OPENAI_API_KEY` : (OpenAI 키)
4. 재배포 후 `https://프로젝트명.vercel.app` 접속

## 사용법
1. 이미지 업로드 → **AI 분석 시작**
2. 표에서 신뢰도 낮은 항목(노란색)을 확인/수정
3. 옵션이 `뜻 자동 채우기`이면 빈 뜻은 무료 사전으로 채움
4. **PDF 저장**, **CSV 내보내기**, **인쇄** 이용

## 주의
- 개인정보가 포함된 이미지는 업로드하지 마세요.
- 무료 번역 API는 간혹 느리거나 실패할 수 있습니다. (실패 시 문구 표시)
