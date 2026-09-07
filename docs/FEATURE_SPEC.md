# 루딘(Ludin) 기능 명세 v0.2

> Node.js용 API 문서 라이브러리. 기존 OpenAPI 문서 도구가 하는 것을 모두 하되, 그 위에 **인증 · 계정 · IP 제어 · 감사 로그 · 테마** 레이어를 얹는다.
> 작성일: 2026-09-02 · 갱신일: 2026-09-07 · 상태: 초안

---

## 1. 포지셔닝

- 한 줄 정의: **"OpenAPI 문서 위에 얹는 보안/운영 레이어"**
- 기존 문서 도구 대비 갈아탈 이유는 렌더링이 아니라 아래 네 가지다.
  1. 로그인 없이는 docs 진입 불가
  2. 역할 기반 접근 제어와 역할별 문서 필터링
  3. IP 화이트리스트
  4. 예쁘고 커스터마이징 가능한 UI
- 여기에 **감사 로그**(누가 언제 어떤 API를 실행했는가)를 더한다. 로그인이 있어야만 가능한 기능이고 기업 고객이 가장 좋아하는 기능이다.
- 프로덕션에 docs를 노출하고 싶지만 nginx basic auth로 때우거나 아예 꺼두던 팀이 1차 타깃.

---

## 2. 배포 형태

단순 npm 미들웨어 하나. **DB도, 빌드 단계도, 별도 서비스도 없다.** 계정 · IP 규칙 · 역할은 전부 코드와 `process.env`에서 오고, 바꾸려면 재배포한다.

| 구분 | 내용 |
|---|---|
| 설정 위치 | 코드 + `process.env` |
| 계정 / IP 관리 | **읽기 전용** — 관리 화면은 "현재 설정 보기" |
| 세션 | 서명된 JWT 쿠키 (무상태) |
| 감사 로그 | stdout / 커스텀 sink 콜백 |
| 런타임 의존성 | 코어 1개(`yaml`) |

**설계 원칙**: 문서 접근 통제에 필요 없는 것은 넣지 않는다. UI에서 계정을 편집하게 하려면 DB·마이그레이션·세션 저장소가 따라오고, 그렇게 얻는 것은 "재배포 없이 계정 추가"뿐이다. 계정은 코드에 두고, 라이브러리는 문 앞을 지키는 일에 집중한다.

### 2.1 최소 사용 예시

```ts
import { ludin } from '@ludin/express';

app.use('/docs', ludin({
  spec: './openapi.json',
  auth: {
    users: [
      { email: 'admin@example.com', password: process.env.LUDIN_ADMIN_PW, role: 'admin' },
      { email: 'dev@example.com',   password: process.env.LUDIN_DEV_PW,   role: 'developer' },
    ],
  },
  ipAllowlist: (process.env.LUDIN_IPS ?? '').split(','),
  theme: { primary: '#0f766e', logo: '/logo.svg' },
}));
```

### 2.2 내 HTML 페이지 붙이기

```ts
app.use('/docs', ludin({
  spec: './openapi.json',
  readme: { enabled: true, path: './docs/guide.html', label: 'Guide' },
}));
```

`readme` 한 줄이면 상단 바에 버튼이 생기고, 그 HTML 파일이 레퍼런스와 **같은 로그인 · IP · 역할 검사** 뒤에 놓인다. 상세는 §3.7.

---

## 3. 기능 명세

### 3.1 OpenAPI 렌더링 (기존 도구 패리티)

- OpenAPI 3.0 / 3.1 지원, OpenAPI 2.0(구 스펙)은 자동 변환
- 입력: JSON/YAML 파일 경로, 객체, URL, 또는 함수(동적 생성)
- 태그별 그룹핑, 경로/메서드 목록, 스키마 뷰어(중첩·재귀·oneOf/anyOf/allOf)
- Try it out: 파라미터 폼, 요청 바디 에디터, 응답 표시, cURL 복사
- Security scheme 지원: apiKey, http(basic/bearer), oauth2, openIdConnect — 입력한 자격 증명은 브라우저 세션에만 저장
- 검색(경로·요약·태그), 딥링크(`#tag/operationId`)
- 다중 스펙(여러 서비스 문서를 하나의 루딘에서 전환)
- 스펙 내보내기: 첫 화면에서 JSON/YAML 파일로 내려받기. **역할별 필터링이 적용된 문서**가 나가며 `docs.export` 감사 이벤트로 기록된다

### 3.2 로그인

