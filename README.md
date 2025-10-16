# axios-token-refresh (createTokenAxios)

토큰 기반 인증을 쓰는 앱에서 **Axios 401 응답 시 자동 토큰 갱신**, **동시성 제어(한 번만 갱신)**, **요청 도중 토큰 교체**를 제공하는 패키지.

- 401 → refresh → **자동 재시도**
- **Promise Lock**: 동시 401에도 **refresh 1회만**
- **Stale token** 처리: 요청 보낼 때와 현재 저장된 토큰이 다르면 **새 토큰으로 바로 재시도**
- 헤더명/스킴 커스터마이즈(`Authorization`/`Bearer ` 외)

---

## 설치

```bash
npm i axios-token-refresh
npm i axios
```

> 권장 `peerDependencies`: `"axios": "^1.6.0"`

---

## 빠른 시작 (Quick Start)

```ts
import { createTokenAxios } from "axios-token-refresh";
import { createStore } from "zustand/vanilla";
import type { AxiosInstance } from "axios";

// 예시: zustand 토큰 저장소
type AuthState = {
  accessToken: string | null;
  setAccessToken: (t: string | null) => void;
};
export const useAuthStore = createStore<AuthState>((set) => ({
  accessToken: null,
  setAccessToken: (t) => set({ accessToken: t })
}));

// 인스턴스 생성
const { client: api } = createTokenAxios({
  baseURL: "https://api.example.com",
  withCredentials: true,

  getAccessToken: () => useAuthStore.getState().accessToken,
  setAccessToken: (t) => useAuthStore.getState().setAccessToken(t),

  // refresh 호출: 새 accessToken 반환
  refreshRequest: async (refreshAxios) => {
    const res = await refreshAxios.post<{ accessToken: string }>("/auth/refresh");
    return res.data.accessToken;
  },

  // 옵션(기본값)
  headerName: "Authorization",
  headerScheme: "Bearer ",
  shouldRefresh: (err) => err.response?.status === 401
});

// 사용
const me = await api.get("/me"); // 401이면 자동으로 refresh 후 재시도
```

---

## API

### `createTokenAxios(opts: CreateTokenAxiosOptions) => TokenAxiosReturn`

#### CreateTokenAxiosOptions

| 옵션                   | 타입                                               | 기본값            | 설명                                                              |
| ---------------------- | -------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `baseURL`              | `string`                                           | -                 | Axios 인스턴스 기본 URL                                           |
| `withCredentials`      | `boolean`                                          | `true`            | 쿠키 자격 여부                                                    |
| `getAccessToken`       | `() => string \| null \| undefined`                | **필수**          | 현재 access token 읽기                                            |
| `setAccessToken`       | `(token: string \| null) => void`                  | **필수**          | 새 access token 저장(또는 null로 정리)                            |
| `refreshRequest`       | `(refreshAxios: AxiosInstance) => Promise<string>` | **필수**          | refresh HTTP 호출(새 access token 반환)                           |
| `shouldRefresh`        | `(error: AxiosError) => boolean`                   | `status === 401`  | 어떤 에러를 갱신 트리거로 볼지(예: 419/440 등)                    |
| `onRefreshFailure`     | `(error: AxiosError) => void \| Promise<void>`     | -                 | refresh 실패 시 후처리(로그아웃, 리다이렉트 등)                   |
| `headerName`           | `string`                                           | `"Authorization"` | 토큰을 실을 헤더 키                                               |
| `headerScheme`         | `string`                                           | `"Bearer "`       | 헤더 prefix (빈 문자열 허용)                                      |
| `retryFlagKey`         | `string`                                           | `"_retry"`        | 재시도 마킹 키(무한 재귀 방지)                                    |
| `createRefreshAxios`   | `() => AxiosInstance`                              | 내부 생성         | refresh 전용 인스턴스 커스터마이징(도메인/타임아웃/인터셉터 분리) |
| `injectTokenOnRequest` | `boolean`                                          | `true`            | 요청 전 토큰 자동 주입 여부(끄면 수동으로 헤더 넣기)              |

