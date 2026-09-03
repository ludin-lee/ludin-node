# 루딘(Ludin) 기능 명세 v0.1

> Node.js용 API 문서 라이브러리. 기존 OpenAPI 문서 도구가 하는 것을 모두 하되, 그 위에 **인증 · 계정 · IP 제어 · 감사 로그 · 테마** 레이어를 얹는다.
> 작성일: 2026-09-02 · 상태: 초안

---

## 1. 포지셔닝

- 한 줄 정의: **"OpenAPI 문서 위에 얹는 보안/운영 레이어"**
- 기존 문서 도구 대비 갈아탈 이유는 렌더링이 아니라 아래 네 가지다.
  1. 로그인 없이는 docs 진입 불가
  2. 개발자 초대와 역할 기반 접근 제어
  3. IP 화이트리스트
  4. 예쁘고 커스터마이징 가능한 UI
- 여기에 **감사 로그**(누가 언제 어떤 API를 실행했는가)를 더한다. 로그인이 있어야만 가능한 기능이고 기업 고객이 가장 좋아하는 기능이다.
- 프로덕션에 docs를 노출하고 싶지만 nginx basic auth로 때우거나 아예 꺼두던 팀이 1차 타깃.

---

## 2. 배포 형태 및 두 가지 운영 모드

단순 npm 미들웨어 하나. 계정/IP/세션/로그 저장 방식은 **스토리지 어댑터**로 분리하며, 어떤 어댑터를 쓰느냐에 따라 두 모드 중 하나로 동작한다.

| 구분 | 코드 바인딩 모드 (기본) | 스토어 모드 |
|---|---|---|
| 설정 위치 | 코드 + `process.env` | DB (sqlite, postgres, mysql, mongo, redis…) |
| 계정 / IP 관리 | **읽기 전용** — 관리 화면은 "현재 설정 보기"만 | **수정 가능** — 초대, 역할 변경, IP 편집 전부 UI에서 |
| 세션 | 서명된 JWT 쿠키 (무상태) | DB 세션 (강제 로그아웃 · 세션 폐기 가능) |
| 감사 로그 | stdout / 커스텀 sink 콜백 | DB 저장 + UI 조회 |
| 초대 | 불가 (안내 메시지 표시) | 초대 링크/메일 발송 |
| 의존성 | 0에 가깝게 | 어댑터 패키지가 각자 DB 드라이버 보유 |
| 타깃 | 개인 · 소규모 팀 · 5분 도입 | 팀 확장 · 사내 공용 docs |

**설계 원칙**: 두 모드를 억지로 같게 만들지 않는다. 바인딩 모드에서 UI로 수정한 값은 재배포 시 날아가므로 아예 수정 UI를 비활성화하고, "store를 연결하면 사용할 수 있습니다" 안내를 띄운다.

### 2.1 최소 사용 예시 (바인딩 모드)

```ts
import { ludin } from 'ludin';

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

### 2.2 스토어 모드 전환

```ts
import { sqliteStore } from '@ludin/store-sqlite';