- 기본: 이메일 + 비밀번호(scrypt 내장, bcrypt/argon2 선택). env로 받은 **평문 또는 해시** 둘 다 허용(해시 권장, 접두어로 구분)
- 세션: 서명 JWT 쿠키(HttpOnly, SameSite, Secure 자동), 만료 설정 가능
- 로그인 없이는 docs·스펙 JSON·README 페이지·Try it out 프록시 등 **모든 경로** 차단
- 브루트포스 방어: 실패 횟수 기반 지연/잠금(메모리)
- 확장 어댑터(v1 이후): OAuth2/OIDC(Google, GitHub, Keycloak 등). 지금도 커스텀 `verify(email, password)` 콜백으로 기존 사내 인증에 연동할 수 있다
- 선택: 로그인 완전 비활성화(`auth: false`) — IP 제한만 쓰고 싶은 경우

### 3.3 계정 · 역할

역할은 3단계 기본 제공, 커스텀 역할 추가 가능.

| 역할 | 문서 보기 | Try it out | 설정 보기 |
|---|---|---|---|
| viewer | ○ | ✕ | ✕ |
| developer | ○ | ○ | ✕ |
| admin | ○ | ○ | ○ |

- 계정은 `auth.users` 배열 또는 `auth.verify` 콜백에서 온다. 관리 화면은 **읽기 전용**: 계정 목록, IP 규칙, 역할·권한, 가시성 규칙, 연결된 README 페이지를 보여준다
- **문서 가시성 제어**: 태그·경로·operationId 단위로 `visibleTo: ['admin', 'partner']` 지정 → 역할에 따라 스펙 자체를 필터링해 내려준다(UI 숨김이 아니라 서버에서 제거). 기존 문서 도구로는 불가능한 핵심 차별점
- 계정별 IP 제한: `ipAllowlist`를 계정에 직접 달면 그 계정은 해당 주소에서만 로그인·열람 가능

### 3.4 IP 화이트리스트

- 단일 IP, CIDR(`10.0.0.0/8`), 범위, IPv6 지원
- 프록시 환경: `trustProxy` 옵션으로 `X-Forwarded-For` / `X-Real-IP` 처리(신뢰할 hop 수 지정)
- 로그인과의 결합 방식 설정: `ipPolicy: 'and' | 'or'`
  - `and`(기본): 화이트리스트 IP **이고** 로그인해야 진입
  - `or`: 화이트리스트 IP면 로그인 없이, 아니면 로그인 요구
- 계정별 IP 제한: 특정 계정은 사무실 IP에서만
- **잠금 방지 탈출구**: `LUDIN_BYPASS_IP_CHECK=1` env 또는 localhost 자동 허용 옵션. 본인 IP를 차단해 잠기는 사고 방지
- 차단 시 로그 남기고 404 또는 403 선택 가능(존재 자체를 숨기고 싶은 경우 404)

### 3.5 감사 로그

- 기록 이벤트: 로그인 성공/실패, 로그아웃, docs 열람, 스펙 내려받기, README 페이지 열람, Try it out 실행(메서드·경로·상태코드·소요시간, 바디는 옵션·마스킹 가능), IP 차단
- 구조화 JSON을 stdout 또는 `audit.sink(event)` 콜백으로 전달한다. 보존·조회·검색은 이미 쓰고 있는 로그 파이프라인의 몫이다
- 민감정보 마스킹 규칙(헤더 `Authorization`, 필드명 패턴)

### 3.6 UI · 테마

범위를 **테마 수준**으로 한정한다. 컴포넌트 교체 수준의 커스터마이징은 v1에서 제외(유지보수 폭발 방지).

- 옵션: 로고(URL·data URI, 다크 모드 전용 `logoDark` 별도 지정 가능), 파비콘, 서비스명(플랫폼 이름), 기본/강조 색상, 폰트, 라운드/밀도, 라이트·다크·시스템 모드
- 커스텀 CSS 주입(`customCss`), 로그인 화면 문구·배경 커스터마이징
- 사이드바 그룹 순서·접힘 상태 설정
- 기존 문서 UI보다 빠른 초기 로드(단일 HTML 번들 65 KB, gzip 21 KB)
- 반응형(모바일에서 문서 열람 가능)

### 3.7 README 페이지 (HTML 직결)

레퍼런스만으로는 부족하다. 가이드, 온보딩 체크리스트, 릴리스 노트 — 이미 만들어 둔 HTML이 있다면 그 파일 경로만 주면 된다.

```ts
readme: { enabled: true, path: './docs/guide.html', label: 'Guide', visibleTo: ['admin'] }
readme: './docs/guide.html'   // 기본값으로 쓰는 축약형
```