#### TokenAxiosReturn

```ts
type TokenAxiosReturn = {
  client: AxiosInstance; // API 호출용
  refreshAxios: AxiosInstance; // refresh 전용(메인 인터셉터와 분리)
  setAccessToken: (t: string | null) => void;
  getAccessToken: () => string | null | undefined;
};
```

---

## 동작 방식

1. **요청 전 토큰 주입**  
   `injectTokenOnRequest: true`면 `headerName` + `headerScheme`에 맞춰 토큰을 자동으로 넣습니다.

2. **401(기본)에서 갱신 로직 발동**
   - 이미 재시도된 요청(`_retry`)이면 실패로 종료.
   - **refresh 진행 중이면** 그 Promise를 **공유**(동시성 1회).
   - **요청 당시 토큰 ≠ 현재 저장 토큰**이면, **현재 토큰으로 재시도**(지각된 만료 처리).
   - 실제 **refresh 1회 수행**, 성공 시 토큰 저장 후 원요청 **재시도**.
   - refresh 실패 시 `onRefreshFailure` 호출(있다면) 후 토큰을 `null`로 정리하고 모든 대기 요청을 거절.

---

## 고급 사용법

### 1) shouldRefresh 커스터마이즈 (예: 419도 갱신)

```ts
createTokenAxios({
  // ...
  shouldRefresh: (err) => {
    const s = err.response?.status;
    return s === 401 || s === 419;
  }
});
```

### 2) 헤더명/스킴 변경 (예: `X-Auth-Token` / prefix 없음)

```ts
createTokenAxios({
  // ...
  headerName: "X-Auth-Token",
  headerScheme: ""
});
```

### 3) refresh 전용 인스턴스 분리

```ts
createTokenAxios({
  // ...
  createRefreshAxios: () => {
    const r = axios.create({
      baseURL: "https://auth.example.com",
      withCredentials: true,
      timeout: 5000
    });
    // 필요하면 여기서만 쓰는 인터셉터 추가
    return r;
  }
});
```

### 4) 자동 주입 끄고 수동 제어

```ts
const { client: api } = createTokenAxios({
  // ...
  injectTokenOnRequest: false
});

await api.get("/public"); // 토큰 없음
await api.get("/secure", {
  headers: { Authorization: `Bearer ${getAccessToken()}` }
});
```

---

## 테스트 가이드 (MSW + Vitest 권장)

- **핵심 시나리오**
  - 단일 401 → refresh 1회 → 재시도 200
  - **동시 401** 여러 개 → refresh **1회만** 발생
  - **지각된 만료**: 401 발생 후 뒤늦게 도착한 요청은 **추가 refresh 없이** 현재 토큰으로 재시도 성공
  - **refresh 실패**: 대기 중인 모든 요청 **reject**, `onRefreshFailure` **호출** 및 토큰 정리
  - 커스텀 `shouldRefresh`/`headerName`/`headerScheme` 동작 확인

> 팁: 테스트마다 옵션이 다른 인스턴스가 필요하면 `createTestApi(overrides)` 팩토리를 만들어 테스트별로 새 인스턴스를 생성하세요. (동일 인스턴스를 공유하면 설정이 섞여 false positive/negative가 생길 수 있습니다.)

---

## FAQ

**Q. 왜 `peerDependencies`로 axios를 두나요?**  
A. 호스트 앱과 **같은 axios 인스턴스**를 쓰기 위해서입니다(인터셉터/싱글턴 문제 방지). 앱이 직접 `axios`를 설치해야 하며, 버전 미스매치 시 설치 단계에서 경고로 빨리 감지할 수 있습니다.

**Q. refresh 요청도 인터셉터를 타나요?**  
A. 기본적으로 **메인 인터셉터와 분리된 인스턴스**(`refreshAxios`)를 사용합니다. 필요하면 `createRefreshAxios`로 완전히 커스터마이징하세요.

---

## 타입 호환

- TypeScript 5.x+
- Axios 1.6+ (peer)

---

## 라이선스

MIT