app.use('/docs', ludin({
  spec: './openapi.json',
  store: sqliteStore('./ludin.db'),
}));
```

`store` 한 줄 추가로 전환되며 나머지 설정은 그대로 유효하다. 바인딩 설정과 store가 동시에 있으면 **바인딩 값은 seed(초기값)로만 사용**하고 이후 진실은 store.

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

### 3.2 로그인

- 기본: 이메일 + 비밀번호(bcrypt/argon2 해시). 바인딩 모드에서는 env로 받은 **평문 또는 해시** 둘 다 허용(해시 권장, 접두어로 구분)
- 세션: 서명 JWT 쿠키(HttpOnly, SameSite, Secure 자동), 만료 설정 가능
- 로그인 없이는 docs·스펙 JSON·Try it out 프록시 등 **모든 경로** 차단
- 브루트포스 방어: 실패 횟수 기반 지연/잠금(메모리 또는 store)
- 확장 어댑터(v1 이후): OAuth2/OIDC(Google, GitHub, Keycloak 등), 커스텀 `verify(email, password)` 콜백으로 기존 사내 인증 연동
- 선택: 로그인 완전 비활성화(`auth: false`) — IP 제한만 쓰고 싶은 경우

### 3.3 계정 관리 · 역할

역할은 3단계 기본 제공, 커스텀 역할 추가 가능.

| 역할 | 문서 보기 | Try it out | 감사 로그 조회 | 계정/IP 관리 |
|---|---|---|---|---|
| viewer | ○ | ✕ | ✕ | ✕ |
| developer | ○ | ○ | 본인 것만 | ✕ |
| admin | ○ | ○ | ○ | ○ (스토어 모드) |

- **초대 (스토어 모드)**: admin이 이메일 + 역할 입력 → 초대 토큰 발급 → 링크 복사 또는 메일 발송(메일 sender는 콜백/어댑터로 주입) → 초대받은 사람이 비밀번호 설정 → 활성화. 토큰 만료·재발급 지원
- 계정 상태: active / invited / disabled
- **문서 가시성 제어**: 태그·경로·operationId 단위로 `visibleTo: ['admin', 'partner']` 지정 → 역할에 따라 스펙 자체를 필터링해 내려준다(UI 숨김이 아니라 서버에서 제거). 기존 문서 도구로는 불가능한 핵심 차별점
- 바인딩 모드: 계정 목록·역할은 읽기 전용으로 표시, 초대 버튼은 비활성 + 안내

### 3.4 IP 화이트리스트

- 단일 IP, CIDR(`10.0.0.0/8`), 범위, IPv6 지원
- 프록시 환경: `trustProxy` 옵션으로 `X-Forwarded-For` / `X-Real-IP` 처리(신뢰할 hop 수 지정)
- 로그인과의 결합 방식 설정: `ipPolicy: 'and' | 'or'`
  - `and`(기본): 화이트리스트 IP **이고** 로그인해야 진입
  - `or`: 화이트리스트 IP면 로그인 없이, 아니면 로그인 요구
- 역할별/계정별 IP 제한(스토어 모드): 특정 계정은 사무실 IP에서만
- **잠금 방지 탈출구**: `LUDIN_BYPASS_IP_CHECK=1` env 또는 localhost 자동 허용 옵션. 본인 IP를 차단해 잠기는 사고 방지
- 차단 시 로그 남기고 404 또는 403 선택 가능(존재 자체를 숨기고 싶은 경우 404)

### 3.5 감사 로그

- 기록 이벤트: 로그인 성공/실패, 로그아웃, docs 열람, Try it out 실행(메서드·경로·상태코드·소요시간, 바디는 옵션·마스킹 가능), 계정/IP 설정 변경, IP 차단
- 바인딩 모드: 구조화 JSON을 stdout 또는 `onAudit(event)` 콜백으로 전달(외부 로거 연결)
- 스토어 모드: DB 저장, UI에서 필터(사용자·기간·경로)·검색·CSV 내보내기, 보존 기간 설정
- 민감정보 마스킹 규칙(헤더 `Authorization`, 필드명 패턴)

### 3.6 UI · 테마

범위를 **테마 수준**으로 한정한다. 컴포넌트 교체 수준의 커스터마이징은 v1에서 제외(유지보수 폭발 방지).

- 옵션: 로고, 파비콘, 서비스명, 기본/강조 색상, 폰트, 라운드/밀도, 라이트·다크·시스템 모드
- 커스텀 CSS 주입(`customCss`), 로그인 화면 문구·배경 커스터마이징
- 사이드바 그룹 순서·접힘 상태 설정
- 기존 문서 UI보다 빠른 초기 로드(코드 스플리팅, 대형 스펙 가상 스크롤)
- 반응형(모바일에서 문서 열람 가능)

---

## 4. 아키텍처

### 4.1 패키지 구조

```
ludin                  코어 (핸들러, 인증, IP, 감사, UI 번들, 인메모리 스토어) — 런타임 의존성 1개(yaml)
@ludin/store-sqlite    내장 node:sqlite, 없으면 better-sqlite3 폴백                   [출시]
@ludin/store-postgres  pg 기반                                                       [예정]
@ludin/store-prisma    기존 Prisma 클라이언트 재사용                                   [예정]
@ludin/store-redis     세션·로그 전용 경량 스토어                                      [예정]
@ludin/auth-oidc       OAuth2/OIDC 어댑터                                            [v1 이후]
```

스토어를 별도 패키지로 분리하여 바인딩 모드 사용자가 DB 드라이버를 설치하지 않게 한다. 개발·테스트용으로는 코어의 `createMemoryStore()`가 영속성 없이 스토어 모드 기능 전체를 제공한다.

### 4.2 스토리지 어댑터 인터페이스

```ts
interface LudinStore {
  readonly?: boolean;                    // true for the built-in binding-mode store
  users: {
    findByEmail(email): Promise<StoredUser | null>;
    findById?(id): Promise<StoredUser | null>;
    list(): Promise<StoredUser[]>;
    create?(input: NewUser): Promise<StoredUser>;
    update?(id, patch): Promise<StoredUser>;
    remove?(id): Promise<void>;
  };
  ipRules: { list(): Promise<IpRule[]>; upsert?(rule): Promise<IpRule>; remove?(id): Promise<void> };
  invites?: {
    create(invite: Invite): Promise<Invite>;
    findByTokenHash(tokenHash): Promise<Invite | null>;
    list(): Promise<Invite[]>;
    markAccepted(id, at): Promise<void>;
    remove(id): Promise<void>;
  };
  sessions?: {
    create(session: Session): Promise<Session>;
    get(id): Promise<Session | null>;
    touch?(id, at): Promise<void>;
    listForUser(userId): Promise<Session[]>;
    revoke(id): Promise<void>;
    revokeAllForUser(userId): Promise<void>;
  };
  audit?: {
    append(event: AuditEvent): Promise<void>;
    query?(filter: AuditFilter): Promise<Page<AuditEvent>>;
    prune?(before: string): Promise<number>;   // retention
  };
}
```

`users` / `ipRules` 이후는 전부 선택 사항이다. 스토어는 구현한 만큼만 능력을 광고하고, 코어는 그것을 capabilities(`users`, `invites`, `ipRules`, `sessions`, `auditQuery`)로 UI에 내려보내 버튼 활성/비활성을 결정한다.

보안에 관련된 처리는 어댑터가 아니라 항상 코어에 둔다: 비밀번호 해싱, 초대 토큰 생성(스토어에는 SHA-256 해시만 저장), 세션 id 발급, 마지막 admin 제거·자기 잠금(self-lockout) 차단 가드.

바인딩 모드는 이 인터페이스의 **읽기 전용 메모리 구현체**를 내부적으로 사용한다. 즉 코어는 항상 store를 통해서만 데이터에 접근하고, 모드 차이는 어댑터 차이일 뿐이다.

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
- 초기 설계에서 확정해야 나중에 갈아엎지 않는 항목

### 4.4 요청 처리 순서

```
요청 → IP 검사 → (ipPolicy에 따라) 세션 검사 → 역할 검사
   → 스펙 필터링(visibleTo) → 렌더 / API 응답 → 감사 로그 기록