| 옵션 | 의미 |
|---|---|
| `enabled` | `false`면 설정을 지우지 않고 버튼만 감춘다. 기본 `true` |
| `path` | HTML 파일 경로. 절대 경로 또는 `process.cwd()` 기준 상대 경로 |
| `label` | 상단 바 버튼 문구. 기본 `README` |
| `visibleTo` | 열람 가능한 역할. 기본값은 문서를 볼 수 있는 모든 역할 |

- 페이지는 `GET {basePath}/readme`로 서빙되며 다른 라우트와 **똑같은 파이프라인**(IP → 세션 → 역할)을 거친다. 열람은 `docs.readme` 감사 이벤트로 남는다
- 파일은 가공 없이 그대로 나간다. 대신 응답에 `Content-Security-Policy: sandbox`를 실어 **불투명 origin**으로 보내고, UI는 `sandbox` 속성을 건 iframe으로 띄운다 → 파일의 CSS·스크립트는 그대로 동작하지만 세션 쿠키나 문서 UI의 DOM에는 접근할 수 없다
- mtime 기준으로 캐시하고 파일이 바뀌면 다시 읽는다. 문서를 고치는 데 재시작이 필요 없다
- 파일 크기 상한 5 MB. 파일이 없거나 상한을 넘으면 서버 로그에 이유를 남기고 `404`로 응답한다

---

## 4. 아키텍처

### 4.1 패키지 구조

```
ludin                  코어 (핸들러, 인증, IP, 감사, UI 번들) — 런타임 의존성 1개(yaml)
@ludin/express         Express 4 / 5                                                 [출시]
@ludin/fastify         Fastify 4 / 5                                                 [출시]
@ludin/koa             Koa 2                                                         [출시]
@ludin/hono            Hono 4 (Node · Bun · Deno · edge)                             [출시]
@ludin/node            Node 기본 http, connect, polka                                 [출시]
@ludin/nestjs          NestJS 9 / 10 / 11                                            [출시]
@ludin/auth-oidc       OAuth2/OIDC 어댑터                                            [v1 이후]
```

코어의 런타임 의존성은 `yaml` 하나다. UI(`packages/ui`, Preact + Vite)는 단일 HTML 문자열로 빌드되어 코어 안에 컴파일되므로, 설치 후 별도 정적 파일 서빙이 필요 없다.

### 4.2 계정 · 설정 소스

```ts
interface BoundUser {
  email: string;
  password: string;        // 평문 또는 해시($scrypt$ · bcrypt · argon2)
  role?: Role;             // 기본 'developer'
  name?: string;
  ipAllowlist?: string[];  // 이 계정만의 IP 제한
}
```

- 계정은 `auth.users`(정적 목록) 또는 `auth.verify(email, password)`(사내 인증 연동) 중 하나에서 온다. 코어는 로그인 시점에만 이를 조회하고, 그 결과를 서명된 쿠키에 담는다
- IP 규칙은 `ipAllowlist` 배열, 역할은 `roles`, 가시성은 `visibility`에서 온다. 전부 프로세스 시작 시 검증되며 잘못된 역할 이름·CIDR은 즉시 예외로 알린다
- 보안에 관련된 처리는 전부 코어에 있다: 비밀번호 해싱·검증, 세션 서명, IP 매칭, 브루트포스 잠금, README 파일 읽기와 샌드박스 헤더

### 4.3 프레임워크 어댑터

코어는 `(Request 표준 객체) → Response` 형태의 프레임워크 무관 핸들러로 작성하고, 얇은 어댑터로 감싼다.

| 패키지 | 프레임워크 | 마운트 |
|---|---|---|
| `@ludin/express` | Express 4 / 5 | `app.use('/docs', ludin({ ... }))` |
| `@ludin/fastify` | Fastify 4 / 5 | `app.register(ludin({ ... }), { prefix: '/docs' })` |
| `@ludin/koa` | Koa 2 | `app.use(ludin({ basePath: '/docs', ... }))` |
| `@ludin/hono` | Hono 4 (Node · Bun · Deno · edge) | `mountLudin(app, { basePath: '/docs', ... })` |
| `@ludin/nestjs` | NestJS 9 / 10 / 11 | `setupLudin(app, '/docs', document)` 또는 `LudinModule.forRoot({ ... })` |
| `@ludin/node` | Node 기본 `http`, connect, polka | `docs(req, res, next)` 또는 `createLudinServer({ ... })` |

