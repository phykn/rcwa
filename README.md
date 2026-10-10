# RCWA Workbench

읽기 쉬운 작은 RCWA/OCD 프로토타입입니다. React 화면 → FastAPI 작업 API → 독립 Python 수치 프로세스 → meent의 NumPy RCWA를 연결합니다. 계산 결과를 실제 실행하지 않고 만들어내는 대체 모델은 사용하지 않습니다.

## 지원 범위

- ambient / **단일 1D 직사각형 패턴층** / substrate
- 등방성 비자성 재료, 비흡수 ambient, 흡수 가능 substrate, 무한 주기 구조, classical mounting (입사면 x–z, 선 방향 y)
- 진공 파장, 표면 법선 기준 입사각, s/TE 또는 p/TM 평면파
- 상수 n,k 및 선형 보간 재료표; 표 밖 외삽 금지
- 반사/투과의 전체 회절차수 합계와 0차(specular) 성분을 구분
- 프로젝트/결과 JSON 내보내기·다시 열기, DB 스냅샷 저장
- 검증용 합성 CD-only 역산. 실측 OCD 정확도나 유일해를 보장하는 기능이 아닙니다.

여러 층을 담는 데이터 구조를 쓰지만 현재 계산은 정확히 한 층만 허용합니다. 임의 형상, conical incidence, 2D, 비등방성, 타원편광 Ψ/Δ, 유한 빔/타깃, GPU, 실측 데이터 피팅은 범위 밖입니다.

## 폴더와 역할

```
backend/
  api/main.py           HTTP 입력 검증과 경로
  api/jobs.py           최대 2개 독립 프로세스, 시간 제한·취소
  api/storage.py        프로젝트 스냅샷 저장 (SQLAlchemy)
  rcwa_core/schemas.py  엔진과 무관한 입력 규약
  rcwa_core/solver.py   meent 어댑터와 결과 규약
  rcwa_core/fitting.py  작은 합성 CD 역산 실험
  tests/                물리·API·저장 테스트
frontend/src/           화면, API 연결, 결과 표시
.github/workflows/     무료 표준 GitHub Actions 검사
compose.yaml           로컬 PostgreSQL
```

단순한 수직 구조를 유지합니다. Redis, 분산 작업 큐, 플러그인 프레임워크는 없습니다. 엔진 호출은 solver.py에 집중합니다.

## 무료 로컬 실행

Python 3.12+, Node.js 22+가 필요합니다. 패키지는 공개 레지스트리에서 설치합니다. 유료 서비스 계정이 필요하지 않습니다.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-lock.txt
cd frontend && npm ci && cd ..
```

터미널 1 (간편 SQLite 데모):

```sh
. .venv/bin/activate
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

터미널 2:

```sh
cd frontend
npm run dev -- --host 127.0.0.1
```

http://localhost:5173 를 엽니다. API 문서는 http://localhost:8000/docs 입니다.

### PostgreSQL 사용

```sh
docker compose up -d db
export DATABASE_URL='postgresql+psycopg://rcwa:local-development-only@localhost:5432/rcwa'
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

`.env.example`은 참고 파일이며 자동으로 읽지 않습니다. 위 환경 변수를 셸에서 설정하세요. PostgreSQL이 준비되지 않으면 API 시작이 실패합니다. 설정한 PostgreSQL 실패를 SQLite로 조용히 대체하지 않습니다. DATABASE_URL을 지정하지 않은 경우에만 SQLite 데모가 선택됩니다.

## 검사

```sh
. .venv/bin/activate
ruff check backend
pytest -q
cd frontend
npm run lint
npm run build
```

PostgreSQL 통합 테스트는 TEST_POSTGRES_URL이 있을 때 실행합니다. GitHub CI에 별도 PostgreSQL 서비스를 구성했습니다. 로컬 서비스가 없으면 해당 검사만 명시적으로 skip합니다. 실제 실행 결과와 제한은 docs/validation.md를 확인하세요.

## GitHub와 모바일

GitHub Actions는 코드·물리 테스트에, GitHub Pages는 정적 React 화면에 사용할 수 있습니다. **Pages는 Python/meent 계산 서버가 아닙니다.** API가 없는 페이지는 연결 상태를 표시하고 계산을 실행할 수 없습니다. `VITE_API_BASE_URL`은 빌드 시 연결할 API 주소를 설정합니다. HTTPS 페이지에서 HTTP 로컬 API에 연결하면 브라우저 보안 정책 때문에 차단될 수 있습니다.

이 버전은 인증이 없는 로컬 개발용입니다. 공개 인터넷에 API를 노출하거나 임시 터널을 열지 마세요. 멀티유저 인증·사용량 제한·TLS·배포 운영은 구현하지 않았습니다.

## 작업과 저장의 수명

API는 **단일 worker**로 실행합니다. 작업은 메모리에서 최대 100개 이력만 보관하고 재시작 시 사라집니다. 동시에 2개 작업을 받으며 꽉 차면 429를 반환합니다. 작업당 120초 제한으로 실제 수치 프로세스를 종료합니다. 완료 결과는 DB에 저장하거나 JSON을 내보내 보관하세요. 프로젝트 저장은 덮어쓰기 대신 새 스냅샷을 만듭니다.

길이 nm, 복소 굴절률 입력은 n ≥ 0, k ≥ 0의 수동 물질 표기입니다. 엔진 내부의 복소 부호, 차수 및 파워 정규화는 결과 metadata와 docs/physics.md에 기록합니다. n,k 예제값은 실재 재료 데이터베이스가 아닌 합성값입니다.

## 의존성 및 라이선스

수치 엔진: [meent](https://github.com/kc-ml2/meent), MIT. 정확한 버전은 requirements.txt와 결과 metadata에 기록합니다. 프로젝트 자체 라이선스는 소유자가 선택하기 전까지 부여하지 않았습니다. 독립 solver를 검증용으로 사용했다면 docs/validation.md에 버전·범위·실행 여부를 구분합니다.

### 무료 Pages 참고 화면

공개 저장소에 push하고 Settings → Pages → Source를 GitHub Actions로 선택하면 `Checks` 성공 후 정적 참고 화면을 배포하는 workflow가 준비되어 있습니다. `VITE_STATIC_PREVIEW=true` 빌드는 사전에 실제 Python 엔진으로 계산한 예제만 표시합니다. 예제의 입력값을 바꾸어도 새 물리 결과가 계산되는 것은 아닙니다. 현재 로컬 계산 API는 공개하지 않습니다. 참고: [GitHub 공식 Pages workflow 문서](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