```

### 4.5 스토어 모드 API 표면

전부 동일한 파이프라인(§4.4)을 거치며, 별도 표기가 없으면 `admin:write`가 필요하다. 설치된 스토어가 해당 기능을 지원하지 않으면 `501 store_required`로 응답한다 — 바인딩 모드가 돌려주는 응답과 같다.

| 메서드 · 경로 | 용도 |
|---|---|
| `POST /api/admin/users` · `PATCH|DELETE /api/admin/users/:id` | 계정 생성 / 수정 / 삭제 |
| `POST /api/admin/users/:id/revoke-sessions` | 강제 로그아웃 |
| `POST /api/session/revoke-all` | 모든 기기에서 로그아웃 (로그인한 사용자 누구나) |
| `POST /api/admin/ip` · `DELETE /api/admin/ip/:id` | IP 규칙 편집 (`force` 없이는 자기 잠금 거부) |
| `POST /api/admin/invites` · `DELETE /api/admin/invites/:id` | 초대 발급 / 취소 |
| `GET /api/invites/info` · `POST /api/invites/accept` | **공개**: 초대 수락 화면과 비밀번호 설정 |
| `GET /api/audit` · `GET /api/audit.csv` | 감사 로그 조회 / 내보내기 (`audit:read`, `audit:read:self`는 본인 것만) |

---

## 5. 설정 스키마 요약

```ts
interface LudinOptions {
  spec: string | object | (() => Promise<object>) | SpecEntry[];
  store?: LudinStore;
  auth?: false | {
    users?: BoundUser[];                 // 바인딩 모드
    session?: { secret?: string; ttl?: string };
    verify?: (email, password) => Promise<User | null>;
    providers?: AuthProvider[];          // OIDC 등
    lockout?: { attempts: number; window: string };
  };
  ipAllowlist?: string[];
  ipPolicy?: 'and' | 'or';
  trustProxy?: boolean | number;
  roles?: Record<string, Permission[]>;  // 커스텀 역할
  visibility?: Record<string, string[]>; // tag/path → roles
  audit?: { sink?: (e: AuditEvent) => void; mask?: string[]; retentionDays?: number };
  theme?: ThemeOptions;
  basePath?: string;
}
```

---

## 6. 로드맵

| 단계 | 상태 | 범위 |
|---|---|---|
| **v0.1 (MVP)** | 완료 | OpenAPI 3.x 렌더링 + Try it out, 이메일/비밀번호 로그인(JWT 쿠키), 바인딩 모드 계정·IP(읽기 전용), IP 화이트리스트(CIDR, trustProxy, 탈출구), 기본 테마 옵션, stdout 감사 로그, Express·Fastify 어댑터 |
| **v0.2** | 완료 | 스토어 모드(sqlite), 초대 플로우, 역할 편집 UI, IP 편집 UI, DB 세션·강제 로그아웃, 감사 로그 UI·CSV·보존 기간, 계정별 IP 제한 |
| **v0.3** | 완료 | 문서 가시성 제어(visibleTo), 다중 스펙, 검색·딥링크 고도화, NestJS 모듈·Koa·Hono·node:http 어댑터, 커스텀 CSS·다크모드 |
| **v1.0** | 예정 | OIDC/OAuth2 어댑터, Postgres·Prisma·Redis 스토어, 안정 API 확정 |

---

## 7. 열린 결정 사항

- 패키지 이름 `ludin` npm 확보 여부 확인
- 프론트엔드 스택(React vs Preact vs Svelte — 번들 크기 우선이면 Preact/Svelte)
- 바인딩 모드 비밀번호: 평문 env 허용할지, 해시만 허용할지(도입 편의 vs 보안)
- 초대 메일 발송 기본 구현을 넣을지(nodemailer 의존) vs 콜백만 제공할지
- 감사 로그의 Try it out 요청/응답 바디 기록 기본값(off 권장)