- 어댑터는 요청/응답 형태 변환만 담당하고, 모든 라우트는 코어 파이프라인(§4.4)을 그대로 거친다. 프레임워크 추가 = 어댑터 패키지 추가, 코어 수정 없음.
- 피어 주소를 노출하지 않는 런타임(Cloudflare Workers, Vercel Edge 등)은 IP 규칙을 쓰려면 `trustProxy` + 프록시 헤더가 필요하다.

### 4.4 요청 처리 순서

```
요청 → IP 검사 → (ipPolicy에 따라) 세션 검사 → 역할 검사
   → 스펙 필터링(visibleTo) → 렌더 / API 응답 → 감사 로그 기록
```

### 4.5 API 표면

전부 동일한 파이프라인(§4.4)을 거친다. 우회 경로는 만들지 않는다.

| 메서드 · 경로 | 용도 |
|---|---|
| `GET /` | 문서 UI (단일 HTML) |
| `GET /readme` | 연결된 HTML 페이지 (`docs:read` + `visibleTo`, 샌드박스 헤더) |
| `GET /api/me` | **공개**: 세션 상태, 권한, README 버튼 노출 여부 |
| `POST /api/login` · `POST /api/logout` | **공개**: 로그인 / 로그아웃 |
| `GET /api/specs` · `GET /api/spec` | 스펙 목록 / 역할 필터링된 문서 (`docs:read`) |
| `GET /api/spec.json` · `GET /api/spec.yaml` | 역할 필터링된 문서를 파일로 내려받기 (`docs:read`) |
| `POST /api/try` | Try it out 서버 사이드 프록시 (`docs:try`) |
| `GET /api/admin` | 현재 설정 조회 (`admin:read`, 읽기 전용) |

상태 변경 요청은 `X-Requested-With: ludin` 헤더를 요구한다(CSRF 방어).

---

## 5. 설정 스키마 요약

```ts
interface LudinOptions {
  spec: string | object | (() => Promise<object>) | SpecEntry[];
  auth?: false | {
    users?: BoundUser[];
    session?: { secret?: string; ttl?: string; cookieName?: string };
    verify?: (email, password) => Promise<AuthUser | null>;
    lockout?: { attempts: number; window: string };
  };
  ipAllowlist?: string[];
  ipPolicy?: 'and' | 'or';
  ipAllowlistRole?: Role;
  trustProxy?: boolean | number;
  allowLocalhost?: boolean;
  hideOnBlock?: boolean;
  roles?: Record<string, Permission[]>;  // 커스텀 역할
  visibility?: Record<string, string[]>; // tag/path → roles
  readme?: string | { enabled?: boolean; path: string; label?: string; visibleTo?: Role[] };
  audit?: { sink?: (e: AuditEvent) => void | false; mask?: string[]; recordBodies?: boolean };
  theme?: ThemeOptions;
  allowedTargets?: string[];
  basePath?: string;
}
```

---

## 6. 로드맵

| 단계 | 상태 | 범위 |
|---|---|---|
| **v0.1 (MVP)** | 완료 | OpenAPI 3.x 렌더링 + Try it out, 이메일/비밀번호 로그인(JWT 쿠키), 계정·IP 설정(읽기 전용 관리 화면), IP 화이트리스트(CIDR, trustProxy, 탈출구), 기본 테마 옵션, stdout 감사 로그, Express·NestJS 어댑터 |
| **v0.2** | 완료 | README 페이지(HTML 직결), 스펙 내보내기, 문서 가시성 제어(visibleTo), 다중 스펙, 로고·다크모드 브랜딩, Fastify·Koa·Hono·node:http 어댑터 |
| **v0.3** | 예정 | OIDC/OAuth2 어댑터 |
| **v1.0** | 예정 | 안정 API 확정 |

v0.2 개발 중 DB 기반 스토어 모드(계정 편집·초대·세션 폐기·감사 로그 UI)를 만들었다가 출시 전에 걷어냈다. 문서 앞의 문을 지키는 데 필요하지 않았고, DB·마이그레이션·드라이버가 도입 비용을 키웠기 때문이다. 계정은 코드에, 로그는 이미 쓰는 로그 파이프라인에 둔다.

---

## 7. 열린 결정 사항

- 패키지 이름 `ludin` npm 확보 여부 확인
- 비밀번호: 평문 env 허용할지, 해시만 허용할지(도입 편의 vs 보안)
- README 페이지를 여러 개(탭)로 확장할지, 단일 페이지로 유지할지
- 마크다운(`.md`) 파일도 `readme.path`로 받을지(현재는 HTML만)
- 감사 로그의 Try it out 요청/응답 바디 기록 기본값(off 권장)
